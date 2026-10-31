package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/**
 * Trusted host operations needed by native external-Workspace recovery and
 * retirement. Implementations hold the original provider credentials inside
 * the process boundary; callers only receive a redacted snapshot or a
 * recovered durable binding.
 */
public interface ExternalWorkspaceRecoveryGateway {
    Map<String, Object> externalRecoveryProviderRequest(
            RuntimeBindingRecord binding);

    CompletionStage<RuntimeBindingRecord> recoverExternalWorkspaceBinding(
            String bindingId, long expectedGeneration, long expectedVersion);

    void validateExternalTerminalOriginal(RuntimeBindingRecord binding);
}
