package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;

/** Explicit operator evidence operations, unavailable on ordinary provider implementations. */
public interface OperatorRuntimeRecovery extends RuntimeProvisioner {
    public void verifyOperatorRegistration(RuntimeBindingRecord binding);

    public RuntimeObservation attestOperatorStop(RuntimeBindingRecord binding, String recoveryId);
}
