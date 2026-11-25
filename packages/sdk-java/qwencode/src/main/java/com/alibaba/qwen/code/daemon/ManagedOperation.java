package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** State of a Session command, such as close, cancellation or an approval response. */
public final class ManagedOperation extends ManagedJson {
    ManagedOperation(Map<String, Object> json) {
        super(json);
    }

    public String getId() {
        return string("id");
    }

    public String getSessionId() {
        return string("session_id");
    }

    public String getType() {
        return string("type");
    }

    public String getStatus() {
        return string("status");
    }

    public boolean isReplayed() {
        return flag("replayed");
    }

    public String getTaskId() {
        return optionalString("task_id");
    }

    public String getAdmissionStage() {
        return optionalString("admission_stage");
    }

    public String getDeliveryState() {
        return optionalString("delivery_state");
    }

    public String getReceiptId() {
        return optionalString("receipt_id");
    }

    public String getFailureCode() {
        return optionalString("failure_code");
    }

    public Resolution getActionResolution() {
        return optionalObject("action_resolution", Resolution::new);
    }

    public Long getExpectedContextRevision() {
        return optionalNumber("expected_context_revision");
    }

    public String getTargetCwdRelative() {
        return optionalString("target_cwd_relative");
    }

    public Long getResultContextRevision() {
        return optionalNumber("result_context_revision");
    }

    public Long getExpectedCompactionRevision() {
        return optionalNumber("expected_compaction_revision");
    }

    public Long getCompactionRevision() {
        return optionalNumber("compaction_revision");
    }

    public String getOutcome() {
        return optionalString("outcome");
    }

    /** Result of processing an action response. */
    public static final class Resolution extends ManagedJson {
        Resolution(Map<String, Object> json) {
            super(json);
        }

        public String getActionId() {
            return string("action_id");
        }

        public String getOutcome() {
            return string("outcome");
        }

        public String getReceiptId() {
            return string("receipt_id");
        }

        public String getDecisionReceiptId() {
            return optionalString("decision_receipt_id");
        }
    }
}
