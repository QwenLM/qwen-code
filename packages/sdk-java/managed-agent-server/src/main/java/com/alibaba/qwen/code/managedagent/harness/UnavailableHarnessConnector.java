package com.alibaba.qwen.code.managedagent.harness;

import java.util.List;
import java.util.Map;

public class UnavailableHarnessConnector implements HarnessConnector {
    @Override
    public boolean isAvailable() {
        return false;
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting) {
        throw unavailable();
    }

    @Override
    public Admission submit(String tenantId, String sessionId,
            String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        throw unavailable();
    }

    @Override
    public SourceStream stream(String tenantId, String sessionId,
            long lastEventId,
            String eventEpoch) {
        throw unavailable();
    }

    @Override
    public void cancel(String tenantId, String sessionId) {
        throw unavailable();
    }

    @Override
    public void rename(String tenantId, String sessionId, String title) {
        throw unavailable();
    }

    @Override
    public void closeSession(String tenantId, String sessionId) {
        throw unavailable();
    }

    private static IllegalStateException unavailable() {
        return new IllegalStateException("Hosted Harness is disabled");
    }
}
