package com.alibaba.qwen.code.daemon;

/** Server timestamp returned after a session heartbeat. */
public final class HeartbeatResult {
    private final String sessionId;
    private final String clientId;
    private final long lastSeenAt;

    HeartbeatResult(String sessionId, String clientId, long lastSeenAt) {
        this.sessionId = sessionId;
        this.clientId = clientId;
        this.lastSeenAt = lastSeenAt;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getClientId() {
        return clientId;
    }

    public long getLastSeenAt() {
        return lastSeenAt;
    }
}
