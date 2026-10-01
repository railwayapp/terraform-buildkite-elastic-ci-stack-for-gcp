mock_provider "google" {}

run "unchanged_by_default" {
  command = plan

  variables {
    project_id                  = "test-project"
    network_self_link           = "projects/test-project/global/networks/test-network"
    subnet_self_link            = "projects/test-project/regions/us-central1/subnetworks/test-subnet"
    agent_service_account_email = "agent@test-project.iam.gserviceaccount.com"
    image                       = "projects/test-project/global/images/test-image"
    buildkite_organization_slug = "test-organization"
    buildkite_agent_token       = "test-token"
    enable_autoscaling          = false
    enable_autohealing          = false
  }

  assert {
    condition     = length(google_compute_region_instance_group_manager.buildkite_agents.instance_flexibility_policy) == 0
    error_message = "A fallback must not be added to existing MIGs unless explicitly configured."
  }
}

run "prefers_primary_then_fallback" {
  command = plan

  variables {
    project_id                  = "test-project"
    network_self_link           = "projects/test-project/global/networks/test-network"
    subnet_self_link            = "projects/test-project/regions/us-central1/subnetworks/test-subnet"
    agent_service_account_email = "agent@test-project.iam.gserviceaccount.com"
    image                       = "projects/test-project/global/images/test-image"
    buildkite_organization_slug = "test-organization"
    buildkite_agent_token       = "test-token"
    enable_autoscaling          = false
    enable_autohealing          = false
    machine_type                = "n4d-highmem-8"
    fallback_machine_type       = "n4-highmem-8"
  }

  assert {
    condition     = length(google_compute_region_instance_group_manager.buildkite_agents.instance_flexibility_policy[0].instance_selections) == 2
    error_message = "The MIG must have both primary and fallback machine type selections."
  }

  assert {
    condition     = one([for selection in google_compute_region_instance_group_manager.buildkite_agents.instance_flexibility_policy[0].instance_selections : selection if selection.name == "preferred"]).machine_types == toset(["n4d-highmem-8"])
    error_message = "The preferred selection must use the primary machine type."
  }

  assert {
    condition     = one([for selection in google_compute_region_instance_group_manager.buildkite_agents.instance_flexibility_policy[0].instance_selections : selection if selection.name == "preferred"]).rank == 1
    error_message = "The primary machine type must have the highest preference."
  }

  assert {
    condition     = one([for selection in google_compute_region_instance_group_manager.buildkite_agents.instance_flexibility_policy[0].instance_selections : selection if selection.name == "fallback"]).machine_types == toset(["n4-highmem-8"])
    error_message = "The alternate selection must use the configured fallback machine type."
  }

  assert {
    condition     = one([for selection in google_compute_region_instance_group_manager.buildkite_agents.instance_flexibility_policy[0].instance_selections : selection if selection.name == "fallback"]).rank == 2
    error_message = "The alternate machine type must be less preferred than the primary."
  }
}
