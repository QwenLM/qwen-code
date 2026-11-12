package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.StoreModels;

import java.util.ArrayList;
import java.util.List;

/** Actor naming and Session-row insert arguments of a child Session admission. */
final class ChildSessionCreation {
    private ChildSessionCreation() {}

    static String childActorOf(String parentSessionId) {
        return "child:" + parentSessionId;
    }

    static Object[] childInsertArgs(String sessionId, String title,
            long now, String childCwdRelative, String toolProfile,
            StoreModels.SessionLineage lineage, String tenantId,
            String parentSessionId) {
        List<Object> args = new ArrayList<>(List.of(sessionId, title, now, now));
        if (childCwdRelative != null) {
            args.add(childCwdRelative);
        }
        if (toolProfile != null) {
            args.add(toolProfile);
        }
        args.addAll(List.of(lineage.parentSessionId(), lineage.rootSessionId(),
                lineage.parentChildRunId(), lineage.depth(), tenantId,
                parentSessionId));
        return args.toArray();
    }
}
