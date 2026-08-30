import {
  parseDiskStats,
  parseInstanceGroupManager,
} from "./cycle-agent-on-low-disk.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("parses disk availability", () => {
  assertEquals(parseDiskStats("   Avail   IFree\n10485760 250000\n"), {
    availableKb: 10_485_760,
    availableInodes: 250_000,
  });
});

Deno.test("parses a regional managed instance group URL", () => {
  assertEquals(
    parseInstanceGroupManager(
      "https://www.googleapis.com/compute/v1/projects/test/regions/us-west1/instanceGroupManagers/buildkite-mig",
    ),
    {
      scope: "regions",
      location: "us-west1",
      name: "buildkite-mig",
    },
  );
});

Deno.test("parses a zonal managed instance group path", () => {
  assertEquals(
    parseInstanceGroupManager(
      "projects/test/zones/us-west1-a/instanceGroupManagers/buildkite-mig",
    ),
    {
      scope: "zones",
      location: "us-west1-a",
      name: "buildkite-mig",
    },
  );
});
