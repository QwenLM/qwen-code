package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;

/** Converts SDK failures at the adapter boundary, including deferred stream reads. */
public final class SdkHarnessBoundary implements HarnessConnector {
    private final HarnessConnector delegate;

    public SdkHarnessBoundary(HarnessConnector delegate) {
        this.delegate = delegate;
    }

    @Override
    public boolean isAvailable() {
        try {
            return delegate.isAvailable();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void recoverForWake(String tenantId, String sessionId) {
        try {
            delegate.recoverForWake(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsPublicChildAgents() {
        try {
            return delegate.supportsPublicChildAgents();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public String closeSession(OperationRecord operation) {
        try {
            return delegate.closeSession(operation);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void runLifecycleChildOperation(OperationRecord operation, Map<String, Object> body) {
        try {
            delegate.runLifecycleChildOperation(operation, body);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> drainInstance(String instanceId, String operationId) {
        try {
            return delegate.drainInstance(instanceId, operationId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> releaseOwnership(String tenantId, String sessionId,
            String operationId, long expectedPlacementEpoch) {
        try {
            return delegate.releaseOwnership(tenantId, sessionId, operationId, expectedPlacementEpoch);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsApprovalSelection() {
        try {
            return delegate.supportsApprovalSelection();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsLiveApprovalSelection() {
        try {
            return delegate.supportsLiveApprovalSelection();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsAutoApproval() {
        try {
            return delegate.supportsAutoApproval();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsPermissionRules() {
        try {
            return delegate.supportsPermissionRules();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsAgentDefinitionApprovalSelection() {
        try {
            return delegate.supportsAgentDefinitionApprovalSelection();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsModelSelection() {
        try {
            return delegate.supportsModelSelection();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsUserMessageQueue() {
        try {
            return delegate.supportsUserMessageQueue();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsContextCompression() {
        try {
            return delegate.supportsContextCompression();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public ContextCompressionSubmission prepareContextCompression(String tenantId, String sessionId,
            Map<String, Object> body) {
        try {
            var prepared = delegate.prepareContextCompression(tenantId, sessionId, body);
            return () -> {
                try {
                    return prepared.submit();
                } catch (RuntimeException error) {
                    throw HarnessSdkValues.runtime(error);
                }
            };
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> runContextCompression(String tenantId, String sessionId,
            Map<String, Object> body) {
        try {
            return delegate.runContextCompression(tenantId, sessionId, body);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> readContextCompression(String tenantId, String sessionId,
            String operationId) {
        try {
            return delegate.readContextCompression(tenantId, sessionId, operationId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsPlanMode() {
        try {
            return delegate.supportsPlanMode();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsInputAttachments() {
        try {
            return delegate.supportsInputAttachments();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsSessionSkills() {
        try {
            return delegate.supportsSessionSkills();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsMcpManagement() {
        try {
            return delegate.supportsMcpManagement();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> mcpManagement(String tenantId, String sessionId) {
        try {
            return delegate.mcpManagement(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> manageMcp(String tenantId, String sessionId, Map<String, Object> command) {
        try {
            return delegate.manageMcp(tenantId, sessionId, command);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> mcpManagementOperation(String tenantId, String sessionId, String operationId) {
        try {
            return delegate.mcpManagementOperation(tenantId, sessionId, operationId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsSessionExtensions() {
        try {
            return delegate.supportsSessionExtensions();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> applyExtensions(String tenantId, String sessionId, Map<String, Object> command) {
        try {
            return delegate.applyExtensions(tenantId, sessionId, command);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> continueExtensionOperation(String tenantId, String sessionId, String operationId, boolean recoverPrevious) {
        try {
            return delegate.continueExtensionOperation(tenantId, sessionId, operationId, recoverPrevious);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean isWorkspaceFilesAvailable() {
        try {
            return delegate.isWorkspaceFilesAvailable();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsLifecycle() {
        try {
            return delegate.supportsLifecycle();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsLifecycle(String profile) {
        try {
            return delegate.supportsLifecycle(profile);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void prepareLifecycleResources(com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord operation) {
        try {
            delegate.prepareLifecycleResources(operation);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void settleLifecycleResources(com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord operation) {
        try {
            delegate.settleLifecycleResources(operation);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean supportsFencedTitles() {
        try {
            return delegate.supportsFencedTitles();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public JsonNode settleLifecycle(com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord operation) {
        try {
            return delegate.settleLifecycle(operation);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void detachLifecycle(com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord operation) {
        try {
            delegate.detachLifecycle(operation);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting) {
        try {
            return delegate.createOrLoad(tenantId, sessionId, loadExisting);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting, boolean passiveManagedRuntimeRecovery) {
        try {
            return delegate.createOrLoad(tenantId, sessionId, loadExisting, passiveManagedRuntimeRecovery);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment recoverManagedRuntime(String tenantId, String sessionId,
            boolean cancellation) {
        try {
            return delegate.recoverManagedRuntime(tenantId, sessionId, cancellation);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment recoverManagedRuntime(String tenantId, String sessionId,
            boolean cancellation, String promptId) {
        try {
            return delegate.recoverManagedRuntime(tenantId, sessionId, cancellation, promptId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment recoverManagedCancellation(String tenantId,
            String sessionId) {
        try {
            return delegate.recoverManagedCancellation(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment recoverManagedCancellation(String tenantId,
            String sessionId, String promptId) {
        try {
            return delegate.recoverManagedCancellation(tenantId, sessionId, promptId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment recoverManagedFailureCancellation(String tenantId,
            String sessionId, String turnId, String dispatchOwner) {
        try {
            return delegate.recoverManagedFailureCancellation(tenantId, sessionId, turnId, dispatchOwner);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment recoverManagedFailureCancellation(String tenantId,
            String sessionId, String turnId, String dispatchOwner, String promptId) {
        try {
            return delegate.recoverManagedFailureCancellation(tenantId, sessionId, turnId, dispatchOwner, promptId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void discardManagedRecovery(String tenantId, String sessionId) {
        try {
            delegate.discardManagedRecovery(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public RecoveryStatus inspectRecovery(String tenantId, String sessionId, String promptId) {
        try {
            return delegate.inspectRecovery(tenantId, sessionId, promptId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Attachment cachedRecoveryAttachment(String tenantId, String sessionId) {
        try {
            return delegate.cachedRecoveryAttachment(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean recheckRecoveryCleanup(String tenantId, String sessionId, String promptId) {
        try {
            return delegate.recheckRecoveryCleanup(tenantId, sessionId, promptId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Admission submit(String tenantId, String sessionId, String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        try {
            return delegate.submit(tenantId, sessionId, promptId, input, payloadDigest);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Admission continueManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        try {
            return delegate.continueManagedRuntime(tenantId, sessionId, promptId, checkpointId, activationId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Admission cancelManagedRuntime(String tenantId, String sessionId,
            String promptId, String checkpointId, String activationId) {
        try {
            return delegate.cancelManagedRuntime(tenantId, sessionId, promptId, checkpointId, activationId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public SourceStream stream(String tenantId, String sessionId, long lastEventId,
            String eventEpoch) {
        try {
            return streamBoundary(delegate.stream(tenantId, sessionId, lastEventId, eventEpoch));
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public SourceStream observeStream(String tenantId, String sessionId, String bootId,
            long lastEventId, String eventEpoch) {
        try {
            return streamBoundary(delegate.observeStream(tenantId, sessionId, bootId, lastEventId, eventEpoch));
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void resolveAction(
            String tenantId,
            String sessionId,
            String actionId,
            JsonNode response) {
        try {
            delegate.resolveAction(tenantId, sessionId, actionId, response);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void cancel(String tenantId, String sessionId) {
        try {
            delegate.cancel(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void cancelOriginalTurn(String tenantId, String sessionId, String promptId) {
        try {
            delegate.cancelOriginalTurn(tenantId, sessionId, promptId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> runAutomationOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        try {
            return delegate.runAutomationOperation(tenantId, sessionId, body);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void runChildOperation(String tenantId, String sessionId,
            Map<String, Object> body) {
        try {
            delegate.runChildOperation(tenantId, sessionId, body);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> runMessageOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        try {
            return delegate.runMessageOperation(tenantId, sessionId, body);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public Map<String, Object> runChannelOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        try {
            return delegate.runChannelOperation(tenantId, sessionId, body);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void rename(String tenantId, String sessionId, String title) {
        try {
            delegate.rename(tenantId, sessionId, title);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void rename(String tenantId, String sessionId, String title, long revision) {
        try {
            delegate.rename(tenantId, sessionId, title, revision);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public String closeSession(String tenantId, String sessionId) {
        try {
            return delegate.closeSession(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public List<AttachedSession> attachedSessions() {
        try {
            return delegate.attachedSessions();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public String writerIdentity() {
        try {
            return delegate.writerIdentity();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public boolean activateForWake(String tenantId, String sessionId) {
        try {
            return delegate.activateForWake(tenantId, sessionId);
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    @Override
    public void close() {
        try {
            delegate.close();
        } catch (RuntimeException error) {
            throw HarnessSdkValues.runtime(error);
        }
    }

    private static SourceStream streamBoundary(SourceStream stream) {
        return new SourceStream() {
            @Override
            public String eventEpoch() {
                try {
                    return stream.eventEpoch();
                } catch (RuntimeException error) {
                    throw HarnessSdkValues.runtime(error);
                }
            }

            @Override
            public SourceEvent next() {
                try {
                    return stream.next();
                } catch (RuntimeException error) {
                    throw HarnessSdkValues.runtime(error);
                }
            }

            @Override
            public boolean recoveryBlocked(long afterEventId) {
                try {
                    return stream.recoveryBlocked(afterEventId);
                } catch (RuntimeException error) {
                    throw HarnessSdkValues.runtime(error);
                }
            }

            @Override
            public void close() {
                try {
                    stream.close();
                } catch (RuntimeException error) {
                    throw HarnessSdkValues.runtime(error);
                }
            }
        };
    }
}
