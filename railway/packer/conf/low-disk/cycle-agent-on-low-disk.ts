// Stops the Buildkite agent when the root disk is nearly full. Upstream's
// lifecycle drop-in (ExecStopPost=terminate-instance-after-agent-exit) then
// removes this VM from its managed instance group, the same path idle
// scale-in takes, so nothing here needs to know about the MIG.

const DISK_PATH = "/";
const QUEUE_METADATA_URL =
  "http://169.254.169.254/computeMetadata/v1/instance/attributes/buildkite-queue";
const AGENT_CONFIG_PATH = "/etc/buildkite-agent/buildkite-agent.cfg";

export function queueFromAgentConfig(config: string) {
  const tags = /^tags="([^"\r\n]*)"$/m.exec(config)?.[1];
  const queue = tags?.split(",").find((tag) => tag.startsWith("queue="))?.slice(
    6,
  );
  return queue || undefined;
}

export function minimumAvailableKbForQueue(
  queue: string | undefined,
  baselineKb: number,
  buildQueueKb: number,
) {
  return queue === "build" ? Math.max(baselineKb, buildQueueKb) : baselineKb;
}

export function shouldCycleAgent(
  stats: { availableKb: number; availableInodes: number },
  minimumAvailableKb: number,
  minimumAvailableInodes: number,
) {
  return stats.availableKb < minimumAvailableKb ||
    stats.availableInodes < minimumAvailableInodes;
}

async function queueFromMetadata() {
  const response = await fetch(QUEUE_METADATA_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(1000),
  });
  return response.ok ? (await response.text()).trim() || undefined : undefined;
}

export async function resolveBuildkiteQueue(
  getMetadataQueue: () => Promise<string | undefined> = queueFromMetadata,
  readAgentConfig: () => Promise<string> = () =>
    Deno.readTextFile(AGENT_CONFIG_PATH),
) {
  try {
    const queue = await getMetadataQueue();
    if (queue) return queue;
  } catch {
    // The generated agent config is a local fallback if GCE metadata is down.
  }
  try {
    const queue = queueFromAgentConfig(await readAgentConfig());
    if (queue) return queue;
  } catch {
    // Before bootstrap there may be no config; the agent cannot accept work yet.
  }
  console.error(
    "Unable to resolve Buildkite queue; using baseline disk threshold",
  );
  return undefined;
}

export function parseDiskStats(output: string) {
  const values = output.trim().split("\n").at(-1)?.trim().split(/\s+/);

  if (!values || values.length !== 2) {
    throw new Error(`Unexpected df output: ${output}`);
  }

  const [availableKb, availableInodes] = values.map(Number);
  if (!Number.isFinite(availableKb) || !Number.isFinite(availableInodes)) {
    throw new Error(`Unexpected df values: ${values.join(" ")}`);
  }

  return { availableKb, availableInodes };
}

export function positiveIntegerFromEnvironment(name: string, fallback: number) {
  const value = Number(Deno.env.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function diskStats() {
  const command = new Deno.Command("/usr/bin/df", {
    args: ["-k", "--output=avail,iavail", DISK_PATH],
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();

  if (!result.success) {
    throw new Error(
      `df failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }

  return parseDiskStats(new TextDecoder().decode(result.stdout));
}

async function stopAgent() {
  console.log(
    "Stopping the Buildkite agent; its ExecStopPost hook removes this VM from the instance group",
  );
  const command = new Deno.Command("/usr/bin/systemctl", {
    args: ["stop", "buildkite-agent"],
    clearEnv: true,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;

  if (!status.success) {
    throw new Error(`systemctl stop buildkite-agent exited ${status.code}`);
  }
}

export async function cycleAgentIfLowDisk(
  stats: { availableKb: number; availableInodes: number },
  baselineKb: number,
  buildQueueKb: number,
  minimumAvailableInodes: number,
  getQueue: () => Promise<string | undefined>,
  stop: () => Promise<void>,
) {
  // Only resolve the queue once we approach the largest threshold. An absent
  // metadata server must not turn healthy non-build VMs into frequent loggers.
  if (
    !shouldCycleAgent(
      stats,
      Math.max(baselineKb, buildQueueKb),
      minimumAvailableInodes,
    )
  ) {
    return;
  }
  const queue = await getQueue();
  const minimumAvailableKb = minimumAvailableKbForQueue(
    queue,
    baselineKb,
    buildQueueKb,
  );
  if (!shouldCycleAgent(stats, minimumAvailableKb, minimumAvailableInodes)) {
    return;
  }

  const availableGiB = (stats.availableKb / 1024 / 1024).toFixed(1);
  console.error(
    `Disk has ${availableGiB} GiB and ${stats.availableInodes} inodes available; cycling ${
      queue ?? "unknown"
    } agent`,
  );

  await stop();
}

async function main() {
  const baselineKb = positiveIntegerFromEnvironment(
    "DISK_MIN_AVAILABLE_KB",
    10 * 1024 * 1024,
  );
  const buildQueueKb = positiveIntegerFromEnvironment(
    "BUILD_QUEUE_DISK_MIN_AVAILABLE_KB",
    64 * 1024 * 1024,
  );
  const minimumAvailableInodes = positiveIntegerFromEnvironment(
    "DISK_MIN_INODES",
    250_000,
  );
  await cycleAgentIfLowDisk(
    await diskStats(),
    baselineKb,
    buildQueueKb,
    minimumAvailableInodes,
    resolveBuildkiteQueue,
    stopAgent,
  );
}

if (import.meta.main) {
  await main();
}
