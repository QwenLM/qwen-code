package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Current execution state of a Managed Turn. */
public final class ManagedTurn extends ManagedJson {
    ManagedTurn(Map<String, Object> json) {
        super(json);
    }

    public String getId() {
        return string("id");
    }

    public String getSessionId() {
        return string("session_id");
    }

    public Status getStatus() {
        return Status.fromWire(getStatusCode());
    }

    /** Exact Server value, including states added in newer Server versions. */
    public String getStatusCode() {
        return string("status");
    }

    public String getInputItemId() {
        return optionalString("input_item_id");
    }

    public long getCreatedAt() {
        return number("created_at");
    }

    public Long getCompletedAt() {
        return optionalNumber("completed_at");
    }

    public String getErrorCode() {
        return optionalString("error_code");
    }

    public String getOperationId() {
        return optionalString("operation_id");
    }

    public String getAdmissionStage() {
        return optionalString("admission_stage");
    }

    public String getDeliveryState() {
        return optionalString("delivery_state");
    }

    public enum Status {
        ACCEPTED, RUNNING, CANCELLING, COMPLETED, FAILED, CANCELLED, RECOVERY_BLOCKED, UNKNOWN;

        private static Status fromWire(String value) {
            try {
                return valueOf(value.toUpperCase(java.util.Locale.ROOT));
            } catch (IllegalArgumentException unknown) {
                return UNKNOWN;
            }
        }
    }
}
