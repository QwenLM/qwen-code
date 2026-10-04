package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.List;

/**
 * Pass-through {@link RuntimeBindingRepository} base for test doubles, so a
 * double only overrides the calls it instruments. New interface methods land
 * here once instead of in every double.
 */
abstract class DelegatingBindingRepository implements RuntimeBindingRepository {
    protected final RuntimeBindingRepository delegate;

    DelegatingBindingRepository(RuntimeBindingRepository delegate) {
        this.delegate = delegate;
    }

    @Override
    public void requestHarnessDrain(String tenantId, String harnessSessionId) {
        delegate.requestHarnessDrain(tenantId, harnessSessionId);
    }

    @Override
    public boolean isHarnessDraining(String tenantId, String harnessSessionId) {
        return delegate.isHarnessDraining(tenantId, harnessSessionId);
    }

    @Override
    public List<RuntimeBindingRecord> findByHarnessSession(String tenantId,
            String harnessSessionId, String afterBindingId, int limit) {
        return delegate.findByHarnessSession(tenantId, harnessSessionId,
                afterBindingId, limit);
    }

    @Override
    public RuntimeSessionRecord admitSession(RuntimeSessionRepository sessions,
            RuntimeSessionRecord candidate) {
        return delegate.admitSession(sessions, candidate);
    }

    @Override
    public ToolExecutionRecord admitExecution(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord candidate) {
        return delegate.admitExecution(sessions, executions, candidate);
    }

    @Override
    public ToolExecutionRecord authorizeDispatch(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord expected,
            String owner, long generation) {
        return delegate.authorizeDispatch(sessions, executions, expected, owner, generation);
    }

    @Override
    public RuntimeBindingRecord recoverLost(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected) {
        return delegate.recoverLost(sessions, executions, expected);
    }

    @Override
    public RuntimeBindingRecord finishLostRecovery(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected) {
        return delegate.finishLostRecovery(sessions, executions, expected);
    }

    @Override
    public List<RuntimeBindingRecord> findRecoveryCandidates(String provisionerKind,
            String afterBindingId, int limit) {
        return delegate.findRecoveryCandidates(provisionerKind, afterBindingId,
                limit);
    }

    @Override
    public RuntimeSessionRecord completeSessionRelease(
            RuntimeSessionRepository sessions, RuntimeSessionRecord expected) {
        return delegate.completeSessionRelease(sessions, expected);
    }

    @Override
    public RuntimeSessionRecord beginSessionRelease(
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeSessionRecord expected) {
        return delegate.beginSessionRelease(sessions, executions, expected);
    }

    @Override
    public RuntimeBindingRecord findOrCreate(RuntimeProvisionRequest request) {
        return delegate.findOrCreate(request);
    }

    @Override
    public RuntimeBindingRecord findActive(RuntimeProvisionRequest request) {
        return delegate.findActive(request);
    }

    @Override
    public List<RuntimeBindingRecord> findActiveByIsolationKey(RuntimeScope scope,
            String isolationKey) {
        return delegate.findActiveByIsolationKey(scope, isolationKey);
    }

    @Override
    public RuntimeBindingRecord findById(String bindingId) {
        return delegate.findById(bindingId);
    }

    @Override
    public RuntimeBindingRecord compareAndSet(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement) {
        return delegate.compareAndSet(expected, replacement);
    }

    @Override
    public RuntimeBindingRecord claimOperation(String bindingId, String owner,
            Duration leaseDuration) {
        return delegate.claimOperation(bindingId, owner, leaseDuration);
    }

    @Override
    public RuntimeBindingRecord renewOperation(String bindingId, String owner,
            long operationGeneration, Duration leaseDuration) {
        return delegate.renewOperation(bindingId, owner, operationGeneration,
                leaseDuration);
    }

    @Override
    public RuntimeBindingRecord releaseOperation(String bindingId, String owner,
            long operationGeneration) {
        return delegate.releaseOperation(bindingId, owner, operationGeneration);
    }
}
