package com.alibaba.qwen.code.managedagent.harness.contracts;

public final class HarnessGenerationFailure extends HarnessFailure {
    private final String expectedBootId;
    private final String actualBootId;
    private final String code;

    public HarnessGenerationFailure(String message, Throwable cause, String expectedBootId, String actualBootId, String code) {
        super(message, cause);
        this.expectedBootId = expectedBootId;
        this.actualBootId = actualBootId;
        this.code = code;
    }

    public String getExpectedBootId() { return expectedBootId; }

    public String getActualBootId() { return actualBootId; }

    public String getCode() { return code; }
}
