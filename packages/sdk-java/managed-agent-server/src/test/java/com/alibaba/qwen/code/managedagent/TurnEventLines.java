package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The input.accepted turn event the session-store integration test commits,
 * shared with the reader replay, so a payload either edits is the payload
 * both see. The oversized-commit derivation keys on {@code "sequence":1,}
 * and {@code turn-1:accepted} staying single, so the payload names neither.
 */
final class TurnEventLines {
    private static final ObjectMapper JSON = new ObjectMapper();

    private TurnEventLines() {
    }

    /** The input.accepted event the turn transaction carries. */
    static ObjectNode inputAcceptedEvent(String tenant, String workspace,
            String session) {
        ObjectNode event = JSON.createObjectNode().put("v", 1)
                .put("sequence", 1).put("eventId", "turn-1:accepted");
        event.putObject("sessionKey").put("tenantId", tenant)
                .put("workspaceId", workspace).put("sessionId", session);
        event.put("kind", "input.accepted").put("occurredAt", 1000);
        ObjectNode payload = event.putObject("payload")
                .put("inputId", "input-1").put("turnId", "turn-1")
                .put("source", "user");
        payload.set("contentRef", ref("turn-1:input",
                "managed-session-input", "c".repeat(64)));
        payload.putNull("deadline");
        payload.set("admissionRef", ref("turn-1:admission",
                "managed-session-admission", "d".repeat(64)));
        return event;
    }

    /** The two record lines of the turn transaction. */
    static String turnBytes(String tenant, String workspace,
            String session) {
        return "{\"subtype\":\"managed_session_event_v1\",\"managedSession\":"
                + inputAcceptedEvent(tenant, workspace, session) + "}\n"
                + "{\"subtype\":\"managed_session_commit_v1\"}\n";
    }

    private static ObjectNode ref(String resourceId, String kind,
            String digest) {
        return JSON.createObjectNode().put("resourceId", resourceId)
                .put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", 2).put("digest", digest);
    }
}
