package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Current Session recovery state. */
public final class ManagedRecovery extends ManagedJson {
    ManagedRecovery(Map<String, Object> json) {
        super(json);
    }

    public String getState() {
        return string("state");
    }

    public String getReasonCode() {
        return string("reasonCode");
    }

    public String getTurnId() {
        return optionalString("turnId");
    }

    public boolean isNextTurnAllowed() {
        return flag("nextTurnAllowed");
    }

    public Actions getActions() {
        return new Actions(object("actions"));
    }

    public Long getNextRecheckAt() {
        return optionalNumber("nextRecheckAt");
    }

    /** Recovery actions currently allowed. */
    public static final class Actions extends ManagedJson {
        Actions(Map<String, Object> json) {
            super(json);
        }

        public boolean canRecheck() {
            return flag("recheck");
        }

        public boolean canCancel() {
            return flag("cancel");
        }

        public boolean canContinueInNewSession() {
            return flag("continueInNewSession");
        }
    }
}
