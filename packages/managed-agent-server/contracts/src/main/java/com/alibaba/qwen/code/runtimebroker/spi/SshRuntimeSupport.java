package com.alibaba.qwen.code.runtimebroker.spi;

import java.net.URI;

public interface SshRuntimeSupport {
    public SshConnections createConnections(URI publicationEndpoint);
}
