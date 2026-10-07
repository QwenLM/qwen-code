package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletionStage;

/**
 * Resolves the authoritative Runtime scope for one Harness Session.
 *
 * <p>The returned scope must remain stable for the lifetime of every Runtime
 * Session created under it. A genuine scope change requires a new Runtime
 * Session identity.
 */
public interface HarnessSessionResolver {
    /**
     * Resolves the scope for bootstrap routes (warm, acquire, run). These
     * create new Runtime work, so a resolver may fence a retired Harness
     * Session here.
     */
    CompletionStage<RuntimeScope> resolve(String harnessSessionId);

    /**
     * Resolves the scope for teardown routes (durable release and
     * unknown-outcome reconciliation). Teardown creates no new Runtime work;
     * it only needs the durable tenant/workspace placement of an existing
     * Session so its shutdown can converge, and must still answer after the
     * Harness Session was archived or deleted. Defaults to {@link #resolve}.
     */
    default CompletionStage<RuntimeScope> resolveForTeardown(
            String harnessSessionId) {
        return resolve(harnessSessionId);
    }
}
