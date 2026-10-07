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
    CompletionStage<RuntimeScope> resolve(String harnessSessionId);

    /**
     * Resolves the scope for a route that admits new work (a warm). The
     * default is a plain resolve; an implementation that fences a closed
     * Session does so here, so teardown routes such as release and
     * unknown-outcome reconciliation still resolve that Session's scope.
     */
    default CompletionStage<RuntimeScope> resolveAdmission(
            String harnessSessionId) {
        return resolve(harnessSessionId);
    }

    default CompletionStage<String> resolveTenant(String harnessSessionId) {
        return resolve(harnessSessionId).thenApply(RuntimeScope::getTenantId);
    }
}
