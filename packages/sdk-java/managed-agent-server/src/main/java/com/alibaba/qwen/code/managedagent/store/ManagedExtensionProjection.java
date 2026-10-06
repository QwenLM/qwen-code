package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * H0c of #12827: how the control plane keys, chains and projects the Stage H
 * records of managed-extension-record/1. The shared fixtures in
 * packages/core/src/managed-runtime/contracts pin it, and the TypeScript
 * module managed-extension-projection.ts there replays the same cases.
 */
public final class ManagedExtensionProjection {
    /** The record bodies defined so far; a slice adds its body here. */
    public static final Map<String, Body> RECORD_BODIES = Map.of(
            "monitor_run", new Body("monitor",
                    ManagedExtensionRecords::requireMonitorRun,
                    body -> body.get("monitorId").textValue(),
                    ManagedExtensionRecords::isMonitorRunStart,
                    ManagedExtensionRecords::isMonitorRunSuccessor),
            "mcp_configuration", new Body(null,
                    ManagedMcpRecords::requireConfiguration,
                    body -> body.get("configurationId").textValue(),
                    ManagedMcpRecords::isConfigurationStart,
                    ManagedMcpRecords::isConfigurationSuccessor),
            "mcp_operation", new Body(null,
                    ManagedMcpRecords::requireOperation,
                    body -> body.get("operationId").textValue(),
                    ManagedMcpRecords::isOperationStart,
                    ManagedMcpRecords::isOperationSuccessor),
            "hook_registration", new Body(null,
                    ManagedHookRecords::requireRegistration,
                    body -> body.get("registrationId").textValue(),
                    ManagedHookRecords::isRegistrationStart,
                    ManagedHookRecords::isRegistrationSuccessor),
            "hook_execution", new Body(null,
                    ManagedHookRecords::requireExecution,
                    body -> body.get("hookExecutionId").textValue(),
                    ManagedHookRecords::isExecutionStart,
                    ManagedHookRecords::isExecutionSuccessor),
            "child_run", new Body("background_shell",
                    ManagedExtensionRecords::requireChildRun,
                    body -> body.get("shellId").textValue(),
                    ManagedExtensionRecords::isChildRunStart,
                    ManagedExtensionRecords::isChildRunSuccessor));
    public static final List<String> TASK_STATES = List.of("pending",
            "running", "waiting", "completed", "failed", "cancelled",
            "degraded", "recovery_blocked");
    public static final List<String> TASK_KINDS = List.of("child_agent",
            "workflow", "background_shell", "monitor", "automation_run");
    public static final List<String> RUNTIME_STATES = List.of("unbound",
            "provisioning", "ready", "draining", "lost");

    /**
     * Run states that mean the work began. A blocked run may still prove
     * that it never started, so it sets no start of its own.
     */
    private static final Set<String> STARTED = Set.of("running", "waiting",
            "settled");
    /** Delivery states that still need the dispatcher. */
    private static final Set<String> PENDING_DELIVERY = Set.of("planned",
            "sending", "partial", "accepting", "unknown");

    private ManagedExtensionProjection() {
    }

    /**
     * A record body: how to check it, the identity its revision chain is
     * keyed by, whether it may open a chain and whether it may follow a
     * revision. Every body embeds its run block under {@code run}.
     */
    public record Body(String taskKind, Consumer<JsonNode> require,
            Function<JsonNode, String> recordId, Predicate<JsonNode> isStart,
            BiPredicate<JsonNode, JsonNode> isSuccessor) {
    }

    /** The part of SessionTaskView that the record revisions determine. */
    public record TaskProjection(String state, String runtimeState,
            Long definitionRevision, long createdAt, Long startedAt,
            Long settledAt) {
    }

