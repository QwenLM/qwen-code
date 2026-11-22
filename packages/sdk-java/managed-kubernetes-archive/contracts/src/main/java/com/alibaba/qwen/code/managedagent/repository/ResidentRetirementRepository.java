package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.spi.KubernetesMaintenanceClient;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
public interface ResidentRetirementRepository {
    record Request(
            String tenantId,
            String workspaceId,
            long workspaceGeneration,
            String actorId,
            String retirementId) {
        public Request {
            for (String value : new String[] {tenantId, workspaceId, actorId, retirementId}) {
                require(value != null && !value.isBlank() && value.getBytes(StandardCharsets.UTF_8).length <= 512
                        && value.codePoints().noneMatch(point -> point < 32 || point >= 127 && point <= 159
                                || point >= 0xd800 && point <= 0xdfff));
            }
            require(workspaceGeneration > 0);
        }
    }

    record AttemptStatus(
            int ordinal,
            String resourceVersion,
            String state,
            Integer httpStatus,
            String responseSha256) {}

    record FinalizerAttemptStatus(
            int ordinal,
            String action,
            String resourceVersion,
            String state,
            Integer httpStatus,
            String responseSha256) {}

    record Status(
            String retirementId,
            String state,
            String bindingId,
            long runtimeGeneration,
            List<AttemptStatus> attempts,
            List<FinalizerAttemptStatus> finalizerAttempts,
            Completion completion) {}

    record Completion(String receiptSha256, String dataPolicy, Long releasedRevision) {}

    record Attempt(String workKey, String owner, long generation, byte[] body) {}

    void completeDeletion(Request request, ResidentWorkspace selected, Attempt attempt, KubernetesMaintenanceClient.DeleteResponse response);
    Attempt beginDeletion(Request request, ResidentWorkspace selected, String workKey, String resourceVersion, byte[] body);
    void recordBaseline(Request request, ResidentWorkspace selected, ResidentReclamation.Baseline observed, String finalizer);
    Status release(Request request, ResidentWorkspace selected, ResidentReclamation.Receipt proof);
    void recordCleanup(Request request, ResidentWorkspace selected, ResidentReclamation.Baseline baseline, ResidentReclamation.Receipt observed, RuntimeBindingRecord original);
    void completeFinalizer(Request request, ResidentWorkspace selected, Attempt attempt, KubernetesMaintenanceClient.DeleteResponse reply);
    Attempt beginFinalizer(Request request, ResidentWorkspace selected, RuntimeBindingRecord original, String finalizer, String action, Map<String, Object> metadata, String resourceVersion, byte[] body);
    Status inspect(Request request);
    Status begin(Request request);
    ResidentWorkspace selected(Request request);
    RuntimeBindingRecord original(Request request, ResidentWorkspace selected);
    Map<String, Object> loadState(Request request);
    boolean hasDeletionAttempt(Request request, String workKey);
    boolean hasDeletionAttempts(Request request);
    int planVersion(Request request, Map<String, Object> state);
    ResidentReclamation.Baseline baseline(Map<String, Object> saved);
    ResidentReclamation.Receipt receipt(Map<String, Object> saved, RuntimeBindingRecord original);
    private static void require(boolean valid) {
        if (!valid) {
            throw new RuntimeBrokerException(
                    409,
                    "resident_retirement_unavailable",
                    "Original idle Workspace maintenance is unavailable.",
                    false);
        }
    }
}
