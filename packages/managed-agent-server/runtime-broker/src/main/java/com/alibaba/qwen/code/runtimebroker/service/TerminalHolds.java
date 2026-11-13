package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.TerminalHoldAdmission;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHoldFamily;
import org.apache.commons.codec.digest.DigestUtils;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapStoreFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;

/**
 * The durable hold lifecycle for one user terminal, on behalf of
 * {@link RuntimeBrokerService}. A terminal is not a model tool call, so its
 * attach invocation is admitted and settled through the never-dispatched
 * evidence path ({@code settlePrepared}) rather than a dispatch claim; the
 * TERMINAL process row admitted beside it holds the Runtime Session until the
 * worker proves the terminal ended, exactly the background Shell/Monitor hold
 * semantics.
 */
final class TerminalHolds {
    /**
     * The turn kind of a terminal's derived Runtime Session. It marks the
     * Session's purpose in the persisted record so the MCP owner page can
     * exclude it: a terminal is a second Runtime Session under the same
     * Harness Session, but never a second MCP owner. Drain and release still
     * enumerate it (they do not filter by turn kind).
     */
    public static final String TERMINAL_TURN_KIND = "terminal";

    private final RuntimeBrokerService broker;
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final Clock clock;
    private final AtomicBoolean closed;

    TerminalHolds(RuntimeBrokerService broker,
            RuntimeBindingRegistry bindingRegistry,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            Clock clock, AtomicBoolean closed) {
        this.broker = broker;
        this.bindingRegistry = bindingRegistry;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.clock = clock;
        this.closed = closed;
    }

    /**
     * Admits the durable hold for one user terminal. Re-admitting the same
     * terminal (a reconnect) returns the existing hold.
     */
    CompletionStage<TerminalHoldAdmission> admit(
            String harnessSessionId, String terminalId) {
        requireOpen(closed);
        String harness = BrokerValues.requirePathSafe(
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
                "harnessSessionId");
        String terminal = BrokerValues.requirePathSafe(
                BrokerValues.requireId(terminalId, "terminalId"), "terminalId");
        // A terminal owns a deterministic Runtime Session of its own, so the
        // relay never has to resolve one. A terminal id is only unique within
        // its Session, but these derived ids are deployment-global ledger keys,
        // so they must fold in the harness Session too — hashed to stay
        // path-safe and within the id bound. The active hold is found through
        // the Runtime Session so a reconnect reuses it, while a re-create after
        // settlement admits a fresh hold instead of handing back a settled one
        // that no longer protects a PTY.
        String terminalKey = DigestUtils.sha256Hex(harness + ":" + terminal);
        String runtime = "terminal-" + terminalKey;
        String baseInvocationId = "terminal-attach:" + terminalKey;
        String baseProcessId = baseInvocationId + ":process";
        return mapStoreFailure(safeStage(() -> {
            ToolExecutionRecord base = executionRepository.findByExecutionCallId(baseProcessId);
            if (base != null) {
                requireTerminalHoldOwner(base, harness, runtime);
            }
            return broker.acquire(harness, runtime, TERMINAL_TURN_KIND, null, null)
                    .thenCompose(ignored -> bindingRegistry.requireReadySession(harness, runtime))
                    .thenApply(context -> {
                        context.lock();
                        try {
                            bindingRegistry.requireReadySessionRecord(context);
                            ToolExecutionRecord baseAgain = executionRepository
                                    .findByExecutionCallId(baseProcessId);
                            if (baseAgain != null) {
                                requireTerminalHoldOwner(baseAgain, harness, runtime);
                            }
                            ToolExecutionRecord active = activeTerminalHold(context);
                            if (active != null) {
                                return new TerminalHoldAdmission(active, false);
                            }
                            // The first attach keeps the deterministic identity;
                            // a re-create after the previous hold settled takes
                            // a fresh one so it never collides with that row.
                            String invocationId = baseAgain == null
                                    ? baseInvocationId
                                    : baseInvocationId + ":" + UUID.randomUUID();
                            String processId = invocationId + ":process";
                            String digest = "sha256:" + DigestUtils.sha256Hex(terminal);
                            // The attach invocation carries the hold dispatch
                            // mode too: it is settled through the never-dispatched
                            // path and has no tool-result projection, so the
                            // lifecycle verifier must recognize it as a hold row
                            // or closing a Session that ever opened a terminal
                            // would be refused as unsettled.
                            Map<String, Object> reference = Map.of(
                                    "sessionId", runtime,
                                    "promptId", harness,
                                    "callId", terminal,
                                    "argsDigest", digest,
                                    "dispatchMode", ManagedHoldFamily.TERMINAL.dispatchMode());
                            ToolExecutionRecord candidate = ToolExecutionRecord.prepared(
                                    invocationId, invocationId,
                                    context.binding().getBindingId(),
                                    context.binding().getGeneration(),
                                    harness, runtime, harness, terminal, digest, reference);
                            ToolExecutionRecord admitted = bindingRepository.admitExecution(
                                    sessionRepository, executionRepository, candidate);
                            Map<String, Object> result = new LinkedHashMap<>();
                            result.put("executionStatus", "success");
                            result.put("responseParts", List.of());
                            result.put("capture", null);
                            executionRepository.settlePrepared(admitted, result, clock.instant());
                            broker.admitBackgroundProcess(context, admitted, ManagedHoldFamily.TERMINAL);
                            ToolExecutionRecord process = executionRepository
                                    .findByExecutionCallId(processId);
                            return new TerminalHoldAdmission(
                                    process == null ? admitted : process, true);
                        } finally {
                            context.unlock();
                        }
                    });
        }));
    }

