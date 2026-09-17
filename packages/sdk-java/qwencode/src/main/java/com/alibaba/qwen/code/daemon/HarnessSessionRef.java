package com.alibaba.qwen.code.daemon;

/** One Java attachment to a Hosted Harness session. */
public final class HarnessSessionRef {
    private final String harnessSessionId;
    private final String harnessClientId;
    private final String harnessBootId;
    private final String harnessControlCwd;

    HarnessSessionRef(String harnessSessionId, String harnessClientId,
            String harnessBootId, String harnessControlCwd) {
        this.harnessSessionId = harnessSessionId;
        this.harnessClientId = harnessClientId;
        this.harnessBootId = harnessBootId;
        this.harnessControlCwd = harnessControlCwd;
    }

    public String getHarnessSessionId() {
        return harnessSessionId;
    }

    public String getHarnessClientId() {
        return harnessClientId;
    }

    public String getHarnessBootId() {
        return harnessBootId;
    }

    public String getHarnessControlCwd() {
        return harnessControlCwd;
    }
}
