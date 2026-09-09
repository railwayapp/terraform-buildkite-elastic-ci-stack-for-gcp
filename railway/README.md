# Railway image layer

Everything Railway-specific that lives in the VM image, kept out of upstream's
tree so it never conflicts on `git rebase upstream/main`. Upstream has no
`railway/` directory and never will.

The image is a thin layer on Buildkite's published agent image, not a rebuild
of it. Packer starts from the newest image in family `buildkite-ci-stack-x86-64`
in project `buildkite-gcp-stack` (readable from `railway-infra`; image names end
in the upstream commit they were built from) and adds:

| Piece | Delivered as |
| --- | --- |
| sccache daemon, shared Rust compile cache backed by `gs://railway-rust-sccache` | `sccache.service`, enabled in the image |
| Deno, used by `.buildkite/lib/*.ts` pipeline generation | `/usr/local/bin/deno` |
| mono git-mirror pre-warm, Docker Hub auth, Artifact Registry credential helper | `railway-agent-prep.service`, a oneshot the agent unit waits for at boot |
| GitHub host-key policy for the mirror clone | `/etc/ssh/ssh_config` |

Terraform-side changes (`buildkite_spawn`, health check type, hyperdisk, and so
on) are separate commits on top of upstream, not here.

## Why a boot-time oneshot instead of the bootstrap

Upstream's module writes the bootstrap script, the agent config template and the
agent env template from Terraform on every boot, so anything we add to those is
overwritten. A drop-in at `/etc/systemd/system/buildkite-agent.service.d/railway.conf`
survives that: it makes `buildkite-agent.service` want and order after
`railway-agent-prep.service`, so when the bootstrap runs
`systemctl start buildkite-agent` the prep runs first. `Wants=` rather than
`Requires=` so a prep failure logs and lets the agent start anyway.

## Building

Requires packer, gcloud application-default credentials with access to
`railway-infra`, and read access to `buildkite-gcp-stack` (already granted).

```
cd railway/packer
./build                                   # newest upstream image, publishes to family buildkite-ci-stack
./build --source-image buildkite-ci-stack-x86-64-2026-09-08-0703-62-2781c81   # pin an upstream image
```

The result is named `buildkite-ci-stack-x86-64-<date>-<build_number>` and added
to family `buildkite-ci-stack` in `railway-infra`, which is what mono's
`image = ".../family/buildkite-ci-stack"` resolves. The upstream image it was
built from is recorded in `/etc/railway-agent-image` on the VM and in the
`upstream_image` image label.

Checks that run without touching GCP:

```
railway/scripts/check
```

## Deliberately absent

- The low-disk agent cycler from the old fork. Upstream's job-safe scale-in now
  removes VMs through `terminate-instance`; whether we still need a
  disk-pressure trigger, and whether it should be rebuilt on that primitive, is
  an open decision.
- `git-clone-mirror-flags`. The old fork made it configurable and mono set it to
  `-v`, which is the agent's default.
