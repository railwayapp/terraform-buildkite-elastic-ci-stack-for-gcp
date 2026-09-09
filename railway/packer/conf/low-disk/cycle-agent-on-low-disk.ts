// Stops the Buildkite agent when the root disk is nearly full. Upstream's
// lifecycle drop-in (ExecStopPost=terminate-instance-after-agent-exit) then
// removes this VM from its managed instance group, the same path idle
// scale-in takes, so nothing here needs to know about the MIG.

const DISK_PATH = "/";

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

async function main() {
  const minimumAvailableKb = positiveIntegerFromEnvironment(
    "DISK_MIN_AVAILABLE_KB",
    10 * 1024 * 1024,
  );
  const minimumAvailableInodes = positiveIntegerFromEnvironment(
    "DISK_MIN_INODES",
    250_000,
  );
  const stats = await diskStats();

  if (
    stats.availableKb >= minimumAvailableKb &&
    stats.availableInodes >= minimumAvailableInodes
  ) {
    return;
  }

  const availableGiB = (stats.availableKb / 1024 / 1024).toFixed(1);
  console.error(
    `Disk has ${availableGiB} GiB and ${stats.availableInodes} inodes available; cycling agent`,
  );

  await stopAgent();
}

if (import.meta.main) {
  await main();
}
