package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.List;

/** Persistence boundary for physical Runtime generations. */
public interface RuntimeBindingRepository {
    RuntimeBindingRecord findOrCreate(RuntimeProvisionRequest request);

    RuntimeBindingRecord findActive(RuntimeProvisionRequest request);

    List<RuntimeBindingRecord> findActiveByIsolationKey(RuntimeScope scope,
            String isolationKey);

    RuntimeBindingRecord findById(String bindingId);

    RuntimeBindingRecord compareAndSet(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement);

    RuntimeBindingRecord claimOperation(String bindingId, String owner,
            Duration leaseDuration);

    RuntimeBindingRecord renewOperation(String bindingId, String owner,
            long operationGeneration, Duration leaseDuration);
}
