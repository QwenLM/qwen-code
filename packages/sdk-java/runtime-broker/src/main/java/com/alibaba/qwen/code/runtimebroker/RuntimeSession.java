package com.alibaba.qwen.code.runtimebroker;

/** A Harness-owned logical Managed Tool Session on one Java-owned scope. */
public final class RuntimeSession {
    private final String harnessSessionId;
    private final String runtimeSessionId;
    private final String turnKind;
    private final RuntimeScope scope;

    RuntimeSession(String harnessSessionId, String runtimeSessionId,
            String turnKind, RuntimeScope scope) {
        this.harnessSessionId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        this.runtimeSessionId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        if (!"bootstrap".equals(turnKind)
                && !"continuation".equals(turnKind)) {
            throw new IllegalArgumentException(
                    "turnKind must be bootstrap or continuation");
        }
        this.turnKind = turnKind;
        this.scope = scope;
    }

    public String getHarnessSessionId() {
        return harnessSessionId;
    }

    public String getRuntimeSessionId() {
        return runtimeSessionId;
    }

    public String getTurnKind() {
        return turnKind;
    }

    public RuntimeScope getScope() {
        return scope;
    }
}
