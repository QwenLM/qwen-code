package com.alibaba.qwen.code.managedagent.contracts.clientfiles;

/**
 * Ephemeral client filesystem registration values. Bindings and queued
 * requests are session-scoped relay state; client file content is forwarded
 * opaquely and never enters the session journal or public events.
 */
public final class ClientFilesModels {
    public static final String STATE_ACTIVE = "active";
    public static final String STATE_CLOSED = "closed";
    public static final String REQUEST_QUEUED = "queued";
    public static final String REQUEST_ANSWERED = "answered";
    public static final String REQUEST_FAILED = "failed";
    public static final String REQUEST_EXPIRED = "expired";
    public static final String ERROR_OFFLINE = "client_files_offline";

    public record Binding(String tenantId, String sessionId, String actorId, long generation,
            String state, String serverId, String tokenHash, long expiresAt,
            long createdAt, long modifiedAt) {
        public boolean active() {
            return STATE_ACTIVE.equals(state);
        }
    }

    public record QueuedRequest(String requestId, long bindingGeneration, String payloadJson,
            String state, String responseJson, String errorCode, long expiresAt,
            long createdAt, long modifiedAt) {}

    private ClientFilesModels() {}
}
