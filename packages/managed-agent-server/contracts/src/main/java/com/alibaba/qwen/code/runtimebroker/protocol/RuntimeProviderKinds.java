package com.alibaba.qwen.code.runtimebroker.protocol;

import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;

public final class RuntimeProviderKinds {
    public static final String LOCAL_PROCESS = "local-process";
    public static final int LOCAL_PROCESS_CGROUP_HANDLE_VERSION = 3;
    public static final String SSH_PROCESS = "ssh-process";
    public static final String EXTERNAL_SCRATCH = "external-scratch";
    public static final String EXTERNAL_WORKSPACE = "external-workspace";
    private RuntimeProviderKinds() { }

    public static boolean isLocalProcessCgroup(RuntimeResourceHandle handle) {
        return handle != null && LOCAL_PROCESS.equals(handle.getKind())
                && handle.getVersion() == LOCAL_PROCESS_CGROUP_HANDLE_VERSION;
    }
}
