package com.alibaba.qwen.code.managedagent.contracts.artifact;

import com.fasterxml.jackson.databind.JsonNode;

public interface ArtifactReadLease extends AutoCloseable {
    public void requireScope(JsonNode key);
    public void requireScope(String tenant, String session);
    public void check();
    public void checkReadView();

    @Override
    public void close();
}
