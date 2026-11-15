package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHoldFamily;

import java.util.Map;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.referenceString;

/**
 * Admits the durable ledger row of a background process (a Shell, a Monitor
 * watch, or a user terminal) on behalf of {@link RuntimeBrokerService}.
 */
final class BackgroundProcessAdmission {
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;

    BackgroundProcessAdmission(RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository) {
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
    }

    // H3: the background process (or Monitor watch) is its own ledger row,
    // admitted at start, carrying no model result and staying non-terminal
    // until physical proof — that is what `hasActiveBy*` counts while it
    // lives.
    void admit(SessionContext context, ToolExecutionRecord invocation,
            ManagedHoldFamily family) {
        context.lock();
        try {
            Map<String, Object> invocationReference = invocation.getReference();
            String callId = referenceString(invocationReference, "callId");
            Map<String, Object> reference = Map.of(
                    "dispatchMode", family.dispatchMode(),
                    "processOf", invocation.getExecutionCallId(),
                    "sessionId", referenceString(invocationReference, "sessionId"),
                    "promptId", referenceString(invocationReference, "promptId"),
                    "callId", callId,
                    "argsDigest", invocation.getRequestDigest());
            ToolExecutionRecord candidate = ToolExecutionRecord.prepared(
                    invocation.getExecutionCallId() + ":process",
                    invocation.getExecutionCallId() + ":process",
                    invocation.getBindingId(),
                    invocation.getRuntimeGeneration(),
                    invocation.getHarnessSessionId(),
                    invocation.getRuntimeSessionId(),
                    referenceString(invocationReference, "promptId"),
                    callId,
                    invocation.getRequestDigest(),
                    reference);
            try {
                bindingRepository.admitExecution(sessionRepository,
                        executionRepository, candidate);
            } catch (IllegalArgumentException exception) {
                throw conflict("runtime_execution_conflict",
                        "background process identity is already in use", exception);
            }
            context.backgroundProcesses().add(candidate.getExecutionCallId());
        } finally {
            context.unlock();
        }
    }
}
