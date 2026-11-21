package com.alibaba.qwen.code.managedagent.workspace;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.apache.commons.codec.digest.DigestUtils;

/** Synthetic child-Session actor kept inside the 36-character actor budget. */
public final class ChildActorId {
    private ChildActorId() {
    }

    public static String of(String parentSessionId) {
        if (parentSessionId == null || parentSessionId.isEmpty()) {
            throw new IllegalArgumentException("parentSessionId is required");
        }
        byte[] parent = ManagedSchemaKeys.identity(parentSessionId);
        return "c:" + DigestUtils.sha256Hex(parent).substring(0, 32);
    }
}
