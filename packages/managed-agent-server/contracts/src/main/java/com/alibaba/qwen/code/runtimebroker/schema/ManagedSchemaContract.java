package com.alibaba.qwen.code.runtimebroker.schema;

import java.util.Set;

/** Closed persistence domains of the fresh Managed Agent schema. */
public final class ManagedSchemaContract {
    public static final Set<String> TABLES =
            Set.of(
                    "ma_session",
                    "ma_session_principal",
                    "ma_session_worktree",
                    "ma_session_head",
                    "ma_turn",
                    "ma_user_message_queue",
                    "ma_user_message",
                    "ma_user_message_command",
                    "ma_session_journal_tx",
                    "ma_event_stream",
                    "ma_public_event",
                    "ma_message",
                    "ma_session_record",
                    "ma_agent_definition",
                    "ma_extension_package",
                    "ma_extension_settings",
                    "ma_extension_operation",
                    "ma_resource",
                    "ma_resource_ref",
                    "ma_output_capture",
                    "ma_artifact",
                    "ma_request_receipt",
                    "ma_operation",
                    "ma_operation_work",
                    "ma_workspace",
                    "ma_workspace_access",
                    "ma_storage",
                    "ma_runtime_slot",
                    "ma_runtime_binding",
                    "ma_runtime_session",
                    "ma_tool_execution",
                    "ma_tenant_guard",
                    "ma_storage_owner",
                    "ma_read_lease",
                    "ma_channel_instance",
                    "ma_channel_binding",
                    "ma_delivery",
                    "ma_schedule",
                    "ma_schedule_occurrence");

    /**
     * Every Managed table name the predecessor generations used, parsed from
     * {@code verification/src/test/resources/original-managed-table-inventory.tsv}.
     * Consulted only to keep a legacy object visible to the shared-catalog
     * exact-set comparison: a catalog holding one of these beside the target
     * set is half-migrated and must be refused, not filtered away. It never
     * widens {@link #TABLES}, which stays the closed target set.
     */
    public static final Set<String> LEGACY_TABLES =
            Set.of(
                    "managed_agent_action",
                    "managed_agent_artifact",
                    "managed_agent_command",
                    "managed_agent_consumer_progress",
                    "managed_agent_definition",
                    "managed_agent_definition_command",
                    "managed_agent_event",
                    "managed_agent_item",
                    "managed_agent_item_part",
                    "managed_agent_operation",
                    "managed_agent_session",
                    "managed_agent_snapshot",
                    "managed_agent_tool_result",
                    "managed_agent_turn",
                    "managed_session_create_scope",
                    "managed_session_rename_delivery",
                    "managed_workspace_access",
                    "managed_workspace_create_command",
                    "managed_workspace_csi_registration",
                    "managed_workspace_csi_retirement",
                    "managed_workspace_csi_worker_ack",
                    "managed_workspace_default",
                    "managed_workspace_execution_lease",
                    "managed_workspace_migration",
                    "managed_workspace_operator_recovery",
                    "managed_workspace_recovery_operation",
                    "managed_workspace_recovery_session",
                    "managed_workspace_recovery_work",
                    "managed_workspace_registry",
                    "qwen_managed_automation_command",
                    "qwen_managed_automation_occurrence",
                    "qwen_managed_automation_schedule",
                    "qwen_managed_channel_binding",
                    "qwen_managed_channel_claim",
                    "qwen_managed_channel_delivery",
                    "qwen_managed_channel_instance",
                    "qwen_managed_channel_route",
                    "qwen_managed_child_result_relay",
                    "qwen_managed_child_workspace",
                    "qwen_managed_session_extension_record",
                    "qwen_managed_session_journal_head",
                    "qwen_managed_session_journal_tx",
                    "qwen_managed_session_message_relay",
                    "qwen_managed_session_resource",
                    "qwen_managed_session_resource_collection",
                    "qwen_managed_session_resource_ref",
                    "qwen_managed_session_task_journal",
                    "qwen_managed_session_task_journal_cursor",
                    "qwen_output_put_attempt",
                    "qwen_output_read_lease",
                    "qwen_output_session_retirement",
                    "qwen_runtime_binding",
                    "qwen_runtime_binding_slot",
                    "qwen_runtime_harness_drain",
                    "qwen_runtime_placement_guard",
                    "qwen_runtime_session",
                    "qwen_runtime_storage_fence",
                    "qwen_tool_execution",
                    "qwen_tool_publication",
                    "qwen_tool_publication_object",
                    "qwen_tool_publication_operation",
                    "qwen_tool_publication_seal",
                    "qwen_tool_publication_tenant");

    private ManagedSchemaContract() {}

    public enum OperationKind {
        CLOSE,
        ARCHIVE,
        DELETE,
        UNARCHIVE,
        RENAME,
        CWD_CHANGE,
        CONTEXT_COMPRESSION,
        ACTION_RESPONSE,
        TASK_CANCEL,
        CHILD_SESSION_START,
        CHILD_SESSION_CLOSE,
        CHILD_WORKSPACE,
        SESSION_WORKTREE,
        OUTPUT_UPLOAD,
        OUTPUT_VERIFY,
        OUTPUT_FINISH,
        OBJECT_PUT,
        TOOL_RESULT_PROJECTION,
        SESSION_RESOURCE_GC,
        CAPTURE_GC,
        WORKSPACE_OPERATOR_RECOVERY,
        WORKSPACE_RECOVERY,
        STORAGE_MIGRATION,
        CSI_RETIREMENT,
        WORKSPACE_RETIREMENT,
        WORKSPACE_UPLOAD,
        CHANNEL_INGRESS,
        SUBMIT_INPUT,
        CANCEL
    }

    public enum ReceiptNamespace {
        SESSION_COMMAND,
        SESSION_CREATE_MODE,
        SESSION_CREATE_ACTOR,
        AGENT_DEFINITION,
        AUTOMATION,
        CHANNEL_INGRESS,
        ACTION_DECISION,
        WORKSPACE_CREATE,
        EXTERNAL_STORAGE,
        EXTERNAL_WORKSPACE
    }

    public enum ReceiptScope {
        TENANT,
        ACTOR,
        SESSION,
        CHANNEL
    }

    public enum WorkKind {
        SESSION,
        RESOURCE,
        EXECUTION_ACK,
        RUNTIME_BINDING,
        CSI_WORKER_ACK,
        RECOVERY_EVIDENCE,
        POD_DELETE_ATTEMPT,
        POD_FINALIZER_ATTEMPT
    }

    public enum ResourceOwnerKind {
        JOURNAL,
        NATIVE_SNAPSHOT,
        CAPTURE,
        ARTIFACT,
        MESSAGE,
        SESSION_RECORD,
        EVENT_STREAM,
        OPERATION,
        OPERATION_WORK,
        RECOVERY,
        HOSTED_CLEANUP
    }

    public enum DeliveryKind {
        CHANNEL,
        SESSION_MESSAGE,
        CHILD_RESULT
    }

    public enum HeadKind {
        MANAGED_SESSION,
        HARNESS
    }

    public enum GuardDomain {
        RUNTIME_PLACEMENT("runtime_placement"),
        OUTPUT_PUBLICATION("output_publication");

        private final String value;

        GuardDomain(String value) {
            this.value = value;
        }

        public String value() {
            return value;
        }
    }
}
