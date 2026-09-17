# Elastic CI Stack for GCP

> **Railway fork.** Everything Railway-specific lives under [`railway/`](railway/):
> the packer layer that builds our agent image on top of Buildkite's published one,
> plus its own README. The rest of this tree, including `packer/linux/` and
> `templates/`, is upstream's and builds *their* image, so a change there never
> reaches our pools. Put pool changes under `railway/` and send everything else
> upstream.
>
> `main` is upstream `main` plus `railway/` plus five small patches to upstream
> files, which are what an upstream sync has to carry forward:
>
> - `buildkite_spawn`: agents per instance, from `variables.tf` through
>   `modules/compute/{main,variables}.tf` into the `buildkite-spawn` metadata,
>   `templates/scripts/bootstrap-buildkite-agent`, and
>   `templates/config/buildkite-agent.cfg.template` (`name=...-%spawn`, `spawn=`).
> - `health_check_type` / `health_check_request_path`: http autohealing checks
>   (`variables.tf`, `modules/compute/{main,variables}.tf`).
> - `root_disk_type` validation accepts hyperdisk (`modules/compute/variables.tf`).
> - `zones` validation tolerates an unknown value at plan time (`variables.tf`).
> - Metrics function audience uses the function's own URI
>   (`modules/buildkite-agent-metrics/main.tf`).
>
> Sync with `git merge upstream/main` on a branch and merge that PR with a merge
> commit, so upstream stays an ancestor of `main`; `git diff <upstream base> main
> -- . ':!railway'` shows exactly the patch set above and nothing else.

[![Build status](https://badge.buildkite.com/3215529db5b0c43976ce30bd625724ae0f71af146ef8ac0007.svg)](https://buildkite.com/buildkite/elastic-ci-stack-for-gcp?branch=main)

Terraform modules for running autoscaling [Buildkite](https://buildkite.com/) agents on Google Cloud Platform.

## Documentation

Full documentation is available at <https://buildkite.com/docs/agent/v3/gcp/elastic-ci-stack/elastic-ci-stack>.

Repository documentation:

- [Agent scaling and instance updates](docs/instance-updates.md) — describes
  job-safe scale-in, idle-agent removal, and opportunistic template rollout
- [GCP image release pipeline](docs/image-release-pipeline.md)

## Getting Started

The module ships with a set of default values which can be overridden as needed, but should be sufficient for most use cases.

```hcl
module "elastic-ci-stack-for-gcp" {
  source  = "buildkite/elastic-ci-stack-for-gcp/buildkite"
  version = "~> 0.4.0"

  # Required
  project_id                  = "your-gcp-project"
  buildkite_organization_slug = "your-org-slug"
  buildkite_agent_token       = "YOUR_AGENT_TOKEN"
}
```

## Contributing

See [Contributing Guidelines](CONTRIBUTING.md).

## License

MIT
