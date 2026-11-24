package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;

/** Session status and journal event names of the lifecycle operation kinds. */
final class LifecycleOperationNames {
    private LifecycleOperationNames() {}

    // ARCHIVING remains only for an archive admitted before V17, which closes
    // the Harness as archive used to.
    static String pendingStatus(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "CLOSING";
            case ARCHIVE -> "ARCHIVING";
            case DELETE -> "DELETING";
            case ACTION_RESPONSE, CWD_CHANGE, CONTEXT_COMPRESSION, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    static String requestedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.close.requested";
            case ARCHIVE -> "session.archive.requested";
            case DELETE -> "session.delete.requested";
            case ACTION_RESPONSE, CWD_CHANGE, CONTEXT_COMPRESSION, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }

    static String completedEvent(OperationKind kind) {
        return switch (kind) {
            case CLOSE -> "session.closed";
            case ARCHIVE -> "session.archived";
            case DELETE -> "session.deleted";
            case ACTION_RESPONSE, CWD_CHANGE, CONTEXT_COMPRESSION, TASK_CANCEL, SUBMIT_INPUT, CANCEL ->
                    throw new IllegalArgumentException("Not a lifecycle operation");
        };
    }
}
