package com.alibaba.qwen.code.managedagent.harness;

import java.util.List;
import java.util.Map;

public interface HarnessConnector extends AutoCloseable {
    boolean isAvailable();

    Attachment createOrLoad(String harnessSessionId, boolean loadExisting);

    Admission submit(String harnessSessionId, String promptId,
            List<Map<String, Object>> input, String payloadDigest);

    SourceStream stream(String harnessSessionId, long lastEventId,
            String eventEpoch);

    void cancel(String harnessSessionId);

    @Override
    default void close() {
    }

    record Attachment(String bootId) {
    }

    record Admission(long lastEventId, String eventEpoch) {
    }

    record SourceEvent(Long id, String type, Object data, String promptId,
            Map<String, Object> metadata) {
    }

    interface SourceStream extends AutoCloseable {
        String eventEpoch();

        SourceEvent next();

        @Override
        void close();
    }
}
