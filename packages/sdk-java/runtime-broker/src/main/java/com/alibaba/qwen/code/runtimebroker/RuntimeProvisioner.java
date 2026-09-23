package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletionStage;

/** Ensures one physical Runtime resource for a claimed placement. */
public interface RuntimeProvisioner {
    /** Retries for the same request must converge on one live resource. */
    CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request);
}
