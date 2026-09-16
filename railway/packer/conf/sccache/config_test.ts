import assert from "node:assert/strict";

const read = (path: string) =>
  Deno.readTextFile(new URL(path, import.meta.url));

Deno.test("daemon accepts qualified large entries without removing cache bounds", async () => {
  const config = new Map(
    (await read("./sccache.env"))
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.equal(config.get("SCCACHE_MAX_FRAME_LENGTH"), "134217728");
  assert.equal(config.get("SCCACHE_CACHE_SIZE"), "20G");
  assert.equal(config.get("SCCACHE_MULTILEVEL_CHAIN"), "disk,gcs");
  assert.equal(config.get("SCCACHE_MULTILEVEL_WRITE_ERROR_POLICY"), "l0");
  assert.equal(config.get("SCCACHE_SKIP_CACHE_CHECK"), "true");
  assert.equal(config.get("SCCACHE_SERVER_UDS"), "/run/sccache/sccache.sock");
});

Deno.test("Packer installs the qualified checksum-pinned Railway client", async () => {
  const template = await read("../../railway-agent-image.pkr.hcl");
  const defaults = (name: string) => {
    const block = template.match(
      new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`),
    );
    assert.ok(block, `missing ${name}`);
    return block[1].match(/default\s*=\s*"([^"]+)"/)?.[1];
  };
  const version = "0.17.0-railway.2";
  assert.equal(defaults("sccache_version"), version);
  assert.equal(
    defaults("sccache_url"),
    `https://storage.googleapis.com/railway-public-packages/sccache/v${version}/sccache-v${version}-x86_64-unknown-linux-musl.tar.gz`,
  );
  assert.equal(
    defaults("sccache_sha256"),
    "a13175b8def94993c3895f4eef48f2bc89081e20cdd046d61919fabf524e24c4",
  );
  for (const name of ["version", "url", "sha256"]) {
    assert.ok(
      template.includes(
        `SCCACHE_${name.toUpperCase()}=\u0024{var.sccache_${name}}`,
      ),
    );
  }
  const installer = await read("../../scripts/install-sccache");
  assert.ok(installer.includes('"$SCCACHE_URL" -o "$archive"'));
  const verify = installer.indexOf("sha256sum --check --status");
  const extract = installer.indexOf("tar -xzf");
  const install = installer.indexOf("sudo install -m 0755");
  assert.ok(verify > 0 && extract > verify && install > extract);
  assert.ok(!installer.includes("systemctl start sccache"));
});
