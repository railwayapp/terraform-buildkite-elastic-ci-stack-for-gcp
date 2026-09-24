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
| Disk-pressure agent cycling: below 10 GiB or 250k inodes free on `/`, stop the agent | `railway-low-disk-cycle.timer`, every minute |
| Discard a checkout a cancelled job left root-owned files in, so the slot is not wedged | `/etc/buildkite-agent/hooks/pre-checkout` |
| `fs.aio-max-nr = 1048576`, so concurrent Scylla/redpanda test stacks on one agent stop exhausting the kernel's 65536 AIO pool | `/etc/sysctl.d/60-railway-aio.conf` |

The sccache client is the checksum-pinned Railway release used by mono's Rust
steps. The daemon allows 128 MiB IPC frames: the default 8 MiB rejects larger
Rust cache archives, causing recompilation and potentially losing their error
statistics when the connection breaks. This is a finite transport limit, not
the disk-cache size (20 GiB). Entries above the limit remain uncached; changing
the limit does not repair lost statistics. Capability-check probes are skipped
to avoid contention on GCS's shared check object.

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
The build VM runs as `bk-deploy-prod-uw1@railway-infra` (override with `-s`),
which reads the `private_ssh_key` secret to clone the mono mirror into the image;
the caller needs `iam.serviceAccounts.actAs` on it (project editors have it).

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

The image carries a bare mirror of `railwayapp/mono` at
`/var/lib/buildkite-agent/git-mirrors/`, cloned at build time. The agent's
checkout fetches whatever a job's commit needs on top of it, so an older image
still checks out in seconds; rebuild the image when the fetch gets slow, not on
a schedule. Without it a fresh VM spent about three minutes cloning before the
agent could start.

Checks that run without touching GCP:

```
railway/scripts/check
```

## How disk-pressure cycling works now

The old fork's cycler stopped the agent and then called `recreate-instances` on
the MIG itself. It no longer has to. Upstream's lifecycle drop-in puts
`ExecStopPost=terminate-instance-after-agent-exit` on `buildkite-agent.service`,
so stopping the agent for any reason removes the VM through the same
flock-protected path idle scale-in uses. The cycler is therefore just
"if `/` is low, `systemctl stop buildkite-agent`". It depends on that drop-in,
which the module installs when autoscaling is enabled.

A `TimeoutStopSec=10min` drop-in bounds the stop, because the packaged unit ships
`TimeoutStopSec=0` and systemd reads that as infinity. Upstream's own
`docker-low-disk-gc.timer` is disabled in favour of cycling; the regular
`docker-gc` timer stays.

## Deliberately absent

- `git-clone-mirror-flags`. The old fork made it configurable and mono set it to
  `-v`, which is the agent's default.
