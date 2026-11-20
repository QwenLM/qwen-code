package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeToolMeasurements;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.protocol.ProviderRuntimeProtocol;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.externalShellNoStartAnswer;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isPublicationV3;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isV3Family;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.sshNoStartReceipt;

/**
 * The persisted-Tool acknowledgement the drain and the dispatch share, split out
 * of the dispatcher along the acknowledgement seam. Each lane proves its own
 * result shape first, then the Session owner, before the worker is asked to
 * release anything: an unproven result must keep the close refusing rather than
 * acknowledging bytes the control plane cannot show.
 */
final class RuntimeToolAcknowledgements {
    private final RuntimeSessionRepository sessionRepository;
    private final RuntimeTransport transport;

    RuntimeToolAcknowledgements(RuntimeSessionRepository sessionRepository,
            RuntimeTransport transport) {
        this.sessionRepository = sessionRepository;
        this.transport = transport;
    }

    CompletionStage<Void> acknowledgePersistedTools(RuntimeBindingRecord binding, ToolExecutionRecord execution) {
        boolean external = WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest());
        boolean externalShell = WorkspaceExecutionProfile.isExternalShellRequest(binding.getRequest());
        if (external && !externalShell && (!execution.isSettled() || execution.getResult() == null
                || execution.getResult().containsKey("capture")
                || !execution.getReference().keySet().equals(
                        Set.of("sessionId", "promptId", "callId", "argsDigest", "dispatchMode"))
                || !"deferred".equals(execution.getReference().get("dispatchMode")))) {
            return failed(conflict("workspace_close_identity_unverified", "External drain requires settled file Tool v2 results"));
        }
        if (externalShell && (!execution.isSettled() || execution.getResult() == null
                || !externalShellNoStartAnswer(execution.getResult())
                        && !isPublicationV3(execution.getReference()))) {
            return failed(conflict("workspace_close_identity_unverified",
                    "External Shell drain requires a settled Tool v3 result"));
        }
        if ((!RuntimeProviderKinds.SSH_PROCESS.equals(binding.getRequest().getProvisionerKind())
                        && !RuntimeToolMeasurements.selected(execution.getReference()) && !external)
                || !execution.isSettled() || execution.getResult() == null
                || ProviderRuntimeProtocol.isReference(execution.getReference())) {
            return CompletableFuture.completedFuture(null);
        }
        Map<String, Object> noStart = sshNoStartReceipt(binding, execution);
        if (noStart == null && (execution.getResult().containsKey("capture")
                || isV3Family(execution.getReference()))) {
            return CompletableFuture.completedFuture(null);
        }
        RuntimeSessionRecord session = sessionRepository.findById(binding.getRequest().getScope(),
                execution.getRuntimeSessionId());
        if (binding.getLease() == null || session == null || !execution.belongsTo(session)
                || !binding.getBindingId().equals(execution.getBindingId())
                || binding.getGeneration() != execution.getRuntimeGeneration()
                || !binding.getRequest().getScope().equals(session.getSession().getScope())
                // Shared workspace bindings carry no session isolation key; ownership
                // there rests on belongsTo + bindingId + generation + scope above, the
                // same shape acquireRecovery uses (#16023 R1-25).
                || !com.alibaba.qwen.code.runtimebroker.HarnessOwnership.sharesRuntimeSessions(binding.getRequest())
                        && !execution.getHarnessSessionId().equals(binding.getRequest().getIsolationKey())) {
            return failed(conflict("workspace_close_identity_unverified", "Persisted Tool ownership conflicts"));
        }
        if (noStart != null) {
            CompletionStage<Map<String, Object>> acknowledgement = isPublicationV3(execution.getReference())
                    ? transport.acknowledgeV3(binding.getLease(), session.getSession(), execution.getReference(), noStart)
                    : transport.acknowledge(binding.getLease(), session.getSession(), execution.getReference(), noStart);
            return acknowledgement.thenAccept(answer -> {
                if (answer == null || !Set.of("settled", "unknown").contains(answer.get("state"))) {
                    throw conflict("runtime_execution_conflict", "Original Runtime did not confirm the no-start acknowledgement");
                }
            });
        }
        var original = session.getSession();
        var authority = binding.getRequest().getScope().getLifecycleAuthority();
        if (external && authority != null) {
            original = new RuntimeSession(original.getHarnessSessionId(), original.getRuntimeSessionId(),
                    original.getTurnKind(), original.getScope().withLifecycleAuthority(authority));
        }
        return RuntimeToolMeasurements.selected(
                        execution.getReference())
                ? transport.acknowledgeV4(
                        binding.getLease(),
                        original,
                        execution.getReference(),
                        execution.getResult(),
                        null)
                : transport.acknowledgeV2(binding.getLease(), original, execution.getReference());
    }
}
