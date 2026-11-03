package com.alibaba.qwen.code.runtimebroker.managedschema;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertThrows;

class ManagedSchemaIntegrityTest {
    @Test
    void publicBindingsMustBeWholeWhileControlSessionsCanRemainUnbound() {
        var row = session();
        ManagedSchemaIntegrity.validate("ma_session", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(row, "workspace_id", "workspace")));
        row.putAll(ManagedSchemaIntegrity.row("workspace_id", "workspace", "workspace_generation", 1L,
                "workspace_storage_id", "storage", "cwd_relative", ".", "context_config_ref", "context",
                "context_revision", 1L, "workspace_config_ref", "config", "workspace_policy_ref", "policy"));
        ManagedSchemaIntegrity.validate("ma_session", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(row, "workspace_policy_ref", null)));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(row, "context_revision", 0L)));
        ManagedSchemaIntegrity.validate("ma_session", changed(row,
                "session_kind", "CONTROL", "workspace_policy_ref", null));
    }

    @Test
    void sessionSelectionBoundsAndPermissionLimitsUseUtf8Bytes() {
        var row = session();
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(row, "model_id", "model")));
        row.putAll(ManagedSchemaIntegrity.row("model_id", "model", "model_revision", 9_007_199_254_740_991L,
                "selected_approval_mode", "auto", "approval_revision", 1L,
                "permission_rules_json", "界".repeat(2730)));
        ManagedSchemaIntegrity.validate("ma_session", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(row, "model_revision", 9_007_199_254_740_992L)));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(row, "permission_rules_json", "界".repeat(2731))));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(row, "selected_approval_mode", null)));
    }

    @Test
    void turnLegacyRevisionZeroDoesNotPermitPlanOrPermissionRules() {
        var row = ManagedSchemaIntegrity.row("model_id", null, "model_revision", null,
                "approval_mode", "default", "approval_revision", 0L, "permission_rules_json", null,
                "is_plan_enabled", false, "is_submission_attempted", false);
        ManagedSchemaIntegrity.validate("ma_turn", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_turn", changed(row, "is_plan_enabled", true)));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_turn", changed(row, "permission_rules_json", "[]")));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_turn", changed(row, "approval_mode", null)));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_turn", changed(row, "model_revision", 1L)));
    }

    @Test
    void headDiscriminatorControlsTheWholeJournalTuple() {
        var row = ManagedSchemaIntegrity.row("head_kind", "HARNESS", "claim_generation", 0L,
                "journal_revision", null, "committed_sequence", null, "writer_generation", null,
                "activation_epoch", null, "storage_version", null, "is_wake_pending", false);
        ManagedSchemaIntegrity.validate("ma_session_head", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session_head", changed(row, "journal_revision", 0L)));
        row.putAll(ManagedSchemaIntegrity.row("head_kind", "MANAGED_SESSION", "journal_revision", 0L,
                "committed_sequence", 0L, "writer_generation", 0L, "activation_epoch", 0L, "storage_version", 1L));
        ManagedSchemaIntegrity.validate("ma_session_head", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session_head", changed(row, "storage_version", null)));
    }

    @Test
    void streamWatermarksCannotExceedTheirTailOrLeakIntoTaskStreams() {
        var row = ManagedSchemaIntegrity.row("stream_kind", "SESSION", "last_sequence", 10L,
                "replay_floor_sequence", 4L, "covered_sequence", 9L, "wake_covered_sequence", 5L);
        ManagedSchemaIntegrity.validate("ma_event_stream", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_event_stream", changed(row, "replay_floor_sequence", 11L)));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_event_stream", changed(row, "covered_sequence", 11L)));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_event_stream", changed(row, "stream_kind", "TASK")));
        ManagedSchemaIntegrity.validate("ma_event_stream", changed(row,
                "stream_kind", "TASK", "wake_covered_sequence", null));
    }

    @Test
    void captureAndHostedCleanupAssociationsCannotBePartiallyRecorded() {
        var row = ManagedSchemaIntegrity.row("byte_length", 0L, "publication_id", null,
                "scope_key", null, "slot_key", null, "capture_state", null);
        ManagedSchemaIntegrity.validate("ma_resource", row);
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_resource", changed(row, "publication_id", "publication")));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_resource_ref", ManagedSchemaIntegrity.row("owner_kind", "HOSTED_CLEANUP",
                        "owner_revision", 0L, "runtime_binding_key", "binding")));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_resource_ref", ManagedSchemaIntegrity.row("owner_kind", "JOURNAL",
                        "owner_revision", 1L, "runtime_binding_key", "binding")));
    }

    @Test
    void candidatesMustBeCompleteAndBooleanDomainsMustRemainExact() {
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", Map.of("model_id", "model")));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session", changed(session(), "is_plan_enabled", 2)));
        assertThrows(IllegalArgumentException.class, () -> ManagedSchemaIntegrity.validate(
                "ma_session_principal", ManagedSchemaIntegrity.row("is_actor_present", -1)));
        ManagedSchemaIntegrity.validate("ma_request_receipt", ManagedSchemaIntegrity.row(
                "namespace", "EXTERNAL_WORKSPACE", "scope_kind", "TENANT", "is_workspace_bound", null));
    }

    private static Map<String, Object> changed(Map<String, Object> row, Object... values) {
        var changed = new LinkedHashMap<>(row);
        changed.putAll(ManagedSchemaIntegrity.row(values));
        return changed;
    }

    private static Map<String, Object> session() {
        return ManagedSchemaIntegrity.row("session_kind", "PUBLIC", "agent_id", "agent",
                "workspace_id", null, "workspace_generation", null, "workspace_storage_id", null,
                "cwd_relative", null, "context_config_ref", null, "context_revision", null,
                "workspace_config_ref", null, "workspace_policy_ref", null, "model_id", null,
                "model_revision", 0L, "selected_approval_mode", null, "approval_revision", 0L,
                "permission_rules_json", null, "is_plan_enabled", false, "public_child_agents_version", 0L,
                "harness_instance_id", null, "harness_owner_boot_id", null, "harness_placement_epoch", 0L,
                "harness_placement_state", "UNASSIGNED", "is_recovery_protected", false,
                "is_resource_gc_completed", false);
    }
}
