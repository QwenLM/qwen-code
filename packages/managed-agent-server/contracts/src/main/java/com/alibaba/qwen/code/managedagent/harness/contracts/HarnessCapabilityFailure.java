package com.alibaba.qwen.code.managedagent.harness.contracts;

public final class HarnessCapabilityFailure extends HarnessFailure {
    private final String expectedDigest;
    private final String actualDigest;
    private final String code;

    public HarnessCapabilityFailure(String message, Throwable cause, String expectedDigest, String actualDigest, String code) {
        super(message, cause);
        this.expectedDigest = expectedDigest;
        this.actualDigest = actualDigest;
        this.code = code;
    }

    public String getExpectedDigest() { return expectedDigest; }

    public String getActualDigest() { return actualDigest; }

    public String getCode() { return code; }
}
