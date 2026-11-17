package com.alibaba.qwen.code.managedagent.contracts.harness;

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
    /**
     * #17260: the Session's own shape cannot be opened by this Harness at
     * all (a public-child Session under a topology without public child
     * agents). Unlike the journal-state declines, no settlement route can
     * pay on this Harness, so the coordinator abandons the recovery on the
     * first drive instead of parking a cancellation for retries that can
     * never succeed.
     */
    public static final String REASON_PUBLIC_CHILD_UNSUPPORTED =
            "public_child_recovery_unsupported";
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
