package com.alibaba.qwen.code.runtimebroker.managedschema;

/** Explicit columns for Managed SQL readers; independent of live database metadata. */
public enum ManagedSchemaProjection {
    ARTIFACT(
            "artifact_id, result_id, scope_key, descriptor_json, publication_id, binding_json, "
                    + "manifest_ref_json, stream_id, creation_sequence"),
    CHANNEL_BINDING(
            "tenant_id, channel_id, route_id, session_id, scope_kind, sender_id, chat_id, "
                    + "thread_id, gmt_create"),
    CHANNEL_INSTANCE(
            "tenant_id, channel_id, platform, account_id, account_generation, state, actor_id, "
                    + "workspace_id, cwd_relative, policy_json, gmt_create, gmt_modified"),
    DELIVERY(
            "delivery_key, delivery_kind, tenant_id, channel_id, delivery_id, source_session_id, "
                    + "target_session_id, source_scope_key, source_record_key, source_revision, "
                    + "segment_id, segment_ordinal, creation_key, provider_id, provider_receipt_json, "
                    + "request_digest, payload_version, payload_json, transport_state, reception_state, "
                    + "consumption_state, claimed_at, reconcile_operation_id, claim_owner, "
                    + "claim_generation, claim_until, attempt_count, available_at, last_error, "
                    + "failure_code, gmt_create, gmt_modified"),
    EVENT_STREAM(
            "tenant_id, session_id, stream_kind, stream_id, last_sequence, "
                    + "replay_floor_sequence, covered_sequence, wake_covered_sequence, projection_version, "
                    + "snapshot_stale_since, current_snapshot_id, artifact_refs_resource_key, "
                    + "output_ranges_json, projection_pending, gmt_modified"),
    MESSAGE(
            "tenant_id, session_id, item_id, turn_id, item_type, item_role, item_status, "
                    + "attributes_json, first_sequence, last_sequence, gmt_create, gmt_modified, revision, "
                    + "parts_json, body_resource_key, execution_key, tool_call_key, policy_version"),
    OPERATION(
            "operation_key, scope_key, session_scope_key, operation_id, operation_kind, "
                    + "tenant_id, session_id, workspace_id, target_kind, target_key, target_revision, "
                    + "target_id, storage_key, physical_key, actor_key, actor_id, idempotency_key, "
                    + "idempotency_digest, request_digest, actor_digest, lifecycle_protocol_version, "
                    + "lifecycle_effects_receipt_json, action_id, task_id, decision_receipt_id, "
                    + "target_cwd_relative, expected_context_revision, result_context_revision, "
                    + "payload_version, request_json, result_json, state, phase, admission_stage, "
                    + "delivery_state, session_status_before, receipt_id, claim_owner, claim_generation, "
                    + "claim_until, available_at, attempt_count, budget_exempt_attempt, deadline, "
                    + "recovery_deadline, execution_mode, verification_request_json, verification_ready, "
                    + "verification_next_at, publication_id, publication_command_id, slot_key, "
                    + "execution_key, item_id, policy_version, failure_status, failure_code, gmt_create, "
                    + "gmt_modified, completed_at, progress_format, progress_version, progress_stage, "
                    + "settlement_deadline_ms, frozen_request_bytes, frozen_request_sha256, cut_bytes, "
                    + "cut_sha256, finalize_receipt_bytes, finalize_receipt_sha256, csi_retirement_target_key"),
    OPERATION_WORK(
            "operation_key, work_kind, target_key, target_id, tenant_id, session_id, "
                    + "storage_key, physical_key, state, revision, payload_version, payload_json, "
                    + "evidence_resource_key, evidence_sha256, gmt_create, gmt_modified"),
    OUTPUT_CAPTURE(
            "scope_key, tenant_key, tenant_id, workspace_id, session_id, publication_id, "
                    + "execution_key, capture_id, binding_json, binding_digest, token_hash, state, "
                    + "expires_at, capture_bytes, producer_bytes, admission_bytes, producer_phase, "
                    + "quarantined, active_operation_id, finish_operation_id, finish_predecessor_id, "
                    + "finish_digest, terminal_resource_id, admission_resource_id, receipt_sequence, "
                    + "receipt_revision, capture_held_bytes, producer_held_bytes, admission_held_bytes, "
                    + "capture_used_bytes, producer_used_bytes, admission_used_bytes, retention_state, "
                    + "write_evidence, accepted_complete, collected_at, collected_bytes, "
                    + "released_held_bytes, manifest_resource_key, manifest_sha256, "
                    + "seal_manifest_resource_key, seal_manifest_sha256, gmt_create, gmt_modified"),
    PUBLIC_EVENT(
            "tenant_id, session_id, sequence_id, event_id, turn_id, event_type, data_json, "
                    + "terminal, source_key, gmt_create, schema_version, projection_version, item_id, "
                    + "content_part_id, stream_kind, stream_id, state, runtime_state, text, truncated, "
                    + "artifact_id, capture_id, output_stream_id, first_ordinal, end_ordinal, archived"),
    REQUEST_RECEIPT(
            "receipt_key, namespace, tenant_key, tenant_id, scope_kind, scope_key, scope_id, "
                    + "idempotency_key, idempotency_digest, request_digest, actor_id, operation, state, "
                    + "workspace_bound, session_id, turn_id, agent_id, agent_revision, schedule_id, "
                    + "channel_id, account_generation, semantic_revision, action_id, action_version, "
                    + "decision_scope_key, mutation_attempt_sequence, session_status_before, "
                    + "result_operation_key, result_json, gmt_create, gmt_modified"),
    RESOURCE(
            "resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, "
                    + "kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, object_key, "
                    + "object_version_id, encryption_key_id, publish_command_id, state, snapshot_id, "
                    + "snapshot_page_ordinal, snapshot_page_first_sequence, snapshot_page_last_sequence, "
                    + "scope_key, publication_id, slot_key, capture_state, capture_object_key, "
                    + "operation_id, quarantine_reason, deletion_operation_key, gmt_create, "
                    + "last_verified_at, retention_until"),
    RESOURCE_REF(
            "session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, "
                    + "workspace_id, session_id, journal_revision, resource_id, gmt_create"),
    RUNTIME_BINDING(
            "binding_id, request_key, scope_key, tenant_id, workspace_id, workspace_generation, "
                    + "canonical_cwd, capability_digest, isolation_class, isolation_key, provisioner_kind, "
                    + "storage_id, storage_alias_key, runtime_generation, binding_state, "
                    + "provision_request_id, provision_seed_ciphertext, provision_seeded, "
                    + "credential_key_id, resource_handle_version, resource_handle_json, "
                    + "loss_evidence_json, stop_evidence_json, runtime_instance_id, runtime_endpoint, "
                    + "runtime_lease_id, runtime_epoch, runtime_credential_ciphertext, "
                    + "runtime_credential_key_id, attestation_generation, drain_requested, "
                    + "operation_owner, operation_lease_until, operation_generation, record_version, "
                    + "last_health_at, last_reconciled_at, last_active_at, drain_receipt_json, "
                    + "first_activation_journal_revision"),
    RUNTIME_SESSION(
            "scope_key, runtime_session_id, tenant_id, workspace_id, workspace_generation, "
                    + "canonical_cwd, capability_digest, isolation_class, harness_session_id, turn_kind, "
                    + "binding_id, runtime_generation, session_state, record_version, last_active_at"),
    RUNTIME_SLOT(
            "request_key, tenant_id, workspace_id, workspace_generation, canonical_cwd, "
                    + "capability_digest, isolation_class, isolation_key, provisioner_kind, storage_id, "
                    + "last_generation, active_binding_id"),
    SCHEDULE(
            "tenant_id, schedule_id, session_id, workspace_id, actor_id, record_revision, "
                    + "definition_revision, definition_digest, goal, cron, timezone, session_mode, "
                    + "overlap, catch_up, catch_up_limit, enabled, state, blocked_reason, armed_at, "
                    + "watermark_slot, lease_owner, lease_until, fence, gmt_create, gmt_modified"),
    SCHEDULE_OCCURRENCE(
            "tenant_id, schedule_id, occurrence_key, run_id, session_id, slot, trigger_kind, "
                    + "outcome, reason, definition_revision, fence, attempts, next_retry_at, last_error, "
                    + "gmt_create, gmt_modified"),
    SESSION(
            "tenant_id, session_id, agent_id, title, status, harness_boot_id, "
                    + "harness_event_epoch, harness_last_event_id, gmt_create, gmt_modified, version, "
                    + "public_session_id, deleted_at, workspace_id, workspace_generation, "
                    + "workspace_storage_id, cwd_relative, context_config_ref, context_revision, "
                    + "workspace_config_ref, workspace_policy_ref, agent_revision, approval_mode, "
                    + "tool_profile, creator_actor_key, owner_actor_key, parent_session_id, "
                    + "root_session_id, parent_child_run_id, child_depth, agent_definition_digest, "
                    + "session_kind, tenant_key, session_key, session_scope_key, title_revision, "
                    + "retirement_operation_id, retirement_generation, retired_at, recovery_protected, "
                    + "resource_gc_completed, runtime_request_key, csi_guard, model_id, model_revision, "
                    + "selected_approval_mode, approval_revision, plan_enabled"),
    SESSION_HEAD(
            "tenant_id, workspace_id, session_id, storage_version, state, writer_generation, "
                    + "writer_id, writer_lease_until, lease_token_hash, journal_revision, "
                    + "committed_sequence, last_commit_digest, activation_epoch, "
                    + "latest_checkpoint_resource_id, compacted_through_revision, recovery_status, "
                    + "recovery_detail_code, gmt_create, gmt_modified, o3_backfill_revision, "
                    + "o3_backfill_through, o3_backfill_error, o3_backfill_pending, activation_id, "
                    + "activation_phase, activation_event_epoch, activation_expires_at, "
                    + "activation_head_revision, tenant_key, harness_key, harness_session_id, head_kind, "
                    + "phase, operation_id, claim_generation, claim_lease_until, wake_pending, "
                    + "wake_head_revision, wake_retry_at, wake_scan_pending"),
    SESSION_JOURNAL_TX(
            "tenant_id, workspace_id, session_id, journal_revision, command_key_hash, "
                    + "transaction_id, operation, command_id, content_digest, first_sequence, "
                    + "last_sequence, event_count, events_digest, previous_commit_digest, commit_digest, "
                    + "writer_generation, writer_id, writer_token_hash, activation_epoch, "
                    + "latest_checkpoint_resource_id, record_encoding, record_bytes, byte_length, "
                    + "record_digest, gmt_create"),
    SESSION_RECORD(
            "session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, "
                    + "record_id, operation_hash, revision, record_resource_id, task_kind, task_state, "
                    + "runtime_state, definition_revision, delivery_target, delivery_state, gmt_create, "
                    + "started_at, settled_at, first_sequence, hook_once_key_hash, hook_occurrence_hash, "
                    + "hook_ordinal, hook_definition_hash, record_kind, state, action_id, action_version, "
                    + "decision_receipt_id, decision_digest, prompt_id, turn_id, options_json"),
    SNAPSHOT(
            "tenant_id, session_id, snapshot_id, snapshot_version, covered_sequence, "
                    + "projection_version, manifest_resource_key, manifest_sha256, item_count, state, "
                    + "gmt_create, published_at, retain_until"),
    STORAGE(
            "alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key, "
                    + "registration_state, storage_kind, registration_revision, registration_json, "
                    + "fence_operation_id, mount_revision, gmt_create, gmt_modified"),
    STORAGE_OWNER(
            "storage_key, holder_key, binding_id, runtime_generation, runtime_session_id, "
                    + "tenant_id, storage_id, mount_revision, mount_state, mount_operation_id, "
                    + "mount_completed_operation_id, mount_root, mount_host_id, mount_device, mount_inode, "
                    + "mount_birth_time, mount_registration_id, storage_kind, csi_phase, csi_revision, "
                    + "csi_reservation_id, csi_registration_key, csi_registration_revision, "
                    + "csi_provision_request_id, maintenance_id, maintenance_generation, physical_key"),
    TENANT_GUARD(
            "tenant_key, tenant_id, guard_domain"),
    TOOL_EXECUTION(
            "execution_call_id_hash, execution_call_id, idempotency_key_hash, idempotency_key, "
                    + "binding_id, runtime_generation, harness_session_id, runtime_session_id, "
                    + "runtime_session_key, turn_id, tool_call_id, request_digest, reference_json, "
                    + "execution_state, execution_status, result_json, last_sequence, cancel_requested, "
                    + "dispatch_owner, dispatch_lease_until, dispatch_generation, record_version, "
                    + "settled_at, abandoned_at, loss_evidence_id, authorized_dispatch_generation, "
                    + "authorized_binding_version, native_authorization_json"),
    TURN(
            "tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest, status, "
                    + "submission_attempted, harness_event_epoch, harness_last_event_id, dispatch_owner, "
                    + "dispatch_lease_until, error_code, error_message, gmt_create, gmt_modified, "
                    + "completed_at, version, retry_count, consecutive_failures, "
                    + "budget_exempt_failures, retry_after, model_id, model_revision, "
                    + "approval_mode, approval_revision, plan_enabled");

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
