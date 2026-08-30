const METADATA_URL = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_HEADERS = { "Metadata-Flavor": "Google" };
const DISK_PATH = "/";

export type InstanceGroupManager = {
  scope: "regions" | "zones";
  location: string;
  name: string;
};

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

export function parseInstanceGroupManager(
  createdBy: string,
): InstanceGroupManager {
  const segments = createdBy.split("?")[0].split("/").filter(Boolean);
  const managerIndex = segments.lastIndexOf("instanceGroupManagers");
  const scope = segments[managerIndex - 2];
  const location = segments[managerIndex - 1];
  const name = segments[managerIndex + 1];

  if (
    managerIndex < 2 ||
    (scope !== "regions" && scope !== "zones") ||
    !location ||
    !name
  ) {
    throw new Error(`Unable to parse managed instance group from ${createdBy}`);
  }

  return { scope, location, name };
}

function positiveIntegerFromEnvironment(name: string, fallback: number) {
  const value = Number(Deno.env.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function metadata(path: string) {
  const response = await fetch(`${METADATA_URL}/${path}`, {
    headers: METADATA_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`Metadata request for ${path} failed: ${response.status}`);
  }

  return (await response.text()).trim();
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
  console.log("Stopping the Buildkite agent gracefully");
  const command = new Deno.Command("/usr/bin/systemctl", {
    args: ["stop", "buildkite-agent"],
    clearEnv: true,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;

  if (!status.success) {
    console.error(
      `Buildkite agent did not stop cleanly (exit ${status.code}); recreating anyway`,
    );
  }
}

async function recreateInstance(
  manager: InstanceGroupManager,
  project: string,
  instance: string,
) {
  const scopeFlag = manager.scope === "regions" ? "region" : "zone";
  const command = new Deno.Command("/usr/bin/gcloud", {
    args: [
      "compute",
      "instance-groups",
      "managed",
      "recreate-instances",
      manager.name,
      `--instances=${instance}`,
      `--${scopeFlag}=${manager.location}`,
      `--project=${project}`,
      "--quiet",
    ],
    clearEnv: true,
    env: {
      CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
      HOME: "/root",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;

  if (!status.success) {
    throw new Error(`gcloud recreate failed with exit code ${status.code}`);
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

  const [project, instance, createdBy] = await Promise.all([
    metadata("project/project-id"),
    metadata("instance/name"),
    metadata("instance/attributes/created-by"),
  ]);
  const manager = parseInstanceGroupManager(createdBy);

  await stopAgent();

  console.log(
    `Requesting recreation of ${instance} in ${manager.name} (${manager.location})`,
  );
  await recreateInstance(manager, project, instance);
}

if (import.meta.main) {
  await main();
}
