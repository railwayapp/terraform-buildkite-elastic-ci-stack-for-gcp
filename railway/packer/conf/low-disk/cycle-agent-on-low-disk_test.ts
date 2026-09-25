import {
  cycleAgentIfLowDisk,
  minimumAvailableKbForQueue,
  parseDiskStats,
  positiveIntegerFromEnvironment,
  queueFromAgentConfig,
  resolveBuildkiteQueue,
  shouldCycleAgent,
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

Deno.test("recovers the queue locally if metadata is unavailable", () => {
  assertEquals(
    queueFromAgentConfig(
      'token="secret"\ntags="queue=build,gcp-project=staging"\n',
    ),
    "build",
  );
  assertEquals(
    queueFromAgentConfig('tags="queue=deploy-staging"\n'),
    "deploy-staging",
  );
  assertEquals(queueFromAgentConfig('token="secret"\n'), undefined);
  assertEquals(queueFromAgentConfig('tags="queue="\n'), undefined);
});

Deno.test("uses local agent configuration when metadata fails or is empty", async () => {
  let configReads = 0;
  const readConfig = () => {
    configReads++;
    return Promise.resolve(
      'token="secret"\ntags="queue=build,gcp-project=staging"\n',
    );
  };
  assertEquals(
    await resolveBuildkiteQueue(() => Promise.resolve("build"), readConfig),
    "build",
  );
  assertEquals(configReads, 0);
  assertEquals(
    await resolveBuildkiteQueue(
      () => Promise.reject(new Error("metadata down")),
      readConfig,
    ),
    "build",
  );
  assertEquals(
    await resolveBuildkiteQueue(() => Promise.resolve(undefined), readConfig),
    "build",
  );
  assertEquals(configReads, 2);
  assertEquals(
    await resolveBuildkiteQueue(
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error("config missing")),
    ),
    undefined,
  );
});

Deno.test("only build agents use the larger disk reserve", () => {
  const baseline = 10 * 1024 * 1024;
  const buildReserve = 64 * 1024 * 1024;
  assertEquals(
    minimumAvailableKbForQueue("build", baseline, buildReserve),
    buildReserve,
  );
  assertEquals(
    minimumAvailableKbForQueue("default", baseline, buildReserve),
    baseline,
  );
  assertEquals(
    minimumAvailableKbForQueue("deploy-staging", baseline, buildReserve),
    baseline,
  );
  assertEquals(
    minimumAvailableKbForQueue(undefined, baseline, buildReserve),
    baseline,
  );
  assertEquals(
    minimumAvailableKbForQueue("build", buildReserve, baseline),
    buildReserve,
  );
});

Deno.test("cycles only below the selected disk or inode threshold", () => {
  const baseline = 10 * 1024 * 1024;
  const buildReserve = 64 * 1024 * 1024;
  const inodes = 250_000;
  assertEquals(
    shouldCycleAgent(
      { availableKb: buildReserve, availableInodes: inodes },
      buildReserve,
      inodes,
    ),
    false,
  );
  assertEquals(
    shouldCycleAgent(
      { availableKb: buildReserve - 1, availableInodes: inodes },
      buildReserve,
      inodes,
    ),
    true,
  );
  assertEquals(
    shouldCycleAgent(
      { availableKb: baseline + 1, availableInodes: inodes },
      baseline,
      inodes,
    ),
    false,
  );
  assertEquals(
    shouldCycleAgent(
      { availableKb: baseline - 1, availableInodes: inodes },
      baseline,
      inodes,
    ),
    true,
  );
  assertEquals(
    shouldCycleAgent(
      { availableKb: buildReserve, availableInodes: inodes - 1 },
      baseline,
      inodes,
    ),
    true,
  );
});

Deno.test("drains only pressured build agents and preserves the baseline on other queues", async () => {
  const baseline = 10 * 1024 * 1024;
  const buildReserve = 64 * 1024 * 1024;
  const stats = { availableKb: 32 * 1024 * 1024, availableInodes: 500_000 };
  let queueReads = 0;
  let stops = 0;
  const queue = (value: string | undefined) => () => {
    queueReads++;
    return Promise.resolve(value);
  };
  const stop = () => {
    stops++;
    return Promise.resolve();
  };

  await cycleAgentIfLowDisk(
    { ...stats, availableKb: buildReserve },
    baseline,
    buildReserve,
    250_000,
    queue("build"),
    stop,
  );
  assertEquals(stops, 0);
  await cycleAgentIfLowDisk(
    stats,
    baseline,
    buildReserve,
    250_000,
    queue("default"),
    stop,
  );
  await cycleAgentIfLowDisk(
    stats,
    baseline,
    buildReserve,
    250_000,
    queue(undefined),
    stop,
  );
  assertEquals(stops, 0);
  await cycleAgentIfLowDisk(
    stats,
    baseline,
    buildReserve,
    250_000,
    queue("build"),
    stop,
  );
  assertEquals(stops, 1);
  await cycleAgentIfLowDisk(
    { ...stats, availableKb: buildReserve + 1 },
    baseline,
    buildReserve,
    250_000,
    queue("build"),
    stop,
  );
  assertEquals(queueReads, 3);
  assertEquals(stops, 1);
  await cycleAgentIfLowDisk(
    { ...stats, availableKb: buildReserve, availableInodes: 249_999 },
    baseline,
    buildReserve,
    250_000,
    queue("default"),
    stop,
  );
  assertEquals(stops, 2);
});

Deno.test("surfaces a failed stop so systemd reports failure and the timer can retry", async () => {
  let failed = false;
  try {
    await cycleAgentIfLowDisk(
      { availableKb: 9 * 1024 * 1024, availableInodes: 500_000 },
      10 * 1024 * 1024,
      64 * 1024 * 1024,
      250_000,
      () => Promise.resolve("default"),
      () => Promise.reject(new Error("systemctl stop failed")),
    );
  } catch (error) {
    assertEquals((error as Error).message, "systemctl stop failed");
    failed = true;
  }
  assertEquals(failed, true);
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
