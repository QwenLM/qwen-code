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
            long createdAt, long modifiedAt, String connectionId) {
        public boolean active() {
            return STATE_ACTIVE.equals(state);
        }
    }

    /**
     * The new binding plus the binding it atomically replaced (null for a first
     * registration). Compensation must restore the snapshot captured inside the
     * locked register, not one read earlier outside it, which a concurrent
     * registration may already have replaced.
     */
    public record RegisterOutcome(Binding binding, Binding previous) {}

    public record QueuedRequest(String requestId, long bindingGeneration, String payloadJson,
            String state, String responseJson, String errorCode, long expiresAt,
            long createdAt, long modifiedAt) {}

    /** The one-time registration answer; the token is shown once, never stored. */
    public record Registration(String serverId, long generation, String token, long expiresAt,
            int toolCount, String connectionId) {
        @Override
        public String toString() {
            // The token is a one-time credential: the generated record toString
            // would print it into any log or error that includes the registration.
            return "Registration[serverId=" + serverId + ", generation=" + generation
                    + ", token=<redacted>, expiresAt=" + expiresAt
                    + ", toolCount=" + toolCount + ", connectionId=" + connectionId + "]";
        }
    }

    /** Binding summary without the credential. */
    public record Status(String serverId, long generation, String state, long expiresAt,
            String connectionId) {}

    public record RegisterRequest(String sessionId, String connectionId) {}

    public record UnregisterRequest(String sessionId, String connectionId) {}

    public record StatusRequest(String sessionId) {}

    public record StreamRequest(String sessionId, long generation, String connectionId) {}

    public record RespondRequest(String sessionId, long generation, String connectionId,
            String rpcRequestId, String responseJson, String errorCode) {}

    private ClientFilesModels() {}
}
