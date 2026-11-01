package com.alibaba.qwen.code.runtimebroker.spi;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;
public interface KubernetesMaintenanceClient extends KubernetesRuntimeClient {
    com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation.Baseline reclamationBaseline(
            com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord original,
            com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace selected,
            String finalizer, java.time.Instant now);
    com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation.Receipt reclamationReceipt(
            com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord original,
            com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace selected,
            com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation.Baseline baseline,
            Map<String, Object> pod, java.time.Instant now);

    record DeleteResponse(int status, byte[] body, boolean complete) { }
    java.util.concurrent.CompletionStage<Void> verifyProtection(
            com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration registration,
            com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity protection);
    CompletionStage<Map<String, Object>> get(String resource, String namespace, String name);
    CompletionStage<Map<String, Object>> getCluster(String resource, String name);
    CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body);
    CompletionStage<DeleteResponse> deletePod(String namespace, String podName, byte[] deleteOptions);
    CompletionStage<DeleteResponse> patchPodFinalizers(String namespace, String podName, byte[] patch);
    CompletionStage<Map<String, Object>> getNodeLease(String nodeName);
    CompletionStage<List<Map<String, Object>>> listPersistentVolumes();
    CompletionStage<List<Map<String, Object>>> listVolumeAttachments();
    CompletionStage<List<Map<String, Object>>> listPods(String namespace);
    CompletionStage<String> readCsiPodLog(String podName);
}
