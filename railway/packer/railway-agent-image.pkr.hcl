packer {
  required_plugins {
    googlecompute = {
      source  = "github.com/hashicorp/googlecompute"
      version = "~> 1"
    }
  }
}

variable "project_id" {
  type        = string
  description = "Project the image is built and published in"
  default     = "railway-infra"
}

variable "zone" {
  type    = string
  default = "us-west1-a"
}

variable "machine_type" {
  type    = string
  default = "n2-standard-8"
}

variable "build_number" {
  type    = string
  default = "none"
}

variable "service_account_email" {
  type        = string
  description = "Service account for the build instance. It reads the deploy SSH key secret to clone the mono mirror, so the deploy pool's account is the natural choice."
  default     = "bk-deploy-prod-uw1@railway-infra.iam.gserviceaccount.com"
}

variable "mirror_secret" {
  type        = string
  description = "Secret Manager secret holding the SSH key that can read railwayapp/mono"
  default     = "private_ssh_key"
}

variable "source_image_project" {
  type    = string
  default = "buildkite-gcp-stack"
}

variable "source_image_family" {
  type        = string
  description = "Upstream family to start from. Ignored when source_image is set."
  default     = "buildkite-ci-stack-x86-64"
}

variable "source_image" {
  type        = string
  description = "Exact upstream image to start from, e.g. buildkite-ci-stack-x86-64-2026-09-08-0703-62-2781c81. The suffix is the upstream commit."
  default     = ""
}

variable "image_family" {
  type        = string
  description = "Family the result is added to. mono's terraform points at this family."
  default     = "buildkite-ci-stack"
}

variable "sccache_version" {
  type    = string
  default = "0.17.0"
}

variable "sccache_sha256" {
  type        = string
  description = "SHA-256 of the x86_64 musl sccache release archive"
  default     = "67c4a96dd237c1f518f6b36083f270f9976d516f1e57fce891755ea782e50006"
}

variable "deno_version" {
  type    = string
  default = "2.7.9"
}

source "googlecompute" "railway" {
  project_id              = var.project_id
  source_image_family     = var.source_image == "" ? var.source_image_family : null
  source_image            = var.source_image == "" ? null : var.source_image
  source_image_project_id = [var.source_image_project]

  zone                        = var.zone
  machine_type                = var.machine_type
  instance_name               = "packer-railway-${var.build_number}"
  disk_name                   = "packer-railway-${var.build_number}"
  max_run_duration_in_seconds = 3600
  instance_termination_action = "DELETE"

  labels = {
    component    = "packer-builder"
    build_number = var.build_number
  }

  image_name        = "buildkite-ci-stack-x86-64-${formatdate("YYYY-MM-DD-hhmm", timestamp())}-${var.build_number}"
  image_family      = var.image_family
  image_description = "Railway layer on the Buildkite Elastic CI Stack image"

  ssh_username = "packer"
  disk_size    = 20
  disk_type    = "pd-ssd"

  service_account_email = var.service_account_email != "" ? var.service_account_email : null
  scopes = var.service_account_email != "" ? [
    "https://www.googleapis.com/auth/cloud-platform"
  ] : null

  image_labels = {
    name             = "buildkite-ci-stack-x86-64"
    component        = "buildkite-ci-stack"
    build_number     = var.build_number
    railway_layer    = "true"
    upstream_project = var.source_image_project
  }

  tags = ["buildkite", "ci", "packer-build"]
}

build {
  sources = ["source.googlecompute.railway"]

  provisioner "shell" {
    inline = ["mkdir -p /tmp/railway-conf"]
  }

  provisioner "file" {
    source      = "conf/"
    destination = "/tmp/railway-conf"
  }

  provisioner "shell" {
    environment_vars = [
      "SCCACHE_VERSION=${var.sccache_version}",
      "SCCACHE_SHA256=${var.sccache_sha256}",
    ]
    script = "scripts/install-sccache"
  }

  provisioner "shell" {
    environment_vars = ["DENO_VERSION=${var.deno_version}"]
    script           = "scripts/install-deno"
  }

  provisioner "shell" {
    script = "scripts/install-agent-prep"
  }

  provisioner "shell" {
    environment_vars = [
      "MIRROR_SECRET=${var.mirror_secret}",
      "MIRROR_SECRET_PROJECT=${var.project_id}",
    ]
    script = "scripts/bake-mono-mirror"
  }

  provisioner "shell" {
    script = "scripts/install-low-disk-cycle"
  }

  # Which upstream image this was layered on, for anyone debugging a VM.
  provisioner "shell" {
    inline = [
      "echo '${build.SourceImageName}' | sudo tee /etc/railway-agent-image > /dev/null",
      "sudo chmod 0644 /etc/railway-agent-image",
    ]
  }

  provisioner "shell" {
    script = "scripts/cleanup"
  }

  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
  }
}
