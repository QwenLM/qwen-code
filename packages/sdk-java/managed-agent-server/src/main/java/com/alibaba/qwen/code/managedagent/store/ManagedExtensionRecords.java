package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The managed-extension-record/1 contract (H0b of #12827): the records that
 * the Stage H capabilities share, as the control plane reads them. The
 * shared schema and fixtures in packages/core pin the contract, and the
 * TypeScript module there replays the same cases. The Session store reads
 * them as they commit (H0c, see ManagedExtensionProjection).
 */
public final class ManagedExtensionRecords {
    public static final List<String> DOMAINS = List.of("config_install",
            "workspace_initialization", "skill_activation",
            "mcp_configuration", "mcp_operation", "hook_registration",
            "hook_execution", "tool_stage", "resource", "publication",
            "workspace_operation", "history_rewind", "history_copy",
            "history_maintenance", "channel_route", "channel_delivery",
            "schedule", "automation_run", "child_run", "child_acceptance",
            "memory_job", "monitor_run", "goal_state", "todo_state",
            "plan_mode", "team_state", "team_task", "team_message",
            "team_plan", "session_message", "session_metadata",
            "file_history", "session_source");
    public static final int MAX_ID_BYTES = 512;
    public static final int MAX_GRANT_PHASES = 16;
    public static final int MAX_PHASE_LENGTH = 64;
    public static final int MAX_MONITOR_EVENTS = 10_000;
    public static final int MAX_MONITOR_IDLE_TIMEOUT_MS = 600_000;
    public static final int MAX_MONITOR_DEBOUNCE_MS = 600_000;
    public static final String MONITOR_RUN_KIND = "managed-monitor_run";
    public static final String MONITOR_OUTPUT_KIND =
            "managed-tool-result-manifest";

    public static final List<String> RUN_STATES = List.of("reserved",
            "admitted", "running", "waiting", "settled", "failed",
            "cancelled", "recovery_blocked");
    public static final List<String> EXECUTION_STATES = List.of("intent",
            "dispatch_started", "running_attached", "settled",
            "not_started_proven", "outcome_unknown", "corrupt");
    public static final List<String> DELIVERY_STATES = List.of("planned",
            "sending", "partial", "delivered", "accepting", "accepted",
            "consumed", "unknown", "rejected", "cancelled");
    /** The single steps each state line allows, by line and state. */
    public static final Map<String, Map<String, List<String>>> TRANSITIONS =
            Map.of("run", Map.of(
                    "reserved", List.of("admitted", "failed", "cancelled"),
                    "admitted", List.of("running", "waiting", "failed",
                            "cancelled", "recovery_blocked"),
                    "running", List.of("waiting", "settled", "failed",
                            "cancelled", "recovery_blocked"),
                    "waiting", List.of("running", "settled", "failed",
                            "cancelled", "recovery_blocked"),
                    "settled", List.of(),
                    "failed", List.of(),
                    "cancelled", List.of(),
                    "recovery_blocked", List.of("running", "waiting",
                            "settled", "failed", "cancelled")),
                    "execution", Map.of(
                    "intent", List.of("dispatch_started",
                            "not_started_proven", "outcome_unknown",
                            "corrupt"),
                    "dispatch_started", List.of("running_attached",
                            "settled", "not_started_proven",
                            "outcome_unknown", "corrupt"),
                    "running_attached", List.of("settled", "outcome_unknown",
                            "corrupt"),
                    "settled", List.of(),
                    "not_started_proven", List.of(),
                    "outcome_unknown", List.of("running_attached", "settled",
                            "not_started_proven", "corrupt"),
                    "corrupt", List.of()),
                    "delivery", Map.of(
                    "planned", List.of("sending", "accepting", "cancelled"),
                    "sending", List.of("delivered", "partial", "unknown",
                            "rejected"),
                    "partial", List.of("sending", "unknown"),
                    "delivered", List.of(),
                    "accepting", List.of("accepted", "unknown", "rejected"),
                    "accepted", List.of("consumed"),
                    "consumed", List.of(),
                    "unknown", List.of("delivered", "partial", "accepted",
                            "rejected"),
                    "rejected", List.of(),
                    "cancelled", List.of()));
    public static final Map<String, List<String>> DELIVERY_TARGETS = Map.of(
            "channel", List.of("planned", "sending", "partial", "delivered",
                    "unknown", "rejected", "cancelled"),
            "session", List.of("planned", "accepting", "accepted",
                    "consumed", "unknown", "rejected", "cancelled"));
    public static final List<String> RECOVERY_REASONS = List.of(
            "outcome_unknown", "execution_corrupt", "runtime_lost",
            "dispatch_unknown", "handler_unavailable");
    public static final List<String> QUOTA_REASONS = List.of("count_limit",
            "rate_limit", "depth_limit", "byte_limit", "budget_exhausted",
            "duration_limit");
    /** Why a Monitor ended, by the state its run ended in. */
    public static final Map<String, List<String>> MONITOR_STOP_REASONS =
            Map.of("settled", List.of("exited", "max_events", "idle_timeout"),
                    "failed", List.of("start_failed", "watch_failed",
                            "quota_exceeded"),
                    "cancelled", List.of("stop_requested"));

    private static final Comparator<JsonNode> SAME_VALUE = (left, right) ->
            left.equals(right) || left.isNumber() && right.isNumber()
                    && left.decimalValue().compareTo(right.decimalValue()) == 0
                    ? 0 : 1;
    private static final long MAX_COUNT = 9_007_199_254_740_990L;
    static final long MAX_TIME = 8_640_000_000_000_000L;
    private static final BigInteger MAX_GENERATION =
            BigInteger.valueOf(Long.MAX_VALUE);
    private static final Pattern GENERATION = Pattern.compile(
            "[1-9][0-9]{0,18}");
    private static final Pattern DIGEST = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern PHASE = Pattern.compile(
            "[a-z][a-z0-9_]{0," + (MAX_PHASE_LENGTH - 1) + "}");
    /** Run states after which no observation, output or run change may land. */
    static final List<String> TERMINAL = List.of("settled", "failed",
            "cancelled");
    private static final Set<String> GRANT_KEYS = Set.of("sessionKey",
            "operationId", "domain", "operationRevision", "ownerId",
            "workspaceGeneration", "resourceScope", "leaseDurationMs",
            "expiresAt");
    private static final Set<String> RUN_KEYS = Set.of("state", "reason",
            "definition", "executionCallId", "effectId", "dispatchId",
            "deliveryId", "execution", "runtime", "delivery");
    private static final Set<String> MONITOR_KEYS = Set.of("monitorId",
            "ownerScopeId", "commandRef", "maxEvents", "idleTimeoutMs",
            "debounceMs", "startReceiptRef", "observationSequence",
            "lastObservationRef", "notifiedThrough", "stopReason",
            "outputRef", "run");
    private static final List<String> MONITOR_FIXED = List.of("monitorId",
            "ownerScopeId", "commandRef", "maxEvents", "idleTimeoutMs",
            "debounceMs");
    private static final Set<String> CHILD_KEYS = Set.of("kind", "shellId",
            "ownerScopeId", "commandRef", "startReceiptRef", "outputRef",
            "stopReason", "stopRequested", "exitCode", "exitSignal", "run");
    private static final List<String> CHILD_FIXED = List.of("kind", "shellId",
            "ownerScopeId", "commandRef");
    private static final List<String> RUN_IDENTITIES = List.of("definition",
            "executionCallId", "effectId", "dispatchId", "deliveryId");

    private ManagedExtensionRecords() {
    }

    /** Why a background Shell ended, by the state its run ended in. */
    public static final Map<String, List<String>> CHILD_STOP_REASONS =
            Map.of("settled", List.of("exited"), "failed",
                    List.of("start_failed", "process_failed",
                            "quota_exceeded"),
                    "cancelled", List.of("stop_requested"));

    private static final Pattern EXIT_SIGNAL = Pattern.compile(
            "[A-Z][A-Z0-9]{0,15}");

    /** A record that breaks the contract. */
    public static final class InvalidRecordException
            extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        InvalidRecordException(String message) {
            super(message);
        }
    }

    /** Whether one step of {@code line} may go from {@code from} to {@code to}. */
    public static boolean isTransitionAllowed(String line, String from,
            String to) {
        if (line == null || from == null || to == null) {
            return false;
        }
        Map<String, List<String>> transitions = TRANSITIONS.get(line);
        List<String> next = transitions == null ? null : transitions.get(from);
        return next != null && next.contains(to);
    }

    public static void requireOperationGrant(JsonNode grant) {
        closed(grant, GRANT_KEYS, "grant");
        closed(grant.get("sessionKey"), Set.of("tenantId", "workspaceId",
                "sessionId"), "grant.sessionKey");
        grant.get("sessionKey").forEach(value -> id(value,
                "grant.sessionKey"));
        id(grant.get("operationId"), "grant.operationId");
        String domain = oneOf(grant.get("domain"), DOMAINS, "grant.domain");
        count(grant.get("operationRevision"), 1, MAX_COUNT,
                "grant.operationRevision");
        id(grant.get("ownerId"), "grant.ownerId");
        generation(grant.get("workspaceGeneration"),
                "grant.workspaceGeneration");
        JsonNode scope = grant.get("resourceScope");
        closed(scope, Set.of("recordRef", "phases"), "grant.resourceScope");
        JsonNode recordRef = scope.get("recordRef");
        durableRef(recordRef, "grant.resourceScope.recordRef");
        // The same pairing domain.committed requires of its recordRef.
        require(("managed-" + domain).equals(recordRef.get("kind")
                .textValue()) && recordRef.get("schemaVersion").asLong() == 1,
                "grant.resourceScope.recordRef must reference managed-"
                        + domain + " version 1");
        JsonNode phases = scope.get("phases");
        require(phases.isArray() && !phases.isEmpty()
                && phases.size() <= MAX_GRANT_PHASES,
                "grant.resourceScope.phases must list 1 to "
                        + MAX_GRANT_PHASES + " phases");
        Set<String> seen = new HashSet<>();
        for (JsonNode phase : phases) {
            require(phase.isTextual() && PHASE.matcher(phase.textValue())
                    .matches() && seen.add(phase.textValue()),
                    "grant.resourceScope.phases must be distinct phases");
        }
        count(grant.get("leaseDurationMs"),
                ManagedSessionStoreModels.MIN_LEASE_MILLIS,
                ManagedSessionStoreModels.MAX_LEASE_MILLIS,
                "grant.leaseDurationMs");
        count(grant.get("expiresAt"), 0, MAX_TIME, "grant.expiresAt");
    }

    /**
     * Whether {@code next} may replace {@code previous} at a Runtime's
     * per-operation gate: a renewal of the same revision that only extends
     * the lease, or a later revision of the same operation that does not go
     * back to an older Workspace generation.
     */
    public static boolean isOperationGrantSuccessor(JsonNode previous,
            JsonNode next) {
        if (!accepts(() -> requireOperationGrant(previous))
                || !accepts(() -> requireOperationGrant(next))) {
            return false;
        }
        for (String key : List.of("sessionKey", "operationId", "domain")) {
            if (!same(previous.get(key), next.get(key))) {
                return false;
            }
        }
        long before = previous.get("operationRevision").asLong();
        long after = next.get("operationRevision").asLong();
        if (after == before) {
            return next.get("expiresAt").asLong()
                    > previous.get("expiresAt").asLong()
                    && same(without(previous, "expiresAt"),
                            without(next, "expiresAt"));
        }
        return after > before && generationOf(next, "workspaceGeneration")
                .compareTo(generationOf(previous, "workspaceGeneration")) >= 0;
    }

    public static void requireDefinitionPin(JsonNode pin) {
        closed(pin, Set.of("definitionId", "definitionRevision",
                "definitionDigest"), "definition");
        id(pin.get("definitionId"), "definition.definitionId");
        count(pin.get("definitionRevision"), 1, MAX_COUNT,
                "definition.definitionRevision");
        digest(pin.get("definitionDigest"), "definition.definitionDigest");
    }

    /** Whether two pins agree: a definition revision never names two digests. */
    public static boolean isDefinitionPinConsistent(JsonNode first,
            JsonNode second) {
        if (!accepts(() -> requireDefinitionPin(first))
                || !accepts(() -> requireDefinitionPin(second))) {
            return false;
        }
        return !same(first.get("definitionId"), second.get("definitionId"))
                || !same(first.get("definitionRevision"),
                        second.get("definitionRevision"))
                || same(first.get("definitionDigest"),
                        second.get("definitionDigest"));
    }

    /**
     * Checks the run block every Stage H record embeds: the three state
     * lines, the reason, the pinned definition, the stable identities and the
     * Runtime binding, together with the rules that tie them together.
     */
    public static void requireRun(JsonNode run) {
        closed(run, RUN_KEYS, "run");
        String state = oneOf(run.get("state"), RUN_STATES, "run.state");
        String reason = nullableOneOf(run.get("reason"), concat(
                RECOVERY_REASONS, QUOTA_REASONS), "run.reason");
        if (!run.get("definition").isNull()) {
            requireDefinitionPin(run.get("definition"));
        }
        for (String key : List.of("executionCallId", "effectId",
                "dispatchId", "deliveryId")) {
            if (!run.get(key).isNull()) {
                id(run.get(key), "run." + key);
            }
        }
        String execution = nullableOneOf(run.get("execution"),
                EXECUTION_STATES, "run.execution");
        JsonNode runtime = run.get("runtime");
        if (!runtime.isNull()) {
            closed(runtime, Set.of("runtimeBindingId", "generation"),
                    "run.runtime");
            id(runtime.get("runtimeBindingId"), "run.runtime.runtimeBindingId");
            generation(runtime.get("generation"), "run.runtime.generation");
        }
        JsonNode delivery = run.get("delivery");
        String target = null;
        String deliveryState = null;
        if (!delivery.isNull()) {
            closed(delivery, Set.of("target", "state"), "run.delivery");
            target = oneOf(delivery.get("target"), List.of("channel",
                    "session"), "run.delivery.target");
            deliveryState = oneOf(delivery.get("state"),
                    DELIVERY_TARGETS.get(target), "run.delivery.state");
        }
        boolean callId = !run.get("executionCallId").isNull();
        boolean effectId = !run.get("effectId").isNull();

        require(!(callId && effectId),
                "run names one physical identity at most");
        require(execution == null || callId || effectId,
                "run.execution needs an executionCallId or an effectId");
        require(runtime.isNull() || execution != null,
                "run.runtime needs an execution");
        require(run.get("deliveryId").isNull() != "channel".equals(target),
                "run.deliveryId is set exactly for a channel delivery");
        require(!"reserved".equals(state)
                || execution == null && delivery.isNull(),
                "run has nothing dispatched while reserved");
        require(!"outcome_unknown".equals(execution)
                && !"corrupt".equals(execution)
                || "recovery_blocked".equals(state),
                "run stays recovery_blocked while its execution is unproven");
        require(!TERMINAL.contains(state) || execution == null
                || "settled".equals(execution)
                || "not_started_proven".equals(execution),
                "run ends only with an execution proven to have ended");
        require(!"settled".equals(state)
                || !"not_started_proven".equals(execution),
                "run cannot settle an execution that never started");
        require(!"running".equals(state) && !"waiting".equals(state)
                || !"not_started_proven".equals(execution),
                "run cannot run on an execution that never started");
        require(!"session".equals(target) || "planned".equals(deliveryState)
                || "cancelled".equals(deliveryState)
                || TERMINAL.contains(state),
                "run.delivery cannot hand over a result before the run ends");

        boolean recovery = reason != null && RECOVERY_REASONS.contains(reason);
        boolean quota = reason != null && QUOTA_REASONS.contains(reason);
        boolean fits = switch (state) {
            case "recovery_blocked" -> recovery;
            case "running", "waiting" -> reason == null || recovery;
            case "failed" -> reason == null || quota;
            default -> reason == null;
        };
        require(fits, "run.reason does not fit the " + state + " state");
        require(!"outcome_unknown".equals(reason)
                || "outcome_unknown".equals(execution),
                "run.reason outcome_unknown needs an unknown execution");
        require("execution_corrupt".equals(reason)
                == "corrupt".equals(execution),
                "run.reason is execution_corrupt exactly when it is corrupt");
        require(!"runtime_lost".equals(reason) || !runtime.isNull(),
                "run.reason runtime_lost needs the Runtime binding it lost");
        require(!"runtime_lost".equals(reason)
                || !"recovery_blocked".equals(state)
                || !"running_attached".equals(execution),
                "run cannot be blocked on a lost Runtime while attached");
        require(!"dispatch_unknown".equals(reason)
                || !run.get("dispatchId").isNull(),
                "run.reason dispatch_unknown needs a dispatchId");
    }

    /**
     * Whether {@code next} may follow {@code previous} as the next revision
     * of one run: each state line stays or takes one allowed step, an
     * execution starts at intent and a delivery at planned, identities and
     * the pinned definition never change once set, the pin and the Runtime
     * binding are recorded by the dispatch, the binding changes only when an
     * unknown execution is attached again under a later generation, and a
     * run that ended changes only its delivery, with the delivery ID a first
     * Channel delivery brings.
     */
    public static boolean isRunSuccessor(JsonNode previous, JsonNode next) {
        if (!accepts(() -> requireRun(previous))
                || !accepts(() -> requireRun(next))
                || !advances("run", text(previous, "state"),
                        text(next, "state"))) {
            return false;
        }
        if (TERMINAL.contains(text(previous, "state"))
                && !same(without(previous, "delivery", "deliveryId"),
                        without(next, "delivery", "deliveryId"))) {
            return false;
        }
        for (String key : RUN_IDENTITIES) {
            if (!previous.get(key).isNull()
                    && !same(previous.get(key), next.get(key))) {
                return false;
            }
        }
        String executionBefore = text(previous, "execution");
        String executionAfter = text(next, "execution");
        // A run is pinned to its definition and bound to its Runtime by the
        // time it dispatches, never later.
        boolean dispatched = executionBefore != null
                && !"intent".equals(executionBefore);
        if (dispatched && previous.get("definition").isNull()
                && !next.get("definition").isNull()) {
            return false;
        }
        if (executionBefore == null ? executionAfter != null
                && !"intent".equals(executionAfter)
                : executionAfter == null || !advances("execution",
                        executionBefore, executionAfter)) {
            return false;
        }
        JsonNode deliveryBefore = previous.get("delivery");
        JsonNode deliveryAfter = next.get("delivery");
        if (deliveryBefore.isNull() ? !deliveryAfter.isNull()
                && !"planned".equals(text(deliveryAfter, "state"))
                : deliveryAfter.isNull()
                        || !same(deliveryBefore.get("target"),
                                deliveryAfter.get("target"))
                        || !advances("delivery", text(deliveryBefore, "state"),
                                text(deliveryAfter, "state"))) {
            return false;
        }
        JsonNode runtimeBefore = previous.get("runtime");
        JsonNode runtimeAfter = next.get("runtime");
        if (runtimeBefore.isNull()) {
            return runtimeAfter.isNull() || !dispatched;
        }
        if (same(runtimeBefore, runtimeAfter)) {
            return true;
        }
        return !runtimeAfter.isNull()
                && "outcome_unknown".equals(executionBefore)
                && "running_attached".equals(executionAfter)
                && generationOf(runtimeAfter, "generation").compareTo(
                        generationOf(runtimeBefore, "generation")) > 0;
    }

    /**
     * Whether {@code run} may open a run: it starts reserved or admitted,
     * with no execution beyond an intent and no delivery beyond a plan, so
     * the first revision of a record never skips a step the later ones take
     * one at a time.
     */
    public static boolean isRunStart(JsonNode run) {
        if (!accepts(() -> requireRun(run))) {
            return false;
        }
        String state = text(run, "state");
        String execution = text(run, "execution");
        JsonNode delivery = run.get("delivery");
        return ("reserved".equals(state) || "admitted".equals(state))
                && (execution == null || "intent".equals(execution))
                && (delivery.isNull()
                        || "planned".equals(text(delivery, "state")));
    }

    /** Checks the body of a managed-monitor_run domain record. */
    public static void requireMonitorRun(JsonNode monitor) {
        closed(monitor, MONITOR_KEYS, "monitorRun");
        JsonNode run = monitor.get("run");
        requireRun(run);
        // A Monitor is started by one tool call and delivers through its
        // notification watermark, not through a dispatch or a delivery.
        require(!run.get("executionCallId").isNull()
                && run.get("effectId").isNull()
                && run.get("dispatchId").isNull()
                && run.get("deliveryId").isNull()
                && run.get("delivery").isNull()
                && run.get("definition").isNull(),
                "monitorRun.run must name its start call and nothing else");
        id(monitor.get("monitorId"), "monitorRun.monitorId");
        id(monitor.get("ownerScopeId"), "monitorRun.ownerScopeId");
        durableRef(monitor.get("commandRef"), "monitorRun.commandRef");
        long maxEvents = count(monitor.get("maxEvents"), 1,
                MAX_MONITOR_EVENTS, "monitorRun.maxEvents");
        count(monitor.get("idleTimeoutMs"), 1, MAX_MONITOR_IDLE_TIMEOUT_MS,
                "monitorRun.idleTimeoutMs");
        count(monitor.get("debounceMs"), 0, MAX_MONITOR_DEBOUNCE_MS,
                "monitorRun.debounceMs");
        JsonNode startReceipt = monitor.get("startReceiptRef");
        if (!startReceipt.isNull()) {
            durableRef(startReceipt, "monitorRun.startReceiptRef");
        }
        long observed = count(monitor.get("observationSequence"), 0,
                maxEvents, "monitorRun.observationSequence");
        JsonNode lastObservation = monitor.get("lastObservationRef");
        if (!lastObservation.isNull()) {
            durableRef(lastObservation, "monitorRun.lastObservationRef");
        }
        count(monitor.get("notifiedThrough"), 0, observed,
                "monitorRun.notifiedThrough");
        String stopReason = nullableOneOf(monitor.get("stopReason"),
                concat(concat(MONITOR_STOP_REASONS.get("settled"),
                        MONITOR_STOP_REASONS.get("failed")),
                        MONITOR_STOP_REASONS.get("cancelled")),
                "monitorRun.stopReason");
        JsonNode output = monitor.get("outputRef");
        if (!output.isNull()) {
            durableRef(output, "monitorRun.outputRef");
            require(MONITOR_OUTPUT_KIND.equals(output.get("kind").textValue())
                    && output.get("schemaVersion").asLong() == 1,
                    "monitorRun.outputRef must reference "
                            + MONITOR_OUTPUT_KIND + " version 1");
        }
        String state = text(run, "state");
        String execution = text(run, "execution");
        String reason = text(run, "reason");

        require(lastObservation.isNull() == (observed == 0),
                "monitorRun.lastObservationRef is set exactly after an "
                        + "observation");
        require(!startReceipt.isNull() || observed == 0
                && !"running_attached".equals(execution),
                "monitorRun.startReceiptRef must be set once the watch "
                        + "started");
        require(startReceipt.isNull() || execution != null
                && !"intent".equals(execution)
                && !"dispatch_started".equals(execution)
                && !"not_started_proven".equals(execution),
                "monitorRun.startReceiptRef must be null before the watch "
                        + "starts");
        require(startReceipt.isNull() || !run.get("runtime").isNull(),
                "monitorRun.startReceiptRef needs the Runtime binding that "
                        + "started it");
        require((stopReason == null) != TERMINAL.contains(state),
                "monitorRun.stopReason is set exactly when the run ends");
        require(stopReason == null
                || MONITOR_STOP_REASONS.get(state).contains(stopReason),
                "monitorRun.stopReason does not fit the " + state + " state");
        require(!"settled".equals(state) || "settled".equals(execution)
                && !startReceipt.isNull(),
                "monitorRun.run settles only with a watch that started and "
                        + "ended");
        require(!"max_events".equals(stopReason) || observed == maxEvents,
                "monitorRun.stopReason max_events needs maxEvents "
                        + "observations");
        require(!"start_failed".equals(stopReason)
                || startReceipt.isNull() && execution != null,
                "monitorRun.stopReason start_failed needs a watch that "
                        + "never started");
        require(!"watch_failed".equals(stopReason) || !startReceipt.isNull(),
                "monitorRun.stopReason watch_failed needs a watch that "
                        + "started");
        require("quota_exceeded".equals(stopReason)
                == (reason != null && QUOTA_REASONS.contains(reason)),
                "monitorRun.stopReason is quota_exceeded exactly for a "
                        + "quota reason");
    }

    /**
     * Whether {@code next} may follow {@code previous} as the next revision
     * of one monitor: its definition is fixed, its run moves forward, its
     * observation and notification watermarks never go back, a new Runtime
     * generation brings a new start receipt and nothing else does, and once
     * it ended only the notification watermark may still advance.
     */
    public static boolean isMonitorRunSuccessor(JsonNode previous,
            JsonNode next) {
        if (!accepts(() -> requireMonitorRun(previous))
                || !accepts(() -> requireMonitorRun(next))) {
            return false;
        }
        for (String key : MONITOR_FIXED) {
            if (!same(previous.get(key), next.get(key))) {
                return false;
            }
        }
        long observedBefore = previous.get("observationSequence").asLong();
        long observedAfter = next.get("observationSequence").asLong();
        // Only an attached watch observes, so a lost or ended one adds
        // nothing.
        boolean attached = "running_attached".equals(text(previous.get("run"),
                "execution")) || "running_attached".equals(text(next.get("run"),
                        "execution"));
        if (!isRunSuccessor(previous.get("run"), next.get("run"))
                || observedAfter < observedBefore
                || observedAfter > observedBefore && !attached
                || next.get("notifiedThrough").asLong()
                        < previous.get("notifiedThrough").asLong()
                || observedAfter == observedBefore
                        && !same(previous.get("lastObservationRef"),
                                next.get("lastObservationRef"))
                || !previous.get("outputRef").isNull()
                        && next.get("outputRef").isNull()) {
            return false;
        }
        if (TERMINAL.contains(text(previous.get("run"), "state"))
                && !same(without(previous, "notifiedThrough"),
                        without(next, "notifiedThrough"))) {
            return false;
        }
        JsonNode runtimeBefore = previous.get("run").get("runtime");
        boolean rebuilt = !runtimeBefore.isNull()
                && !same(runtimeBefore, next.get("run").get("runtime"));
        boolean sameReceipt = same(previous.get("startReceiptRef"),
                next.get("startReceiptRef"));
        return previous.get("startReceiptRef").isNull()
                || (rebuilt ? !sameReceipt : sameReceipt);
    }

    /**
     * Whether {@code monitor} may be the first revision of a monitor: its
     * run opens, and it has written no output, which needs a watch. It
     * cannot have observed anything either, since an observation needs a
     * start receipt.
     */
    public static boolean isMonitorRunStart(JsonNode monitor) {
        return accepts(() -> requireMonitorRun(monitor))
                && isRunStart(monitor.get("run"))
                && monitor.get("outputRef").isNull();
    }

    /**
     * Checks the body of a managed-child_run schema version 1 record
     * ({@code kind: "shell"}): one background Shell per record (H3 of
     * #12827; see managed-child-run-record.ts for the same rules).
     */
    public static void requireChildRun(JsonNode child) {
        closed(child, CHILD_KEYS, "childRun");
        require("shell".equals(child.get("kind").textValue()),
                "childRun.kind must be 'shell' in schema version 1");
        JsonNode run = child.get("run");
        requireRun(run);
        // A background Shell is started by one tool call and is observed
        // through its task projection and output Artifact; it has no
        // delivery line.
        require(!run.get("executionCallId").isNull()
                && run.get("effectId").isNull()
                && run.get("dispatchId").isNull()
                && run.get("deliveryId").isNull()
                && run.get("delivery").isNull()
                && run.get("definition").isNull(),
                "childRun.run must name its start call and nothing else");
        id(child.get("shellId"), "childRun.shellId");
        id(child.get("ownerScopeId"), "childRun.ownerScopeId");
        durableRef(child.get("commandRef"), "childRun.commandRef");
        String execution = text(run, "execution");
        JsonNode startReceipt = child.get("startReceiptRef");
        if (!startReceipt.isNull()) {
            durableRef(startReceipt, "childRun.startReceiptRef");
        }
        require(startReceipt.isNull() || execution != null
                && !"intent".equals(execution)
                && !"dispatch_started".equals(execution)
                && !"not_started_proven".equals(execution),
                "childRun.startReceiptRef must be null before the process "
                        + "starts");
        require(!startReceipt.isNull()
                || !"running_attached".equals(execution)
                        && !"settled".equals(execution),
                "childRun.startReceiptRef must be set once the process "
                        + "started");
        require(startReceipt.isNull() || !run.get("runtime").isNull(),
                "childRun.startReceiptRef needs the Runtime binding that "
                        + "started it");
        JsonNode output = child.get("outputRef");
        if (!output.isNull()) {
            durableRef(output, "childRun.outputRef");
            require(MONITOR_OUTPUT_KIND.equals(output.get("kind").textValue())
                    && output.get("schemaVersion").asLong() == 1,
                    "childRun.outputRef must reference "
                            + MONITOR_OUTPUT_KIND + " version 1");
        }
        // Output needs a started process: nothing writes the manifest
        // before one.
        require(output.isNull() || !startReceipt.isNull(),
                "childRun.outputRef needs a start receipt");
        String stopReason = nullableOneOf(child.get("stopReason"),
                concat(concat(CHILD_STOP_REASONS.get("settled"),
                        CHILD_STOP_REASONS.get("failed")),
                        CHILD_STOP_REASONS.get("cancelled")),
                "childRun.stopReason");
        JsonNode stopRequested = child.get("stopRequested");
        require(stopRequested.isBoolean(),
                "childRun.stopRequested must be boolean");
        require(!"stop_requested".equals(stopReason)
                || stopRequested.booleanValue(),
                "childRun stop_requested needs its stop request");
        JsonNode exitCode = child.get("exitCode");
        if (!exitCode.isNull()) {
            count(exitCode, 0, 255, "childRun.exitCode");
        }
        JsonNode exitSignal = child.get("exitSignal");
        require(exitSignal.isNull()
                || exitSignal.isTextual()
                        && EXIT_SIGNAL.matcher(exitSignal.textValue())
                                .matches(),
                "childRun.exitSignal must be an uppercase signal name");
        String state = text(run, "state");
        String reason = text(run, "reason");
        require((stopReason == null) != TERMINAL.contains(state),
                "childRun.stopReason is set exactly when the run ends");
        require(stopReason == null
                || CHILD_STOP_REASONS.get(state).contains(stopReason),
                "childRun.stopReason does not fit the " + state + " state");
        // Every terminal run names the ending execution line: a natural
        // exit is proven only by an observed settled execution under its
        // receipt, a pre-start failure lands on not_started_proven, and an
        // honored stop or a later failure settles the execution that the
        // receipt proves started.
        require(!"settled".equals(state) || "settled".equals(execution),
                "childRun settled needs its settled execution");
        require(!"cancelled".equals(state) || "settled".equals(execution),
                "childRun cancelled needs its settled execution");
        require(!"failed".equals(state)
                || "settled".equals(execution)
                || "not_started_proven".equals(execution),
                "childRun failed needs settled or not_started_proven "
                        + "execution");
        require(!"start_failed".equals(stopReason)
                || startReceipt.isNull() && "not_started_proven".equals(execution),
                "childRun.stopReason start_failed needs a process that "
                        + "never started");
        require(!"process_failed".equals(stopReason) || !startReceipt.isNull(),
                "childRun.stopReason process_failed needs a process that "
                        + "started");
        require(!("process_failed".equals(stopReason)
                        || "quota_exceeded".equals(stopReason))
                || "settled".equals(execution),
                "childRun.stopReason process failure needs its settled "
                        + "execution");
        require("quota_exceeded".equals(stopReason)
                == (reason != null && QUOTA_REASONS.contains(reason)),
                "childRun.stopReason is quota_exceeded exactly for a "
                        + "quota reason");
        // Exit evidence is proven exactly when a Shell exits: any other
        // end carries no exit status.
        require("exited".equals(stopReason)
                ? !exitCode.isNull() || !exitSignal.isNull()
                : exitCode.isNull() && exitSignal.isNull(),
                "childRun exitCode or exitSignal is proven exactly when it "
                        + "exits");
    }

    /**
     * Whether {@code child} may be the first revision of a background
     * Shell: its run opens, nobody has asked it to stop yet, and it has
     * written no output, which needs a started process.
     */
    public static boolean isChildRunStart(JsonNode child) {
        return accepts(() -> requireChildRun(child))
                && isRunStart(child.get("run"))
                && !child.get("stopRequested").booleanValue()
                && child.get("outputRef").isNull();
    }

    /**
     * Whether {@code next} may follow {@code previous} as the next revision
     * of one background Shell: its identity is fixed, its run moves
     * forward, its start receipt is set once and never changes — a
     * re-attach under a later generation keeps the receipt whose process
     * it proves, while a changed receipt is refused as the shape of a
     * rerun — its stop request is set but never cleared, its output may
     * grow but is never removed, and once the run is terminal the total
     * freeze enforces everything, including that exit evidence can never
     * have been set beforehand.
     */
    public static boolean isChildRunSuccessor(JsonNode previous,
            JsonNode next) {
        if (!accepts(() -> requireChildRun(previous))
                || !accepts(() -> requireChildRun(next))) {
            return false;
        }
        for (String key : CHILD_FIXED) {
            if (!same(previous.get(key), next.get(key))) {
                return false;
            }
        }
        if (!isRunSuccessor(previous.get("run"), next.get("run"))
                || !previous.get("outputRef").isNull()
                        && next.get("outputRef").isNull()
                || previous.get("stopRequested").booleanValue()
                        && !next.get("stopRequested").booleanValue()
                || !previous.get("startReceiptRef").isNull()
                        && !same(previous.get("startReceiptRef"),
                                next.get("startReceiptRef"))) {
            return false;
        }
        if (TERMINAL.contains(text(previous.get("run"), "state"))) {
            return same(previous, next);
        }
        return true;
    }

    /**
     * Equality that compares numbers by value, so a record built in Java,
     * where 4 may be a long, matches the same record parsed from JSON.
     */
    private static boolean same(JsonNode left, JsonNode right) {
        return left.equals(SAME_VALUE, right);
    }

    private static boolean advances(String line, String from, String to) {
        return from.equals(to) || isTransitionAllowed(line, from, to);
    }

    private static boolean accepts(Runnable check) {
        try {
            check.run();
            return true;
        } catch (InvalidRecordException exception) {
            return false;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new InvalidRecordException(message + ".");
        }
    }

    static void closed(JsonNode node, Set<String> keys,
            String label) {
        require(node != null && node.isObject() && node.size() == keys.size(),
                label + " must be an object with exactly " + keys);
        node.fieldNames().forEachRemaining(name -> require(keys.contains(name),
                label + " must be an object with exactly " + keys));
    }

    static String id(JsonNode node, String label) {
        require(node != null && node.isTextual() && !node.textValue()
                .isEmpty(), label + " must be a non-empty string");
        String value = node.textValue();
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            require(character > 0x1f && (character < 0x7f || character > 0x9f),
                    label + " must not contain control characters");
            if (Character.isHighSurrogate(character)) {
                index++;
                require(index < value.length()
                        && Character.isLowSurrogate(value.charAt(index)),
                        label + " must be well-formed text");
            } else {
                require(!Character.isLowSurrogate(character),
                        label + " must be well-formed text");
            }
        }
        require(value.getBytes(StandardCharsets.UTF_8).length <= MAX_ID_BYTES,
                label + " exceeds " + MAX_ID_BYTES + " UTF-8 bytes");
        require(Normalizer.isNormalized(value, Normalizer.Form.NFC),
                label + " must use NFC normalization");
        return value;
    }

    /**
     * A millisecond timestamp read leniently, shared by the commit-side
     * extraction and the authorization journal scans: an integral number or
     * an integral numeric string of at most 19 integer digits and at most 19
     * decimal places, else absent. Anything fractional, out of range, or
     * otherwise shaped is absent, so the scans and the head columns can never
     * disagree about whether a payload was representable. The width and scale
     * pre-checks run before any BigInteger materialization, so an
     * exponent-form string cannot tax the reader in either direction
     * (1e+N needs the giant integer; 1e-N expands 10^N before dividing).
     */
    public static Long millisLenient(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        try {
            if (node.isNumber() || node.isTextual()) {
                BigDecimal value = node.isTextual()
                        ? new BigDecimal(node.textValue().trim())
                        : node.decimalValue();
                // A long holds at most 19 integer digits; never materialize
                // anything wider. Widen to long first: precision - scale can
                // itself overflow int on an extreme exponent. A scale beyond
                // 19 decimal places is likewise absent: toBigIntegerExact on
                // 1e-N expands 10^N before dividing, and a representable
                // long never needs more places.
                if ((long) value.precision() - value.scale() > 19
                        || value.scale() > 19) {
                    return null;
                }
                return value.toBigIntegerExact().longValueExact();
            }
        } catch (ArithmeticException | NumberFormatException error) {
            return null;
        }
        return null;
    }

    /**
     * A JSON number equal to an integer in range. As in JSON Schema and in
     * JavaScript, 1.0 counts as 1; a number past the double range, which
     * Jackson reads as an infinity, counts as none.
     */
    static long count(JsonNode node, long min, long max,
            String label) {
        BigDecimal value = node != null && node.isNumber()
                && Double.isFinite(node.doubleValue())
                ? node.decimalValue() : null;
        require(value != null && value.stripTrailingZeros().scale() <= 0
                && value.compareTo(BigDecimal.valueOf(min)) >= 0
                && value.compareTo(BigDecimal.valueOf(Math.min(max,
                        MAX_COUNT))) <= 0,
                label + " must be an integer from " + min + " to " + max);
        return value.longValueExact();
    }

    private static void digest(JsonNode node, String label) {
        require(node != null && node.isTextual()
                && DIGEST.matcher(node.textValue()).matches(),
                label + " must be a lowercase SHA-256 hex digest");
    }

    private static void generation(JsonNode node, String label) {
        require(node != null && node.isTextual()
                && GENERATION.matcher(node.textValue()).matches()
                && new BigInteger(node.textValue()).compareTo(MAX_GENERATION)
                        <= 0,
                label + " must be canonical decimal text from 1 to 2^63-1");
    }

    static void durableRef(JsonNode node, String label) {
        closed(node, Set.of("resourceId", "kind", "schemaVersion",
                "byteLength", "digest"), label);
        id(node.get("resourceId"), label + ".resourceId");
        id(node.get("kind"), label + ".kind");
        count(node.get("schemaVersion"), 0, MAX_COUNT,
                label + ".schemaVersion");
        count(node.get("byteLength"), 0, MAX_COUNT, label + ".byteLength");
        digest(node.get("digest"), label + ".digest");
    }

    private static String oneOf(JsonNode node, List<String> allowed,
            String label) {
        require(node != null && node.isTextual()
                && allowed.contains(node.textValue()),
                label + " must be one of " + allowed);
        return node.textValue();
    }

    private static String nullableOneOf(JsonNode node, List<String> allowed,
            String label) {
        return node != null && node.isNull() ? null
                : oneOf(node, allowed, label);
    }

    private static List<String> concat(List<String> first,
            List<String> second) {
        return Stream.concat(first.stream(), second.stream()).toList();
    }

    /** A checked field's text, or null when it holds JSON null. */
    private static String text(JsonNode record, String field) {
        return record.get(field).textValue();
    }

    private static BigInteger generationOf(JsonNode record, String field) {
        return new BigInteger(record.get(field).textValue());
    }

    private static JsonNode without(JsonNode record, String... fields) {
        ObjectNode copy = ((ObjectNode) record).deepCopy();
        copy.remove(List.of(fields));
        return copy;
    }
}
