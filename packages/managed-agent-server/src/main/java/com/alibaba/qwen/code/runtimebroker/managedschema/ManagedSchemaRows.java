package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Reads raw SQL rows while decoding only declared UTF-8 identity columns. */
public final class ManagedSchemaRows {
    private static final Set<String> IDENTITIES =
            Set.of(
                    "tenant_id",
                    "workspace_id",
                    "session_id",
                    "parent_session_id",
                    "root_session_id",
                    "original_tenant",
                    "original_workspace",
                    "source_session_id",
                    "target_session_id",
                    "public_session_id",
                    "harness_session_id",
                    "operation_id",
                    "retirement_operation_id",
                    "fence_operation_id",
                    "idempotency_key",
                    "scope_id",
                    "target_id",
                    "agent_id",
                    "channel_id",
                    "schedule_id",
                    "record_id",
                    "resource_id",
                    "publication_id",
                    "capture_id",
                    "slot_key",
                    "event_id",
                    "source_key",
                    "stream_id",
                    "output_stream_id",
                    "resource_kind",
                    "sender_session_id",
                    "child_session_id",
                    "message_id",
                    "artifact_id",
                    "result_id",
                    "occurrence_key",
                    "snapshot_id",
                    "current_snapshot_id",
                    "turn_id",
                    "prompt_id",
                    "item_id",
                    "action_id",
                    "task_id",
                    "decision_receipt_id",
                    "receipt_id",
                    "child_run_id",
                    "child_workspace_id",
                    "parent_workspace_id",
                    "segment_id",
                    "creation_key",
                    "provider_id",
                    "lease_id",
                    "binding_id",
                    "active_binding_id",
                    "runtime_session_id",
                    "storage_id",
                    "isolation_key",
                    "workspace_generation",
                    "capability_digest",
                    "credential_key_id",
                    "runtime_credential_key_id",
                    "runtime_instance_id",
                    "runtime_lease_id",
                    "provision_request_id",
                    "operation_owner",
                    "dispatch_owner",
                    "loss_evidence_id",
                    "tool_call_id",
                    "execution_call_id",
                    "claim_owner",
                    "policy_version",
                    "kind",
                    "object_key",
                    "capture_object_key",
                    "object_version_id",
                    "encryption_key_id",
                    "publish_command_id",
                    "harness_boot_id",
                    "harness_event_epoch",
                    "workspace_storage_id",
                    "context_config_ref",
                    "workspace_config_ref",
                    "workspace_policy_ref",
                    "parent_child_run_id",
                    "writer_id",
                    "latest_checkpoint_resource_id",
                    "activation_id",
                    "transaction_id",
                    "command_id",
                    "content_part_id",
                    "active_operation_id",
                    "finish_operation_id",
                    "finish_predecessor_id",
                    "terminal_resource_id",
                    "admission_resource_id",
                    "config_ref",
                    "policy_ref",
                    "csi_provision_request_id",
                    "account_id",
                    "route_id",
                    "sender_id",
                    "chat_id",
                    "thread_id",
                    "lease_owner",
                    "run_id",
                    "record_resource_id");

    private ManagedSchemaRows() {}

    public static Map<String, Object> read(ResultSet result) throws SQLException {
        var columns = result.getMetaData();
        Map<String, Object> row = new LinkedHashMap<>();
        for (int index = 1; index <= columns.getColumnCount(); index++) {
            String label = columns.getColumnLabel(index).toLowerCase(Locale.ROOT);
            Object value = result.getObject(index);
            if (value instanceof java.sql.Blob) {
                value = result.getBytes(index);
            } else if (value instanceof java.sql.Clob) {
                value = result.getString(index);
            }
            if (value instanceof byte[] bytes && IDENTITIES.contains(label)) {
                value = utf8(bytes, label);
            } else if (value instanceof java.time.LocalDateTime timestamp) {
                value = java.sql.Timestamp.valueOf(timestamp);
            }
            row.put(label, value);
        }
        return row;
    }

    public static String identity(ResultSet result, String label) throws SQLException {
        byte[] bytes = result.getBytes(label);
        return bytes == null ? null : utf8(bytes, label);
    }

    private static String utf8(byte[] bytes, String label) throws SQLException {
        try {
            return StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException exception) {
            throw new SQLException("Identity column is not valid UTF-8: " + label, exception);
        }
    }
}
