package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeLease;

import java.net.URI;
import java.util.Map;

public interface SshConnections extends AutoCloseable {
    public Map<String, Object> bootstrap(SshRuntimeNode node, Map<String, Object> fields);

    public Map<String, Object> upload(SshRuntimeNode node, Map<String, Object> fields);

    public void register(RuntimeLease lease, SshRuntimeNode node);

    public void registerDirect(RuntimeLease lease);

    public URI resolveEndpoint(RuntimeLease lease);

    public URI publicationEndpoint(SshRuntimeNode node);

    public void forget(RuntimeLease lease);

    public void close();
}
