package com.alibaba.qwen.code.managedagent.harness;

import java.util.List;
import java.util.Map;

public class UnavailableHarnessConnector implements HarnessConnector {
    @Override
    public boolean isAvailable() {
        return false;
    }

    @Override
    public Attachment createOrLoad(String harnessSessionId,
            boolean loadExisting) {
        throw unavailable();
    }

    @Override
    public Admission submit(String harnessSessionId, String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        throw unavailable();
    }

    @Override
    public SourceStream stream(String harnessSessionId, long lastEventId,
            String eventEpoch) {
        throw unavailable();
    }

    @Override
    public void cancel(String harnessSessionId) {
        throw unavailable();
    }

    private static IllegalStateException unavailable() {
        return new IllegalStateException("Hosted Harness is disabled");
    }
}
