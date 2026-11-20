package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Validated live summary returned by the Hosted Harness. */
public final class HarnessSessionStatus {
    private final String harnessSessionId;
    private final boolean activePrompt;
    private final HarnessRecoveryStatus recovery;
    private final Map<String, Object> raw;

    HarnessSessionStatus(String harnessSessionId, boolean activePrompt,
            Map<String, Object> raw) {
        this.harnessSessionId = harnessSessionId;
        this.activePrompt = activePrompt;
        Map<String, Object> evidence = JsonSupport.optionalObject(raw, "recovery");
        this.recovery = evidence == null ? null : new HarnessRecoveryStatus(evidence);
        this.raw = JsonSupport.immutableObject(raw);
    }

    public String getHarnessSessionId() {
        return harnessSessionId;
    }

    public boolean hasActivePrompt() {
        return activePrompt;
    }

    public Map<String, Object> getRaw() {
        return raw;
    }

    /** Null when an older Harness supplies no affirmative evidence. */
    public HarnessRecoveryStatus getRecovery() {
        return recovery;
    }
}
