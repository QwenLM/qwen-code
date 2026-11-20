package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

public interface WorkspacePhysicalTransport extends RuntimeTransport {
    public interface ExtensionPreparation {
        CompletionStage<Map<String, Object>> prepare(RuntimeBindingRecord runtime, String harnessSessionId,
                Map<String, Object> operation);
    }

    void configureExtensionPreparation(ExtensionPreparation preparation);
    CompletionStage<Map<String, Object>> installExtensionPackage(RuntimeBindingRecord runtime, String digest, Path archive);

    public CompletionStage<Map<String, Object>> extensionControl(RuntimeBindingRecord runtime, String harnessSessionId,
            ContextBinding binding, Map<String, Object> operation);

    public CompletionStage<Void> activateWorkspace(RuntimeBindingRecord runtime,
            RuntimeSessionRecord sessionRecord, ContextBinding binding, boolean active);

    public CompletionStage<Map<String, Object>> installPublisherV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> publisher, Long writerGeneration);

    public default CompletionStage<Void> detachPublisherV3(
            RuntimeLease lease, RuntimeSession session, Long writerGeneration) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_publisher_detach_unsupported",
                "Runtime transport does not support Shell publisher detach.", false));
    }

    public default CompletionStage<Map<String, Object>> pullObservationsV3(
            RuntimeLease lease, String executionCallId, long afterSeq,
            long ackThrough, int waitMs, int maxEntries) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_observation_pull_unsupported",
                "Runtime transport does not support observation pull.", false));
    }

    public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> capture);
}
