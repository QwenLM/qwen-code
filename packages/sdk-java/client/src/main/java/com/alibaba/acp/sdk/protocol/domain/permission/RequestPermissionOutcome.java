package com.alibaba.acp.sdk.protocol.domain.permission;

// Inner class for RequestPermissionOutcome
public class RequestPermissionOutcome {
    private PermissionOutcomeKind outcome;
    private String optionId;

    public RequestPermissionOutcome() {
    }

    public RequestPermissionOutcome(PermissionOutcomeKind outcome, String optionId) {
        this.outcome = outcome;
        this.optionId = optionId;
    }

    // Getters and setters
    public PermissionOutcomeKind getOutcome() {
        return outcome;
    }

    public RequestPermissionOutcome setOutcome(PermissionOutcomeKind outcome) {
        this.outcome = outcome;
        return this;
    }

    public String getOptionId() {
        return optionId;
    }

    public RequestPermissionOutcome setOptionId(String optionId) {
        this.optionId = optionId;
        return this;
    }
}
