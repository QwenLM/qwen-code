package com.alibaba.qwen.code.runtimebroker.managedschema;

/** Explicit columns for Managed SQL readers; independent of live database metadata. */
public enum ManagedSchemaProjection {
    SIDE_QUERY(
            "query_id, tenant_id, session_id, actor_id, actor_scope_ref, "
                    + "kind, trigger_kind, question, state, active_slot, source_json, private_history_json, "
                    + "model_config_digest, processing_version, input_resource_id, input_digest, is_input_ready, "
                    + "claim_instance_id, claim_boot_id, claim_generation, claim_token_hash, read_lease_id, "
                    + "read_deadline_at, deadline_at, result_revision, answer_text, outcome, usage_json, error_code, "
                    + "gmt_create, gmt_modified"),
    ARTIFACT(
            "artifact_id, result_id, scope_ref, descriptor_json, publication_id, binding_json, "
                    + "manifest_ref_json, stream_id, creation_sequence"),
    CHANNEL_BINDING(
            "tenant_id, channel_id, route_id, session_id, scope_kind, sender_id, chat_id, "
                    + "thread_id, gmt_create"),
    CHANNEL_INSTANCE(
            "tenant_id, channel_id, platform, account_id, account_generation, state, actor_id, "
                    + "workspace_id, cwd_relative, policy_json, gmt_create, gmt_modified"),
    PR_WATCH_BINDING(
            "tenant_id, channel_id, binding_id, owner, repo, pr_number, session_id, "
                    + "events_json, gmt_create"),
    DELIVERY(
            "delivery_kind, tenant_id, channel_id, delivery_id, source_session_id, "
                    + "target_session_id, source_scope_id, source_revision, "
                    + "segment_id, segment_ordinal, segment_count, creation_key, provider_id, provider_receipt_json, "
                    + "request_digest, payload_version, payload_json, transport_state, reception_state, "
                    + "consumption_state, claimed_at, reconcile_operation_id, claim_owner, "
                    + "claim_generation, claim_until, attempt_count, available_at, last_error, "
                    + "failure_code, gmt_create, gmt_modified"),
    EVENT_STREAM(
            "tenant_id, session_id, stream_kind, stream_id, last_sequence, "
                    + "replay_floor_sequence, covered_sequence, wake_covered_sequence, projection_version, "
                    + "artifact_refs_resource_ref, "
                    + "output_ranges_json, is_projection_pending, gmt_modified"),
    JOURNAL_PACK(
            "pack_id, tenant_id, workspace_id, session_id, from_revision, "
                    + "through_revision, manifest_resource_ref, object_key, state, is_put_closed, "
                    + "active_from_revision, byte_length, sha256, builder_id, gmt_create, gmt_modified"),
    MESSAGE(
            "tenant_id, session_id, item_id, turn_id, item_type, item_role, item_status, "
                    + "attributes_json, first_sequence, last_sequence, gmt_create, gmt_modified, revision, "
                    + "parts_json, body_resource_ref, execution_call_id, tool_call_id, policy_version"),
    OPERATION(
            "operation_ref, scope_kind, scope_id, operation_id, operation_kind, "
                    + "tenant_id, session_id, workspace_id, target_kind, target_revision, "
                    + "target_id, storage_id, physical_id, actor_id, idempotency_key, "
                    + "idempotency_digest, request_digest, actor_digest, lifecycle_protocol_version, "
                    + "lifecycle_effects_receipt_json, action_id, task_id, decision_receipt_id, "
                    + "target_cwd_relative, expected_context_revision, result_context_revision, "
                    + "payload_version, request_json, result_json, state, phase, admission_stage, "
                    + "delivery_state, session_status_before, receipt_id, claim_owner, claim_generation, "
                    + "claim_until, available_at, attempt_count, budget_exempt_attempt, deadline, "
                    + "recovery_deadline, verification_request_json, is_verification_ready, "
                    + "verification_next_at, publication_id, publication_command_id, slot_key, "
                    + "execution_call_id, item_id, policy_version, failure_status, failure_code, gmt_create, "
                    + "gmt_modified, completed_at"),
    OPERATION_WORK(
            "operation_ref, work_kind, target_id, tenant_id, session_id, "
                    + "storage_id, physical_id, state, revision, payload_version, payload_json, "
                    + "evidence_resource_ref, evidence_sha256, gmt_create, gmt_modified"),
    OUTPUT_CAPTURE(
            "scope_ref, tenant_id, workspace_id, session_id, publication_id, "
                    + "execution_call_id, capture_id, binding_json, binding_digest, token_hash, state, "
                    + "expires_at, capture_bytes, producer_bytes, admission_bytes, producer_phase, "
                    + "is_quarantined, active_operation_id, finish_operation_id, finish_predecessor_id, "
                    + "finish_digest, terminal_resource_id, admission_resource_id, receipt_sequence, "
                    + "receipt_revision, capture_held_bytes, producer_held_bytes, admission_held_bytes, "
                    + "capture_used_bytes, producer_used_bytes, admission_used_bytes, retention_state, "
                    + "is_write_evidence, is_accepted_complete, collected_at, collected_bytes, "
                    + "released_held_bytes, manifest_resource_ref, manifest_sha256, "
                    + "seal_manifest_resource_ref, seal_manifest_sha256, gmt_create, gmt_modified"),
    PUBLIC_EVENT(
            "tenant_id, session_id, sequence_id, event_id, turn_id, event_type, data_json, "
                    + "is_terminal, source_key, gmt_create, schema_version, projection_version, item_id, "
                    + "content_part_id, stream_kind, stream_id, state, runtime_state, text, is_truncated, "
                    + "artifact_id, capture_id, output_stream_id, first_ordinal, end_ordinal, is_archived"),
    REQUEST_RECEIPT(
            "receipt_key, namespace, tenant_id, scope_kind, scope_ref, scope_id, "
                    + "idempotency_key, idempotency_digest, request_digest, actor_id, operation, state, "
                    + "is_workspace_bound, session_id, turn_id, agent_id, agent_revision, schedule_id, "
                    + "channel_id, account_generation, semantic_revision, action_id, action_version, "
                    + "decision_scope, mutation_attempt_sequence, session_status_before, "
                    + "result_operation_ref, result_json, gmt_create, gmt_modified"),
    RESOURCE(
            "tenant_id, workspace_id, session_id, resource_id, "
                    + "kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, object_key, "
                    + "object_version_id, encryption_key_id, publish_command_id, state, "
                    + "scope_ref, publication_id, slot_key, capture_state, capture_object_key, "
                    + "operation_id, quarantine_reason, deletion_operation_ref, gmt_create, "
                    + "last_verified_at, retention_until"),
    RESOURCE_REF(
            "owner_kind, owner_ref, owner_revision, tenant_id, "
                    + "workspace_id, session_id, journal_revision, resource_id, gmt_create, runtime_binding_id"),
    RUNTIME_BINDING(
            "binding_id, request_id, scope_id, tenant_id, workspace_id, workspace_generation, "
                    + "canonical_cwd, capability_digest, isolation_class, isolation_key, provisioner_kind, "
                    + "storage_id, runtime_generation, binding_state, "
                    + "provision_request_id, provision_seed_ciphertext, is_provision_seeded, "
                    + "credential_key_id, resource_handle_version, is_recovery_candidate, "
                    + "resource_handle_json, loss_evidence_json, stop_evidence_json, "
                    + "runtime_instance_id, runtime_endpoint, "
                    + "runtime_lease_id, runtime_epoch, runtime_credential_ciphertext, "
                    + "runtime_credential_key_id, attestation_generation, is_drain_requested, "
                    + "operation_owner, operation_lease_until, operation_generation, record_version, "
                    + "last_health_at, last_reconciled_at, last_active_at, drain_receipt_json, "
                    + "first_activation_journal_revision"),
    RUNTIME_SESSION(
            "scope_id, runtime_session_id, tenant_id, workspace_id, workspace_generation, "
                    + "canonical_cwd, capability_digest, isolation_class, harness_session_id, turn_kind, "
                    + "binding_id, runtime_generation, session_state, record_version, last_active_at, "
                    + "execution_storage_id, is_rewind_pending"),
    RUNTIME_SLOT(
            "request_id, tenant_id, workspace_id, workspace_generation, canonical_cwd, "
                    + "capability_digest, isolation_class, isolation_key, provisioner_kind, storage_id, "
                    + "last_generation, active_binding_id"),
    SCHEDULE(
            "tenant_id, schedule_id, session_id, workspace_id, actor_id, record_revision, "
                    + "definition_revision, definition_digest, goal, cron, timezone, session_mode, "
                    + "overlap, catch_up, catch_up_limit, is_enabled, state, blocked_reason, armed_at, "
                    + "watermark_slot, lease_owner, lease_until, fence, gmt_create, gmt_modified, "
                    + "gate, gate_last_outcome, gate_last_at, gate_quiet_since_delivery, "
                    + "gate_failures, gate_last_error"),
    SCHEDULE_OCCURRENCE(
            "tenant_id, schedule_id, occurrence_key, run_id, session_id, slot, trigger_kind, "
                    + "outcome, is_run_terminal, reason, definition_revision, fence, attempts, "
                    + "next_retry_at, last_error, gmt_create, gmt_modified"),
    SESSION(
            "tenant_id, session_id, agent_id, title, status, harness_boot_id, "
                    + "harness_event_epoch, harness_last_event_id, gmt_create, gmt_modified, version, "
                    + "public_session_id, deleted_at, workspace_id, workspace_generation, "
                    + "workspace_storage_id, cwd_relative, context_config_ref, context_revision, "
                    + "workspace_config_ref, workspace_policy_ref, agent_revision, approval_mode, "
                    + "tool_profile, creator_actor_key, owner_actor_key, memory_store_id, owner_only, parent_session_id, "
                    + "root_session_id, parent_child_run_id, child_depth, agent_definition_digest, "
                    + "session_kind, title_revision, "
                    + "preview, preview_revision, "
                    + "retirement_operation_id, retirement_generation, retired_at, is_recovery_protected, "
                    + "is_resource_gc_completed, is_publication_retention_registered, model_id, model_revision, "
                    + "model_config_digest, model_config_key_id, model_config_ciphertext, "
                    + "selected_approval_mode, approval_revision, is_plan_enabled, permission_rules_json, public_child_agents_version, harness_instance_id, "
                    + "harness_owner_boot_id, harness_placement_epoch, harness_placement_state"),
    SESSION_HEAD(
            "tenant_id, workspace_id, session_id, has_activity_diagnostics, state, writer_generation, "
                    + "writer_id, writer_lease_until, lease_token_hash, journal_revision, "
                    + "committed_sequence, last_commit_digest, activation_epoch, "
                    + "latest_checkpoint_resource_id, compacted_through_revision, packed_through_revision, recovery_status, "
                    + "recovery_detail_code, gmt_create, gmt_modified, activation_id, "
                    + "activation_phase, activation_event_epoch, activation_expires_at, "
                    + "activation_head_revision, harness_session_id, head_kind, "
                    + "phase, operation_id, claim_generation, claim_lease_until, is_wake_pending, "
                    + "wake_head_revision, wake_retry_at, wake_seal_revision, is_wake_scan_pending, cleanup_head_revision"),
    SESSION_JOURNAL_TX(
            "tenant_id, workspace_id, session_id, journal_revision, command_ref, "
                    + "transaction_id, operation, command_id, content_digest, first_sequence, "
                    + "last_sequence, event_count, events_digest, previous_commit_digest, commit_digest, "
                    + "writer_generation, writer_id, writer_token_hash, activation_epoch, "
                    + "latest_checkpoint_resource_id, record_encoding, record_bytes, byte_length, "
                    + "record_digest, activation_lease_until, activation_renewal_seq, is_activation_record, gmt_create"),
    SESSION_RECORD(
            "tenant_id, workspace_id, session_id, domain, "
                    + "record_id, operation_id, revision, record_resource_id, task_kind, task_state, "
                    + "runtime_state, definition_revision, delivery_target, delivery_state, gmt_create, "
                    + "started_at, settled_at, first_sequence, hook_once_key, hook_occurrence_id, "
                    + "hook_ordinal, hook_definition_id, hook_definition_revision, record_kind, state, action_id, action_version, "
                    + "decision_receipt_id, decision_digest, prompt_id, turn_id, options_json"),
    STORAGE(
            "tenant_id, storage_id, physical_id, "
                    + "registration_state, storage_kind, registration_revision, registration_json, "
                    + "fence_operation_id, mount_revision, gmt_create, gmt_modified"),
    STORAGE_OWNER(
            "physical_id, holder_id, binding_id, runtime_generation, runtime_session_id, "
                    + "tenant_id, storage_id, mount_revision, mount_state, mount_operation_id, "
                    + "mount_completed_operation_id, mount_root, mount_host_id, mount_device, mount_inode, "
                    + "mount_birth_time, mount_registration_id, storage_kind, "
                    + "maintenance_id, maintenance_generation, "
                    + "member_count"),
    TENANT_GUARD(
            "tenant_id, guard_domain"),
    TOOL_EXECUTION(
            "execution_call_id, idempotency_key, "
                    + "binding_id, runtime_generation, harness_session_id, runtime_session_id, "
                    + "turn_id, tool_call_id, request_digest, reference_json, "
                    + "execution_state, execution_status, result_json, last_sequence, is_cancel_requested, "
                    + "dispatch_owner, dispatch_lease_until, dispatch_generation, record_version, "
                    + "settled_at, abandoned_at, loss_evidence_id, authorized_dispatch_generation, "
                    + "authorized_binding_version"),
    TURN(
            "tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest, status, "
                    + "is_submission_attempted, harness_event_epoch, harness_last_event_id, dispatch_owner, "
                    + "dispatch_lease_until, error_code, error_message, gmt_create, gmt_modified, "
                    + "completed_at, version, retry_count, consecutive_failures, "
                    + "budget_exempt_failures, retry_after, model_id, model_revision, "
                    + "approval_mode, approval_revision, is_plan_enabled, permission_rules_json");

    private final String columns;

    ManagedSchemaProjection(String columns) {
        this.columns = columns;
    }

    public String columns() {
        return columns;
    }

    public String columns(String alias) {
        return alias + "." + columns.replace(", ", ", " + alias + ".");
    }
}
