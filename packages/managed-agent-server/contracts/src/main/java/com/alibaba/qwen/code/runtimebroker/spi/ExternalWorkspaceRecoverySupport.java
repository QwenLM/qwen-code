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
    /** Validates an unleased first-start original without adopting a replacement endpoint. */
    void validateTerminalOriginal(RuntimeBindingRecord binding);

    /** Exports the original boot only to the trusted local recovery host. */
    Map<String, Object> recoveryProviderRequest(RuntimeBindingRecord binding);
}
