package com.alibaba.qwen.code.daemon;

/** Input for attaching Java to an existing Hosted Harness session. */
public final class LoadHarnessSession {
    private final String harnessSessionId;

    public LoadHarnessSession(String harnessSessionId) {
        this.harnessSessionId = HostedHarnessClient.requireUuid(
                harnessSessionId, "harnessSessionId");
    }

    String getHarnessSessionId() {
        return harnessSessionId;
    }
}
