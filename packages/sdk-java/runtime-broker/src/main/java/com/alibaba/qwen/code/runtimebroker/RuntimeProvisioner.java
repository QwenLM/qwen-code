package com.alibaba.qwen.code.runtimebroker;

import java.util.concurrent.CompletionStage;

/** Starts or reuses one Runtime while honoring the scope isolation class. */
@FunctionalInterface
public interface RuntimeProvisioner {
    CompletionStage<RuntimeLease> provision(RuntimeScope scope);
}
