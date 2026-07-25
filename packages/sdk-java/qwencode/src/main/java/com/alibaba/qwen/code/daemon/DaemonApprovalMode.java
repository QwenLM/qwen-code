package com.alibaba.qwen.code.daemon;

/** Approval modes accepted by the current daemon session API. */
public enum DaemonApprovalMode {
    PLAN("plan"),
    DEFAULT("default"),
    AUTO_EDIT("auto-edit"),
    AUTO("auto"),
    YOLO("yolo");

    private final String wireValue;

    DaemonApprovalMode(String wireValue) {
        this.wireValue = wireValue;
    }

    public String getWireValue() {
        return wireValue;
    }
}
