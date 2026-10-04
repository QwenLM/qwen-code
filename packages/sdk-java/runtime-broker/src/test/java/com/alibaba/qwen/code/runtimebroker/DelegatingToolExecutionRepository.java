package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Pass-through {@link ToolExecutionRepository} base for test doubles, so a
 * double only overrides the calls it instruments. New interface methods land
 * here once instead of in every double.
 */
abstract class DelegatingToolExecutionRepository
        implements ToolExecutionRepository {
    protected final ToolExecutionRepository delegate;

    DelegatingToolExecutionRepository(ToolExecutionRepository delegate) {
        this.delegate = delegate;
    }

    @Override
    public ToolExecutionRecord findOrCreate(ToolExecutionRecord candidate) {
        return delegate.findOrCreate(candidate);
    }

    @Override
    public ToolExecutionRecord findByExecutionCallId(String executionCallId) {
        return delegate.findByExecutionCallId(executionCallId);
    }

    @Override
    public ToolExecutionRecord findByIdempotencyKey(String idempotencyKey) {
        return delegate.findByIdempotencyKey(idempotencyKey);
    }

    @Override
    public ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner,
            long dispatchGeneration) {
        return delegate.compareAndSet(expected, replacement, owner,
                dispatchGeneration);
    }

    @Override
    public ToolExecutionRecord claimDispatch(String executionCallId,
            String owner, Duration leaseDuration) {
        return delegate.claimDispatch(executionCallId, owner, leaseDuration);
    }

    @Override
    public ToolExecutionRecord renewDispatch(String executionCallId,
            String owner, long dispatchGeneration, Duration leaseDuration) {
        return delegate.renewDispatch(executionCallId, owner,
                dispatchGeneration, leaseDuration);
    }

    @Override
    public ToolExecutionRecord requestCancel(String executionCallId,
            long expectedVersion) {
        return delegate.requestCancel(executionCallId, expectedVersion);
    }

    @Override
    public ToolExecutionRecord resolveUnknown(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return delegate.resolveUnknown(expected, resolutionResult,
                resolutionTime);
    }

    @Override
    public ToolExecutionRecord resolveUnsettled(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return delegate.resolveUnsettled(expected, resolutionResult,
                resolutionTime);
    }

    @Override
    public List<ToolExecutionRecord> findUnsettled(
            RuntimeSessionRecord session, String afterExecutionCallId,
            int limit) {
        return delegate.findUnsettled(session, afterExecutionCallId, limit);
    }

    @Override
    public boolean hasActiveByRuntimeSession(String runtimeSessionId) {
        return delegate.hasActiveByRuntimeSession(runtimeSessionId);
    }

    @Override
    public boolean hasActiveByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId) {
        return delegate.hasActiveByRuntimeSession(bindingId,
                runtimeGeneration, runtimeSessionId);
    }

    @Override
    public boolean hasActiveByBinding(String bindingId,
            long runtimeGeneration) {
        return delegate.hasActiveByBinding(bindingId, runtimeGeneration);
    }
}
