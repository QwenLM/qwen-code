package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;

/** Journal event and source-key names of a Session rename/unarchive mutation. */
final class SessionMutationEvents {
    private SessionMutationEvents() {}

    static String mutationEvent(SessionMutationKind kind, String phase) {
        if ("completed".equals(phase)) {
            return kind == SessionMutationKind.RENAME ? "session.updated"
                    : "session.unarchived";
        }
        return "session."
                + (kind == SessionMutationKind.RENAME ? "update" : "unarchive")
                + "." + phase;
    }

    static String mutationSource(String operation, String idempotencyKey, String phase) {
        return "control:" + operation + ":" + idempotencyKey + ":" + phase;
    }
}
