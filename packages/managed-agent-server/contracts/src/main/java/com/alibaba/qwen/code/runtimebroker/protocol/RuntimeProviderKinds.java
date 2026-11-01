package com.alibaba.qwen.code.runtimebroker.protocol;

public final class RuntimeProviderKinds {
    public static final String LOCAL_PROCESS = "local-process";
    public static final String SSH_PROCESS = "ssh-process";
    public static final String EXTERNAL_SCRATCH = "external-scratch";
    public static final String EXTERNAL_WORKSPACE = "external-workspace";
    private RuntimeProviderKinds() { }
}
