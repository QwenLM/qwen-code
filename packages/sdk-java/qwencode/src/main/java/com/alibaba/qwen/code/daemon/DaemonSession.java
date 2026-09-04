package com.alibaba.qwen.code.daemon;

/** Identity returned by {@code POST /session}. */
public final class DaemonSession {
    private final String sessionId;
    private final String workspaceCwd;
    private final boolean attached;
    private final String clientId;
    private final String createdAt;

    DaemonSession(String sessionId, String workspaceCwd, boolean attached,
            String clientId, String createdAt) {
        this.sessionId = sessionId;
        this.workspaceCwd = workspaceCwd;
        this.attached = attached;
        this.clientId = clientId;
        this.createdAt = createdAt;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getWorkspaceCwd() {
        return workspaceCwd;
    }

    public boolean isAttached() {
        return attached;
    }

    public String getClientId() {
        return clientId;
    }

    public String getCreatedAt() {
        return createdAt;
    }
}
