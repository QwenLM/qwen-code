package com.alibaba.qwen.code.daemon;

/** Server timestamp returned by a Hosted Harness heartbeat. */
public final class HarnessHeartbeat {
    private final String harnessSessionId;
    private final String harnessClientId;
    private final long lastSeenAt;

    HarnessHeartbeat(String harnessSessionId, String harnessClientId,
            long lastSeenAt) {
        this.harnessSessionId = harnessSessionId;
        this.harnessClientId = harnessClientId;
        this.lastSeenAt = lastSeenAt;
    }

    public String getHarnessSessionId() {
        return harnessSessionId;
    }

    public String getHarnessClientId() {
        return harnessClientId;
    }

    public long getLastSeenAt() {
        return lastSeenAt;
    }
}
