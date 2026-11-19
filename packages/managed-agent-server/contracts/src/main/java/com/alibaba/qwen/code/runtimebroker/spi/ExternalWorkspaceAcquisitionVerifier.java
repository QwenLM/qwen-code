package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.util.concurrent.CompletionStage;

/** Verifies a saved external Workspace original before it is claimed for execution. */
public interface ExternalWorkspaceAcquisitionVerifier {
    CompletionStage<Void> verifyAcquisition(RuntimeBindingRecord binding);
}
