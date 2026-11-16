package com.alibaba.qwen.code.runtimebroker.spi;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity;
import com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;
public interface KubernetesMaintenanceClient extends KubernetesRuntimeClient {
    ResidentReclamation.Baseline reclamationBaseline(
            RuntimeBindingRecord original,
            ManagedAgentSettings.RuntimeBroker.ResidentWorkspace selected,
            String finalizer, Instant now);
    ResidentReclamation.Receipt reclamationReceipt(
            RuntimeBindingRecord original,
            ManagedAgentSettings.RuntimeBroker.ResidentWorkspace selected,
            ResidentReclamation.Baseline baseline,
            Map<String, Object> pod, Instant now);

    record DeleteResponse(int status, byte[] body, boolean complete) { }
    CompletionStage<Void> verifyProtection(
            WorkspaceCsiRegistration registration,
            ProtectionIdentity protection);
    CompletionStage<Map<String, Object>> get(String resource, String namespace, String name);
    CompletionStage<Map<String, Object>> getCluster(String resource, String name);
    CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body);
    CompletionStage<DeleteResponse> deletePod(String namespace, String podName, byte[] deleteOptions);
    CompletionStage<DeleteResponse> patchPodFinalizers(String namespace, String podName, byte[] patch);
    CompletionStage<Map<String, Object>> getNodeLease(String nodeName);
    CompletionStage<List<Map<String, Object>>> listPersistentVolumes();
    CompletionStage<List<Map<String, Object>>> listVolumeAttachments();
    CompletionStage<List<Map<String, Object>>> listPods(String namespace);
}
