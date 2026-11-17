package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The turn events the session-store integration test commits, shared with
 * the reader replay, so a payload either edits is the payload both see. The
 * oversized-commit derivation keys on {@code "sequence":1,} and
 * {@code turn-1:accepted} staying single, so the payload names neither.
 */
final class TurnEventLines {
    private static final ObjectMapper JSON = new ObjectMapper();
    /** The reader's maxTextBytes, which bounds one delta's text. */
    static final int MAX_DELTA_TEXT_BYTES = 4096;

    private TurnEventLines() {
    }

    /** A message.delta event: the only raw-text payload the reader takes,
     * so the densest line it accepts. */
    static ObjectNode messageDeltaEvent(String tenant, String workspace,
            String session, long sequence, String text) {
        ObjectNode sessionKey = JSON.createObjectNode()
                .put("tenantId", tenant).put("workspaceId", workspace)
                .put("sessionId", session);
        ObjectNode payload = JSON.createObjectNode()
                .put("messageId", "message-1").put("turnId", "turn-1")
                .put("role", "assistant").put("text", text);
        return PublicationJournalFixture.eventNode(sequence, "message.delta",
                payload, sessionKey, 1);
    }

    /** {@code count} message.delta lines from {@code firstSequence}, then
     * the commit marker. */
    static String deltaBytes(String tenant, String workspace, String session,
            long firstSequence, int count, String text) {
        StringBuilder lines = new StringBuilder();
        for (int index = 0; index < count; index++) {
            lines.append(ExtensionRecordJournal.line(session,
                    "managed_session_event_v1", messageDeltaEvent(tenant,
                            workspace, session, firstSequence + index,
                            text)));
        }
        return lines.append(PublicationJournalFixture.COMMIT_MARKER)
                .toString();
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
