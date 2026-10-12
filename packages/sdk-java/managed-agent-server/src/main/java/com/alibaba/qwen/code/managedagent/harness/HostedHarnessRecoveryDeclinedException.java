package com.alibaba.qwen.code.managedagent.harness;

/**
 * The Hosted Harness refused a takeover load with a typed, terminal reason:
 * the parked Turn's durable state is not one a replacement generation can
 * continue. Distinct from the retriable
 * {@code hosted_turn_recovery_required} — retrying will never change a
 * decline, so the coordinator ends the Turn instead of parking it forever.
 */
public final class HostedHarnessRecoveryDeclinedException
        extends RuntimeException {
    public static final String CODE = "hosted_turn_recovery_declined";
    private final String reason;

    public HostedHarnessRecoveryDeclinedException(String reason) {
        super("Hosted Harness declined the takeover load ("
                + (reason == null ? "unknown" : reason) + ")");
        this.reason = reason == null ? "unknown" : reason;
    }

    public String getReason() {
        return reason;
    }
}
