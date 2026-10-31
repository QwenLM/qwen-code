package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/** Converts SDK failures at the adapter boundary, including deferred stream reads. */
public final class SdkHarnessBoundary implements HarnessConnector {
    private final HarnessConnector delegate;

    public SdkHarnessBoundary(HarnessConnector delegate) {
        this.delegate = delegate;
    }

    @Override
    public boolean isAvailable() {
        return call(delegate::isAvailable);
    }

    @Override
    public void recoverForWake(String tenantId, String sessionId) {
        run(() -> delegate.recoverForWake(tenantId, sessionId));
    }

    @Override
    public boolean supportsPublicChildAgents() {
        return call(delegate::supportsPublicChildAgents);
    }

    @Override
    public String closeSession(OperationRecord operation) {
        return call(() -> delegate.closeSession(operation));
    }

    @Override
    public void runLifecycleChildOperation(OperationRecord operation, Map<String, Object> body) {
        run(() -> delegate.runLifecycleChildOperation(operation, body));
    }

    @Override
    public Map<String, Object> drainInstance(String instanceId, String operationId) {
        return call(() -> delegate.drainInstance(instanceId, operationId));
    }

    @Override
    public Map<String, Object> releaseOwnership(String tenantId, String sessionId,
            String operationId, long expectedPlacementEpoch) {
        return call(() -> delegate.releaseOwnership(tenantId, sessionId, operationId, expectedPlacementEpoch));
    }

    @Override
    public boolean supportsApprovalSelection() {
        return call(delegate::supportsApprovalSelection);
    }

    @Override
    public boolean supportsLiveApprovalSelection() {
        return call(delegate::supportsLiveApprovalSelection);
    }

    @Override
    public boolean supportsAutoApproval() {
        return call(delegate::supportsAutoApproval);
    }

    @Override
    public boolean supportsPermissionRules() {
        return call(delegate::supportsPermissionRules);
    }

    @Override
    public boolean supportsAgentDefinitionApprovalSelection() {
        return call(delegate::supportsAgentDefinitionApprovalSelection);
    }

    @Override
    public boolean supportsModelSelection() {
        return call(delegate::supportsModelSelection);
    }

    @Override
    public boolean supportsUserMessageQueue() {
        return call(delegate::supportsUserMessageQueue);
    }

    @Override
    public boolean supportsContextCompression() {
        return call(delegate::supportsContextCompression);
    }

    @Override
    public ContextCompressionSubmission prepareContextCompression(String tenantId, String sessionId,
            Map<String, Object> body) {
        return call(() -> {
            var prepared = delegate.prepareContextCompression(tenantId, sessionId, body);
            return () -> call(prepared::submit);
        });
    }

    @Override
    public Map<String, Object> runContextCompression(String tenantId, String sessionId,
            Map<String, Object> body) {
        return call(() -> delegate.runContextCompression(tenantId, sessionId, body));
    }

    @Override
    public Map<String, Object> readContextCompression(String tenantId, String sessionId,
            String operationId) {
        return call(() -> delegate.readContextCompression(tenantId, sessionId, operationId));
    }

    @Override
    public boolean supportsPlanMode() {
        return call(delegate::supportsPlanMode);
    }

    @Override
    public boolean supportsInputAttachments() {
        return call(delegate::supportsInputAttachments);
    }

    @Override
    public boolean supportsSessionSkills() {
        return call(delegate::supportsSessionSkills);
    }

    @Override
    public boolean supportsMcpManagement() {
        return call(delegate::supportsMcpManagement);
    }

    @Override
    public Map<String, Object> mcpManagement(String tenantId, String sessionId) {
        return call(() -> delegate.mcpManagement(tenantId, sessionId));
    }

    @Override
    public Map<String, Object> manageMcp(String tenantId, String sessionId, Map<String, Object> command) {
        return call(() -> delegate.manageMcp(tenantId, sessionId, command));
    }

