package com.alibaba.qwen.code.daemon;

/** One Java attachment to a Hosted Harness session. */
public final class HarnessSessionRef {
    private final String harnessSessionId;
    private final String harnessClientId;
    private final String harnessBootId;
    private final String harnessControlCwd;
    private final HarnessRuntimeRecovery runtimeRecovery;
    private final Long harnessLastEventId;
    private final String harnessEventEpoch;

    HarnessSessionRef(String harnessSessionId, String harnessClientId,
            String harnessBootId, String harnessControlCwd,
            HarnessRuntimeRecovery runtimeRecovery,
            Long harnessLastEventId, String harnessEventEpoch) {
        this.harnessSessionId = harnessSessionId;
        this.harnessClientId = harnessClientId;
        this.harnessBootId = harnessBootId;
        this.harnessControlCwd = harnessControlCwd;
        this.runtimeRecovery = runtimeRecovery;
        this.harnessLastEventId = harnessLastEventId;
        this.harnessEventEpoch = harnessEventEpoch;
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

    public HarnessRuntimeRecovery getRuntimeRecovery() {
        return runtimeRecovery;
    }

    public Long getHarnessLastEventId() {
        return harnessLastEventId;
    }

    public String getHarnessEventEpoch() {
        return harnessEventEpoch;
    }
}
