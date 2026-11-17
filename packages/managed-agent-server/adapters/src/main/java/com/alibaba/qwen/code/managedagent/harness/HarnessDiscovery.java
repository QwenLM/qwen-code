package com.alibaba.qwen.code.managedagent.harness;

import java.net.URI;
import java.util.List;

public interface HarnessDiscovery extends AutoCloseable {
    Snapshot snapshot();

    @Override
    default void close() {
    }

    record Endpoint(String instanceId, URI baseUri, boolean accepting) {
    }

    record Snapshot(List<Endpoint> endpoints, boolean current) {
        public Snapshot {
            endpoints = List.copyOf(endpoints);
        }
    }
}
