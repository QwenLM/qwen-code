package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.Map;
import java.util.concurrent.CompletionStage;

public interface WorkspacePhysicalTransport extends RuntimeTransport {
    public interface ExtensionPreparation {
        CompletionStage<Map<String, Object>> prepare(RuntimeBindingRecord runtime, String harnessSessionId,
                Map<String, Object> operation);
    }

    void configureExtensionPreparation(ExtensionPreparation preparation);
    CompletionStage<Map<String, Object>> installExtensionPackage(RuntimeBindingRecord runtime, String digest, java.nio.file.Path archive);

    public CompletionStage<Map<String, Object>> extensionControl(RuntimeBindingRecord runtime, String harnessSessionId,
            ContextBinding binding, Map<String, Object> operation);

    public CompletionStage<Void> activateWorkspace(RuntimeBindingRecord runtime,
            RuntimeSessionRecord sessionRecord, ContextBinding binding, boolean active);

    public CompletionStage<Void> installPublisherV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> publisher);

    public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> capture);
}
