package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/** Proof operations supplied by the optional external Workspace backend. */
public interface ExternalWorkspaceProvider {
    CompletionStage<Void> verifyAcquisition(RuntimeBindingRecord binding);

    void validateTerminalOriginal(RuntimeBindingRecord binding);

    Map<String, Object> recoveryProviderRequest(RuntimeBindingRecord binding);
}
