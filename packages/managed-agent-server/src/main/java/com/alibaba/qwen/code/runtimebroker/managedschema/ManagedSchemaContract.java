package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.util.Set;

/** Closed persistence domains of the fresh Managed Agent schema. */
public final class ManagedSchemaContract {
    public static final Set<String> TABLES =
            Set.of(
                    "ma_session",
                    "ma_session_head",
                    "ma_turn",
                    "ma_session_journal_tx",
                    "ma_event_stream",
                    "ma_public_event",
                    "ma_message",
                    "ma_snapshot",
                    "ma_session_record",
                    "ma_agent_definition",
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

    private ManagedSchemaContract() {}

    public enum OperationKind {
        CLOSE,
        ARCHIVE,
        DELETE,
        UNARCHIVE,
        RENAME,
        CWD_CHANGE,
        ACTION_RESPONSE,
        TASK_CANCEL,
        CHILD_SESSION_START,
        CHILD_SESSION_CLOSE,
        CHILD_WORKSPACE,
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
        CHANNEL_INGRESS
    }

    public enum ReceiptNamespace {
        SESSION_COMMAND,
        SESSION_CREATE_MODE,
        SESSION_CREATE_ACTOR,
        AGENT_DEFINITION,
        AUTOMATION,
        CHANNEL_INGRESS,
        ACTION_DECISION,
        WORKSPACE_CREATE
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
        RECOVERY_EVIDENCE
    }

    public enum ResourceOwnerKind {
        JOURNAL,
        SNAPSHOT,
        CAPTURE,
        ARTIFACT,
        MESSAGE,
        SESSION_RECORD,
        EVENT_STREAM,
        OPERATION,
        OPERATION_WORK,
        RECOVERY
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
