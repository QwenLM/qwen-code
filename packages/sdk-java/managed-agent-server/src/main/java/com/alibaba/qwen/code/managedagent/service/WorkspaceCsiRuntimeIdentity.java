package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.util.Map;

/** @deprecated Use the shared runtime-broker identity reader. */
@Deprecated
public final class WorkspaceCsiRuntimeIdentity {
    private WorkspaceCsiRuntimeIdentity() { }

    public static void verify(RuntimeBindingRecord binding) {
        com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.verify(binding);
    }

    public static Map<String, Object> boot(RuntimeBindingRecord binding) {
        return com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.boot(binding);
    }

    public static Map<String, Object> expectedPod(RuntimeBindingRecord binding) {
        return com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.expectedPod(binding);
    }
}