    @Override
    public Map<String, Object> mcpManagementOperation(String tenantId, String sessionId, String operationId) {
        return call(() -> delegate.mcpManagementOperation(tenantId, sessionId, operationId));
    }

    @Override
    public boolean supportsSessionExtensions() {
        return call(delegate::supportsSessionExtensions);
    }

    @Override
    public Map<String, Object> applyExtensions(String tenantId, String sessionId, Map<String, Object> command) {
        return call(() -> delegate.applyExtensions(tenantId, sessionId, command));
    }

    @Override
    public Map<String, Object> continueExtensionOperation(String tenantId, String sessionId, String operationId, boolean recoverPrevious) {
        return call(() -> delegate.continueExtensionOperation(tenantId, sessionId, operationId, recoverPrevious));
    }

    @Override
    public boolean isWorkspaceFilesAvailable() {
        return call(delegate::isWorkspaceFilesAvailable);
    }

    @Override
    public boolean supportsLifecycle() {
        return call(delegate::supportsLifecycle);
    }

    @Override
    public boolean supportsLifecycle(String profile) {
        return call(() -> delegate.supportsLifecycle(profile));
    }

    @Override
    public void prepareLifecycleResources(OperationRecord operation) {
        run(() -> delegate.prepareLifecycleResources(operation));
    }

    @Override
    public void settleLifecycleResources(OperationRecord operation) {
        run(() -> delegate.settleLifecycleResources(operation));
    }

    @Override
    public boolean supportsFencedTitles() {
        return call(delegate::supportsFencedTitles);
    }

    @Override
    public JsonNode settleLifecycle(OperationRecord operation) {
        return call(() -> delegate.settleLifecycle(operation));
    }

    @Override
    public void detachLifecycle(OperationRecord operation) {
        run(() -> delegate.detachLifecycle(operation));
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting) {
        return call(() -> delegate.createOrLoad(tenantId, sessionId, loadExisting));
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting, boolean passiveManagedRuntimeRecovery) {
        return call(() -> delegate.createOrLoad(tenantId, sessionId, loadExisting, passiveManagedRuntimeRecovery));
    }

    @Override
    public Attachment recoverManagedRuntime(String tenantId, String sessionId,
            boolean cancellation) {
        return call(() -> delegate.recoverManagedRuntime(tenantId, sessionId, cancellation));
    }

    @Override
    public Attachment recoverManagedRuntime(String tenantId, String sessionId,
            boolean cancellation, String promptId) {
        return call(() -> delegate.recoverManagedRuntime(tenantId, sessionId, cancellation, promptId));
    }

    @Override
    public Attachment recoverManagedCancellation(String tenantId,
            String sessionId) {
        return call(() -> delegate.recoverManagedCancellation(tenantId, sessionId));
    }

    @Override
    public Attachment recoverManagedCancellation(String tenantId,
            String sessionId, String promptId) {
        return call(() -> delegate.recoverManagedCancellation(tenantId, sessionId, promptId));
    }

    @Override
    public Attachment recoverManagedFailureCancellation(String tenantId,
            String sessionId, String turnId, String dispatchOwner) {
        return call(() -> delegate.recoverManagedFailureCancellation(tenantId, sessionId, turnId, dispatchOwner));
    }

    @Override
    public Attachment recoverManagedFailureCancellation(String tenantId,
            String sessionId, String turnId, String dispatchOwner, String promptId) {
        return call(() -> delegate.recoverManagedFailureCancellation(tenantId, sessionId, turnId, dispatchOwner, promptId));
    }

    @Override
    public void discardManagedRecovery(String tenantId, String sessionId) {
        run(() -> delegate.discardManagedRecovery(tenantId, sessionId));
    }

    @Override
    public RecoveryStatus inspectRecovery(String tenantId, String sessionId, String promptId) {
        return call(() -> delegate.inspectRecovery(tenantId, sessionId, promptId));
    }

    @Override
    public Attachment cachedRecoveryAttachment(String tenantId, String sessionId) {
        return call(() -> delegate.cachedRecoveryAttachment(tenantId, sessionId));
    }

