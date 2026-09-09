import {
  parseDiskStats,
  positiveIntegerFromEnvironment,
} from "./cycle-agent-on-low-disk.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertThrows(fn: () => unknown) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("Expected function to throw");
}

Deno.test("parses disk availability", () => {
  assertEquals(parseDiskStats("   Avail   IFree\n10485760 250000\n"), {
    availableKb: 10_485_760,
    availableInodes: 250_000,
  });
});

Deno.test("rejects malformed df output", () => {
  assertThrows(() => parseDiskStats("   Avail\n10485760\n"));
  assertThrows(() => parseDiskStats("   Avail   IFree\nlots many\n"));
});

Deno.test("reads thresholds from the environment with a fallback", () => {
  Deno.env.delete("RAILWAY_TEST_THRESHOLD");
  assertEquals(
    positiveIntegerFromEnvironment("RAILWAY_TEST_THRESHOLD", 42),
    42,
  );
  Deno.env.set("RAILWAY_TEST_THRESHOLD", "7");
  assertEquals(positiveIntegerFromEnvironment("RAILWAY_TEST_THRESHOLD", 42), 7);
  Deno.env.set("RAILWAY_TEST_THRESHOLD", "0");
  assertThrows(() =>
    positiveIntegerFromEnvironment("RAILWAY_TEST_THRESHOLD", 42)
  );
  Deno.env.delete("RAILWAY_TEST_THRESHOLD");
});
