package com.alibaba.qwen.code.daemon;

/** A request reached a different Hosted Harness process generation. */
public final class HostedHarnessGenerationException extends DaemonException {
    private static final String CODE = "hosted_harness_generation_mismatch";
    private final String expectedBootId;
    private final String actualBootId;

    HostedHarnessGenerationException(String expectedBootId,
            String actualBootId) {
        super("Hosted Harness generation changed from " + expectedBootId
                + " to " + actualBootId);
        this.expectedBootId = expectedBootId;
        this.actualBootId = actualBootId;
    }

    public String getExpectedBootId() {
        return expectedBootId;
    }

    public String getActualBootId() {
        return actualBootId;
    }

    public String getCode() {
        return CODE;
    }
}