    @Override
    public boolean recheckRecoveryCleanup(String tenantId, String sessionId, String promptId) {
        return call(() -> delegate.recheckRecoveryCleanup(tenantId, sessionId, promptId));
    }

    @Override
    public Admission submit(String tenantId, String sessionId, String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        return call(() -> delegate.submit(tenantId, sessionId, promptId, input, payloadDigest));
    }

    @Override
    public Admission continueManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        return call(() -> delegate.continueManagedRuntime(tenantId, sessionId, promptId, checkpointId, activationId));
    }

    @Override
    public Admission cancelManagedRuntime(String tenantId, String sessionId,
            String promptId, String checkpointId, String activationId) {
        return call(() -> delegate.cancelManagedRuntime(tenantId, sessionId, promptId, checkpointId, activationId));
    }

    @Override
    public SourceStream stream(String tenantId, String sessionId, long lastEventId,
            String eventEpoch) {
        return call(() -> streamBoundary(delegate.stream(tenantId, sessionId, lastEventId, eventEpoch)));
    }

    @Override
    public SourceStream observeStream(String tenantId, String sessionId, String bootId,
            long lastEventId, String eventEpoch) {
        return call(() -> streamBoundary(delegate.observeStream(tenantId, sessionId, bootId, lastEventId, eventEpoch)));
    }

    @Override
    public void resolveAction(
            String tenantId,
            String sessionId,
            String actionId,
            JsonNode response) {
        run(() -> delegate.resolveAction(tenantId, sessionId, actionId, response));
    }

    @Override
    public void cancel(String tenantId, String sessionId) {
        run(() -> delegate.cancel(tenantId, sessionId));
    }

    @Override
    public void cancelOriginalTurn(String tenantId, String sessionId, String promptId) {
        run(() -> delegate.cancelOriginalTurn(tenantId, sessionId, promptId));
    }

    @Override
    public Map<String, Object> runAutomationOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        return call(() -> delegate.runAutomationOperation(tenantId, sessionId, body));
    }

    @Override
    public void runChildOperation(String tenantId, String sessionId,
            Map<String, Object> body) {
        run(() -> delegate.runChildOperation(tenantId, sessionId, body));
    }

    @Override
    public Map<String, Object> runMessageOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        return call(() -> delegate.runMessageOperation(tenantId, sessionId, body));
    }

    @Override
    public Map<String, Object> runChannelOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        return call(() -> delegate.runChannelOperation(tenantId, sessionId, body));
    }

    @Override
    public void rename(String tenantId, String sessionId, String title) {
        run(() -> delegate.rename(tenantId, sessionId, title));
    }

    @Override
    public void rename(String tenantId, String sessionId, String title, long revision) {
        run(() -> delegate.rename(tenantId, sessionId, title, revision));
    }

    @Override
    public String closeSession(String tenantId, String sessionId) {
        return call(() -> delegate.closeSession(tenantId, sessionId));
    }

    @Override
    public List<AttachedSession> attachedSessions() {
        return call(delegate::attachedSessions);
    }

    @Override
    public String writerIdentity() {
        return call(delegate::writerIdentity);
    }

    @Override
    public boolean activateForWake(String tenantId, String sessionId) {
        return call(() -> delegate.activateForWake(tenantId, sessionId));
    }

    @Override
    public void close() {
        run(delegate::close);
    }

    private static <T> T call(Supplier<T> operation) {
        try {
            return operation.get();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    private static void run(Runnable operation) {
        try {
            operation.run();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    private static SourceStream streamBoundary(SourceStream stream) {
        return new SourceStream() {
            @Override
            public String eventEpoch() {
                return call(stream::eventEpoch);
            }

            @Override
            public SourceEvent next() {
                return call(stream::next);
            }

            @Override
            public boolean recoveryBlocked(long afterEventId) {
                return call(() -> stream.recoveryBlocked(afterEventId));
            }

            @Override
            public void close() {
                run(stream::close);
            }
        };
    }
}
