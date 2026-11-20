package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeScope;

public interface SshRuntimeAccess {
    public SshConnections connections();
    public SshRuntimeNode node(String id);
    public SshRuntimeStorage runtimeStorage(RuntimeScope scope);
}
