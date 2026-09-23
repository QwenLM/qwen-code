package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import java.util.List;
import java.util.Map;

public interface HarnessConnector extends AutoCloseable {
    boolean isAvailable();

    Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting);

    Admission submit(String tenantId, String sessionId, String promptId,
            List<Map<String, Object>> input, String payloadDigest);

    default Admission continueManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        throw new UnsupportedOperationException(
                "Managed Runtime continuation is unavailable");
    }

    SourceStream stream(String tenantId, String sessionId, long lastEventId,
            String eventEpoch);

    void cancel(String tenantId, String sessionId);

    void rename(String tenantId, String sessionId, String title);

    void closeSession(String tenantId, String sessionId);

    @Override
    default void close() {
    }

    record Attachment(String bootId, HarnessRuntimeRecovery runtimeRecovery,
            Long lastEventId, String eventEpoch) {
        public Attachment(String bootId) {
            this(bootId, null, null, null);
        }

        public Attachment(String bootId,
                HarnessRuntimeRecovery runtimeRecovery) {
            this(bootId, runtimeRecovery, null, null);
        }
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
