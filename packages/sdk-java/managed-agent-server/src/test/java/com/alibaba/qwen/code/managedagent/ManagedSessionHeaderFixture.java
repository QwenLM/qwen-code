package com.alibaba.qwen.code.managedagent;

/**
 * The one faithful genesis: the foreign engine record and the Managed
 * header record the authority writes, shared by the store integration
 * tests, the MySQL integration test and the process-loss fixture.
 */
final class ManagedSessionHeaderFixture {
    private ManagedSessionHeaderFixture() {
    }

    /** The two record lines a Managed Session opens with. */
    static String genesisLines(String tenantId, String workspaceId,
            String sessionId) {
        return engineLine(sessionId) + headerRecord(tenantId, workspaceId,
                sessionId);
    }

    static String engineLine(String sessionId) {
        return "{\"subtype\":\"session_execution_engine\",\"sessionId\":\""
                + sessionId + "\"}\n";
    }

    /** The Managed header record, with the body the authority accepts. */
    static String headerRecord(String tenantId, String workspaceId,
            String sessionId) {
        return "{\"subtype\":\"managed_session_header_v1\",\"sessionId\":\""
                + sessionId + "\",\"managedSession\":{\"formatVersion\":1,"
                + "\"minimumReader\":\"managed-session/1\",\"sessionKey\":"
                + "{\"tenantId\":\"" + tenantId + "\",\"workspaceId\":\""
                + workspaceId + "\",\"sessionId\":\"" + sessionId + "\"},"
                + "\"engine\":\"managed\",\"definitionRef\":{"
                + "\"resourceId\":\"definition-1\",\"kind\":"
                + "\"managed-session-definition\",\"schemaVersion\":1,"
                + "\"byteLength\":10,\"digest\":\"" + sha256("definition")
                + "\"},\"rootSnapshotRef\":{\"resourceId\":\"root-1\","
                + "\"kind\":\"managed-session-root-snapshot\","
                + "\"schemaVersion\":1,\"byteLength\":4,\"digest\":\""
                + sha256("root") + "\"},\"createdBy\":\"test\"}}\n";
    }

    private static String sha256(String value) {
        return ExtensionRecordJournal.sha256(value);
    }
}