    /** A terminal id is only unique within its Session; never hand one
     * Session another's hold on a reconnect. */
    private static void requireTerminalHoldOwner(ToolExecutionRecord hold,
            String harnessSessionId, String runtimeSessionId) {
        if (!hold.getHarnessSessionId().equals(harnessSessionId)
                || !hold.getRuntimeSessionId().equals(runtimeSessionId)) {
            throw conflict("runtime_terminal_hold_conflict",
                    "Terminal hold belongs to another Session");
        }
    }

    /** The non-terminal hold of this terminal's dedicated Runtime Session, or
     * null once the previous hold settled. A settled hold no longer protects a
     * re-created PTY, so the caller must admit a fresh one rather than reuse it.
     * The session carries at most one live terminal hold (admission is locked),
     * so the first background row is that hold. */
    private ToolExecutionRecord activeTerminalHold(SessionContext context) {
        RuntimeSessionRecord session = sessionRepository.findById(
                context.session().getScope(), context.session().getRuntimeSessionId());
        if (session == null) {
            return null;
        }
        List<ToolExecutionRecord> rows = executionRepository
                .findBackgroundProcesses(session, null, 100);
        return rows.isEmpty() ? null : rows.get(0);
    }

    CompletionStage<ToolExecutionRecord> abandon(
            String harnessSessionId, String terminalId, String executionCallId) {
        requireOpen(closed);
        String harness = BrokerValues.requirePathSafe(
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
                "harnessSessionId");
        String terminal = BrokerValues.requirePathSafe(
                BrokerValues.requireId(terminalId, "terminalId"), "terminalId");
        String callId = BrokerValues.requireId(executionCallId, "executionCallId");
        String runtime = "terminal-" + DigestUtils.sha256Hex(harness + ":" + terminal);
        return mapStoreFailure(safeStage(() -> broker.acquire(harness, runtime, TERMINAL_TURN_KIND, null, null)
                .thenCompose(ignored -> bindingRegistry.requireReadySession(harness, runtime))
                .thenCompose(context -> {
                    ToolExecutionRecord settled;
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        ToolExecutionRecord active = activeTerminalHold(context);
                        // Only the hold this attach newly admitted may be
                        // discharged. A reconnect reuses a live PTY's hold and
                        // a concurrent attach may own a different one; neither
                        // may be settled by this failed attempt.
                        if (active == null
                                || !active.getExecutionCallId().equals(callId)) {
                            return CompletableFuture.completedFuture(null);
                        }
                        requireTerminalHoldOwner(active, harness, runtime);
                        // The attach never produced a PTY, so there is no exit
                        // to prove; settle the hold directly instead of letting
                        // it wedge on an unknown control answer.
                        Map<String, Object> result = new LinkedHashMap<>();
                        result.put("executionStatus", "success");
                        result.put("responseParts", List.of());
                        result.put("capture", null);
                        settled = executionRepository.settlePrepared(
                                active, result, clock.instant());
                    } finally {
                        context.unlock();
                    }
                    // Leave the terminal's Runtime Session acquirable: after a
                    // transient connect failure the browser retries the same
                    // deterministic id, and a RELEASED row is not re-acquirable.
                    // The Session-close drain owns its eventual release.
                    return CompletableFuture.completedFuture(settled);
                }))).exceptionally(error -> {
                    // A follow-up abandon after the session was released is a
                    // no-op: there is no active hold left to discharge.
                    Throwable cause = error.getCause() != null ? error.getCause() : error;
                    if (cause instanceof com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException brokerError
                            && "runtime_session_not_acquirable".equals(brokerError.getCode())) {
                        return null;
                    }
                    if (cause instanceof RuntimeException runtimeError) {
                        throw runtimeError;
                    }
                    throw new java.util.concurrent.CompletionException(cause);
                });
    }
}
