package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.util.Map;

/**
 * Provider-side operations the trusted host needs for external-Workspace
 * retirement and recovery. Implemented only by the external Workspace
 * provisioner; the host discovers it by type, so the server never links a
 * provider class at compile time.
 */
public interface ExternalWorkspaceRecoverySupport {
    /**
     * Validates the saved original for terminal settlement only. Historical
     * shared-Workspace profiles are checked structurally, without rebuilding
     * their boot or granting execution/recovery authority. This check requires
     * no host resource receipt. The caller must independently verify either
     * termination against the matching original allocation launch/boot receipt,
     * or that the exact provision request was never allocated and is durably
     * cancelled against future allocation. Missing proof must fail closed;
     * passing this structural check alone never authorizes settlement.
     */
    void validateTerminalOriginal(RuntimeBindingRecord binding);

    /** Exports the original boot only to the trusted local recovery host. */
    Map<String, Object> recoveryProviderRequest(RuntimeBindingRecord binding);
}
