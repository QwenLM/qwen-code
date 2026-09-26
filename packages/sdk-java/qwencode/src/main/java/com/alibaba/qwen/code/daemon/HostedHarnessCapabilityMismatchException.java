package com.alibaba.qwen.code.daemon;

/** The connected Hosted Harness does not match Java admission policy. */
public final class HostedHarnessCapabilityMismatchException
        extends DaemonException {
    private static final String CODE = "managed_capability_mismatch";

    private final String expectedDigest;
    private final String actualDigest;

    HostedHarnessCapabilityMismatchException(String expectedDigest,
            String actualDigest) {
        super(CODE + ": expected " + expectedDigest
                + " but Hosted Harness advertised " + actualDigest);
        this.expectedDigest = expectedDigest;
        this.actualDigest = actualDigest;
    }

    public String getCode() {
        return CODE;
    }

    public String getExpectedDigest() {
        return expectedDigest;
    }

    public String getActualDigest() {
        return actualDigest;
    }
}