    /**
     * The key of one record's revision chain: SHA-256 over the Session ID,
     * the domain and the record's own identity, joined by NUL.
     */
    public static String recordKey(String sessionId, String domain,
            String recordId) {
        try {
            return HexFormat.of().formatHex(MessageDigest
                    .getInstance("SHA-256").digest((sessionId + "\u0000"
                            + domain + "\u0000" + recordId)
                            .getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public static String taskId(String recordKey) {
        return "task_" + recordKey;
    }

    /**
     * The task view after one more committed revision, from the view before
     * it (null for the first revision), the revision's checked run and the
     * time its domain.committed event occurred. The times come from the
     * journal, so a rebuild yields the same view; a writer's clock may run
     * behind the one before it, so a time never precedes an earlier one.
     */
    public static TaskProjection project(TaskProjection previous,
            JsonNode run, long occurredAt) {
        return project(previous, run, occurredAt, false);
    }

    /**
     * The same projection with the record's stop request: a stop-requested
     * record whose run is attached ({@code running_attached}) or still
     * provisioning ({@code intent}/{@code dispatch_started}) projects its
     * Runtime as {@code draining}; a lost, terminal or unbound row keeps
     * its own Runtime state (H3's {@code child_run}; every earlier record
     * passes false).
     */
    public static TaskProjection project(TaskProjection previous,
            JsonNode run, long occurredAt, boolean stopRequested) {
        String state = run.get("state").textValue();
        JsonNode definition = run.get("definition");
        long createdAt = previous == null ? occurredAt : previous.createdAt();
        Long startedAt = previous != null && previous.startedAt() != null
                ? previous.startedAt()
                : STARTED.contains(state)
                        ? Long.valueOf(Math.max(occurredAt, createdAt)) : null;
        Long settledAt = previous != null && previous.settledAt() != null
                ? previous.settledAt()
                : ManagedExtensionRecords.TERMINAL.contains(state)
                        ? Long.valueOf(Math.max(occurredAt, startedAt != null
                                ? startedAt : createdAt))
                        : null;
        return new TaskProjection(taskState(state, run.get("reason")),
                runtimeState(run, stopRequested),
                definition.isNull() ? null : definition
                        .get("definitionRevision").decimalValue()
                        .longValueExact(),
                createdAt, startedAt, settledAt);
    }

    /** Whether the run's delivery is in the outbox. */
    public static boolean isDeliveryPending(JsonNode run) {
        JsonNode delivery = run.get("delivery");
        return !delivery.isNull()
                && PENDING_DELIVERY.contains(delivery.get("state").textValue());
    }

    /**
     * The physical execution state a Broker execution record proves. A
     * claimed dispatch that was not sent yet is still an intent: the Broker
     * grants it again at the next generation instead of calling it unknown.
     * Only the Runtime's own not_started answer proves a call unsent, and an
     * abandoned record's outcome stays unknown for good.
     */
    public static String executionOf(ToolExecutionRecord.State state,
            String executionStatus) {
        return switch (state) {
            case PREPARED, DISPATCHING -> "intent";
            case EXECUTING, CANCEL_REQUESTED -> "dispatch_started";
            case SETTLED -> "not_started".equals(executionStatus)
                    ? "not_started_proven" : "settled";
            case UNKNOWN, ABANDONED -> "outcome_unknown";
        };
    }

    private static String taskState(String state, JsonNode reason) {
        return switch (state) {
            case "reserved", "admitted" -> "pending";
            // Only a recovery reason fits these states: it runs degraded.
            case "running", "waiting" -> reason.isNull() ? state : "degraded";
            case "settled" -> "completed";
            default -> state;
        };
    }

    private static String runtimeState(JsonNode run, boolean stopRequested) {
        String execution = run.get("execution").textValue();
        if (ManagedExtensionRecords.TERMINAL.contains(
                run.get("state").textValue())
                || execution == null) {
            return null;
        }
        if (run.get("runtime").isNull()) {
            return "unbound";
        }
        if ("running_attached".equals(execution)) {
            return stopRequested ? "draining" : "ready";
        }
        if ("runtime_lost".equals(run.get("reason").textValue())) {
            return "lost";
        }
        if ("intent".equals(execution) || "dispatch_started".equals(execution)) {
            return stopRequested ? "draining" : "provisioning";
        }
        return null;
    }
}
