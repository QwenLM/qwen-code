package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Receipt for a submitted message or Turn cancellation. */
public final class ManagedTurnAdmission extends ManagedJson {
    ManagedTurnAdmission(Map<String, Object> json) {
        super(json);
    }

    public String getSessionId() {
        return string("session_id");
    }

    public String getTurnId() {
        return string("turn_id");
    }

    public String getStatus() {
        return string("status");
    }

    public boolean isReplayed() {
        return flag("replayed");
    }

    public String getOperationId() {
        return string("operation_id");
    }

    public String getAdmissionStage() {
        return string("admission_stage");
    }

    public String getDeliveryState() {
        return string("delivery_state");
    }
}
