package com.alibaba.qwen.code.managedagent.service;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore.PendingChild;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore.RelayRow;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

/**
 * H4b: the first cross-Session dispatcher — the child result relay. It
 * discovers child_agent runs whose delivery line still needs work,
 * drives their idempotent creation, commits the control-plane revisions
 * (dispatch, attach, result, acceptance, the delivered step), and
 * classifies what cannot be proven: a result reaching a closing or
 * closed parent is `orphaned` — recorded, never fed to a model; a fact
 * that stays unproven past its bounded retries is `unknown` — visible,
 * never re-executed. Every step reconciles from what is committed (the
 * parent's record chain, the child Session's rows) and never from its
 * own memory, so a restart of this worker, of the Java instance or of a
 * claim re-runs the same verbs idempotently.
 */
@Service
public class ChildResultRelay {
    private static final Logger LOG = LoggerFactory
            .getLogger(ChildResultRelay.class);
    private static final int SCAN_LIMIT = 50;
    // The copy bound is the parent's durable inline bound, never wider: a
    // result the resource store cannot inline gets the quota_exceeded /
    // byte_limit refusal with its proven classification, instead of a
    // deterministic 409 on every retry until the row gives up unknown.
    private static final int MAX_RESULT_BYTES =
            ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES;
    /** Bounded retries before a fact is declared unknown, never guessed. */
    private static final int MAX_ATTEMPTS = 64;
    private static final long LEASE_MS = 30_000;
    /** The watch gap for a Turn that keeps running — a wait, not a failure. */
    private static final long HEARTBEAT_MS = 5_000;
    // A close debt on a host without close capability cannot be
    // discharged until the capability returns, which takes a restart:
    // look again rarely instead of on every heartbeat.
    private static final long CLOSE_DEBT_IDLE_MS = 300_000;
    // H4d-b: a continuation's first input carries its chain's history,
    // measured as the JSON text the Hosted prompt bound reads, below that
    // 64 KiB bound with room for the record around it.
    private static final int CONTINUATION_INPUT_BYTES = 48 * 1024;
    private static final int CONTINUATION_CHAIN_LIMIT = 64;
    /** How long a delivered message may wait for the turn that reads it
     * without any activity in the child before it stops holding the
     * child's settlement (a blocked child would hold it forever). */
    private static final long MESSAGE_TURN_WAIT_MS = 30 * 60_000;

    private final ChildResultRelayStore relayStore;
    private final ManagedAgentService sessions;
    private final RuntimeBrokerService broker;
    private final HarnessConnector harness;
    private final ObjectMapper mapper;
    private final ChildLifecycleAdmissions childCloses;
    private final Supplier<Long> clock;
    private final String owner = "child-relay-" + UUID.randomUUID();

    @org.springframework.beans.factory.annotation.Autowired
    public ChildResultRelay(ChildResultRelayStore relayStore,
            ManagedAgentService sessions,
            org.springframework.beans.factory.ObjectProvider<RuntimeBrokerService> broker,
            HarnessConnector harness, ObjectMapper mapper,
            ChildLifecycleAdmissions childCloses) {
        this(relayStore, sessions, broker, harness, mapper, childCloses,
                System::currentTimeMillis);
    }

    ChildResultRelay(ChildResultRelayStore relayStore,
            ManagedAgentService sessions,
            org.springframework.beans.factory.ObjectProvider<RuntimeBrokerService> broker,
            HarnessConnector harness, ObjectMapper mapper,
            ChildLifecycleAdmissions childCloses,
            Supplier<Long> clock) {
        this.relayStore = relayStore;
        this.sessions = sessions;
        this.broker = broker.getIfAvailable();
        this.harness = harness;
        this.mapper = mapper;
        this.childCloses = childCloses;
        this.clock = clock;
    }

    // Its own one-thread scheduler: the default taskScheduler also ticks
    // every sibling recovery, and this scan's page of sequential harness
    // calls would otherwise stall all of theirs behind one slow Session.
    @Scheduled(scheduler = "childRelayScheduler", fixedDelayString =
            "${qwen.managed-agent.child-relay.scan-delay:2s}")
    public void scan() {
        if (broker == null) {
            return;
        }
        for (PendingChild pending : relayStore
                .findPendingChildren(owner, SCAN_LIMIT)) {
            try {
                work(pending);
            } catch (RuntimeException error) {
                LOG.warn("child result relay failed tenant={} parent={}"
                        + " run={} failure={}", pending.tenantId(),
                        pending.parentSessionId(), pending.childRunId(),
                        error.getMessage(), error);
            }
        }
    }

    private void work(PendingChild pending) {
        long now = clock.get();
        String parentStatus = relayStore.sessionStatus(pending.tenantId(),
                pending.parentSessionId());
        boolean accepted = relayStore.hasAcceptance(pending.tenantId(),
                pending.parentSessionId(), pending.childRunId());
        if (accepted) {
            // An answered acceptance short-circuits arms the relay never
            // owed a step on (creating/binding), and nothing else — the
            // delivering arm's mark_accepted is the relay's own owed step,
            // and a watching row whose accept committed but whose
            // advance to delivering was lost reconciles through the same
            // idempotent walk (replay the result, the acceptance, then the
            // advance) instead of wedging the discovery window closed. A
            // close_debt row's only owed verb is outliving the acceptance,
            // so it walks through too.
            RelayRow existing = relayStore.find(pending.tenantId(),
                    pending.parentSessionId(), pending.childRunId());
            if (existing == null || !"delivering".equals(existing.state())
                    && !"watching".equals(existing.state())
                    && !"close_debt".equals(existing.state())) {
                return;
            }
        }
        RelayRow row = relayStore.claim(pending.tenantId(),
                pending.parentSessionId(), pending.childRunId(),
                ManagedAgentService.childCreationKey(
                        pending.parentSessionId(), pending.childRunId()),
                owner, now + LEASE_MS, now);
        if (row == null || row.nextRetryAt() > now) {
            return;
        }
        // Retirement authorization never reads the discovery page's own
        // captured delivery — another worker can have settled the record
        // between the page and this claim, and a verdict on the stale
        // snapshot either relaunches or abandons owed work. Anything
        // below that decides by settlement reads the committed truth now.
        String delivery = relayStore.deliveryState(row.tenantId(),
                row.parentSessionId(), row.childRunId());
        if (delivery == null) {
            delivery = pending.deliveryState();
        }
        // A parent that is closing or gone gets no acceptance, no wake and
        // no revival: the original result stays, classified, on this side.
        // A retained close debt outlives that classification — the child
        // Session owes its close whoever the parent's writer was, so the
        // debt arm runs before the orphaned early-out could erase it.
        if (!"ACTIVE".equals(parentStatus)
                && !"close_debt".equals(row.state())) {
            // Whichever side of the parent-first race lands next, a standing
            // child always keeps its one discoverable holder: `orphaned`
            // now only closes out children that no longer stand (null or
            // already terminated), never one the record's own writer can
            // still owe. Debt on restart-capable or replay-request,
            // orphaned only when nobody is left to own anything further.
            String child = row.childSessionId() != null
                    ? row.childSessionId()
                    : relayStore.findLineageChild(row.tenantId(),
                            row.parentSessionId(), row.childRunId());
            if (child != null
                    && childSessionNeedsClose(row.tenantId(), child)) {
                relayStore.advance(row, owner, "close_debt", child,
                        now + HEARTBEAT_MS,
                        "close debt retained at parent "
                                + (parentStatus == null ? "gone"
                                        : parentStatus),
                        now + LEASE_MS, now);
                return;
            }
            relayStore.classify(row, owner, "orphaned",
                    parentStatus == null ? "parent session is gone"
                            : "parent session is " + parentStatus,
                    now);
            return;
        }
        // A settled-failed record whose terminal-classification write
        // never landed is discovered by the settled arm too, and it is
        // owed reconciliation, never a fresh walk: re-entering `create`
        // here relaunches work already recorded as never started, and
        // re-entering `watch`/`deliver` re-settles an already-terminal
        // record into a refusal loop. The owed residue is at most the
        // child Session's close, so it gets exactly that — parked debt
        // for a standing child, `unknown` where none stands.
        if ("cancelled".equals(delivery)
                && !"close_debt".equals(row.state())) {
            String child = row.childSessionId() != null
                    ? row.childSessionId()
                    : relayStore.findLineageChild(row.tenantId(),
                            row.parentSessionId(), row.childRunId());
            if (child != null
                    && childSessionNeedsClose(row.tenantId(), child)) {
                relayStore.advance(row, owner, "close_debt", child,
                        now + HEARTBEAT_MS,
                        "close debt retained over a settled record",
                        now + LEASE_MS, now);
                return;
            }
            relayStore.classify(row, owner, "unknown",
                    "record settled while the ledger walked "
                            + row.state(), now);
            return;
        }
        try {
            switch (row.state()) {
                case "creating" -> create(row, pending, now);
                case "binding" -> bind(row, now);
                case "watching" -> watch(row, pending, now);
                case "delivering" -> deliver(row, now);
                case "close_debt" -> dischargeCloseDebt(row, now);
                default -> {
                    return;
                }
            }
        } catch (RuntimeException error) {
            defer(row, error, now);
        }
    }

    /** The child Session still stands in an owning state: its row must
     * exist and be short of CLOSED/DELETED (a close already in flight
     * counts — the retained admission replays it idempotently). */
    private boolean childSessionNeedsClose(String tenantId, String child) {
        String status = relayStore.sessionStatus(tenantId, child);
        return status != null && !"CLOSED".equals(status)
                && !"DELETED".equals(status);
    }

    private void create(RelayRow row, PendingChild pending, long now) {
        JsonNode body = readJson(relayStore.readResource(pending.tenantId(),
                pending.recordResourceId()), "child run body");
        String inputResource = body.required("inputRef")
                .required("resourceId").asText();
        JsonNode envelope = readJson(
                relayStore.readResource(pending.tenantId(), inputResource),
                "child launch envelope");
        String description = envelope.required("description").asText();
        String prompt = envelope.required("prompt").asText();
        JsonNode predecessor = body.path("predecessorChildRunId");
        if (predecessor.isTextual()) {
            prompt = continuationPrompt(pending, predecessor.textValue(),
                    prompt);
        }
        var admission = sessions.createChildSession(pending.tenantId(),
                pending.parentSessionId(), pending.childRunId(), description,
                prompt);
        relayStore.advance(row, owner, "binding", admission.sessionId(), 0,
                null, now + LEASE_MS, now);
    }

    /**
     * H4d-b: a continuation runs in a new child Session, so its first input
     * carries the chain's history — each earlier run's instruction and
     * result from the parent's own committed records, oldest first — and
     * then the new instruction. The history is bounded below the Hosted
     * prompt bound by leaving the oldest runs out (the newest one is cut
     * instead when it alone does not fit), and it is composed only from
     * committed records, so a replayed creation names the same input.
     */
    private String continuationPrompt(PendingChild pending,
            String predecessorId, String message) {
        List<String[]> runs = new ArrayList<>();
        String id = predecessorId;
        while (id != null && runs.size() < CONTINUATION_CHAIN_LIMIT) {
            JsonNode run = relayStore.childRunBody(pending.tenantId(),
                    pending.parentSessionId(), id);
            if (run == null || !run.path("resultRef").isObject()) {
                throw new RelayRetry("continued run " + id
                        + " has no readable result yet");
            }
            String instruction = readJson(relayStore.readResource(
                    pending.tenantId(), run.required("inputRef")
                            .required("resourceId").asText()),
                    "continued run's launch envelope")
                    .required("prompt").asText();
            String result = relayStore.readResource(pending.tenantId(),
                    run.required("resultRef").required("resourceId")
                            .asText());
            if (result == null) {
                throw new RelayRetry("continued run " + id
                        + "'s result is not readable yet");
            }
            // The earlier texts are data inside the history's own markup:
            // escaped, so no earlier result can close a block or forge the
            // next instruction.
            runs.add(new String[] {escapeXml(instruction), escapeXml(result)});
            JsonNode previous = run.path("predecessorChildRunId");
            id = previous.isTextual() ? previous.textValue() : null;
        }
        String head = "This continues your earlier work on this task. Your"
                + " earlier instructions and results follow, oldest first;"
                + " the oldest are left out when they do not fit.\n\n";
        String tail = "Your next instruction:\n" + message;
        int budget = CONTINUATION_INPUT_BYTES - jsonBytes(head + tail);
        List<String> blocks = new ArrayList<>();
        for (String[] run : runs) {
            String block = earlierRun(run[0], run[1]);
            if (jsonBytes(block) <= budget) {
                blocks.add(block);
                budget -= jsonBytes(block);
                continue;
            }
            if (blocks.isEmpty()) {
                String instruction = fit(run[0], budget / 3);
                blocks.add(earlierRun(instruction, fit(run[1],
                        budget - jsonBytes(earlierRun(instruction, "")))));
            }
            break;
        }
        Collections.reverse(blocks);
        return head + String.join("", blocks) + tail;
    }

    private static String earlierRun(String instruction, String result) {
        return "<earlier-run>\n<instruction>\n" + instruction
                + "\n</instruction>\n<result>\n" + result
                + "\n</result>\n</earlier-run>\n\n";
    }

    /** The longest code-point prefix of {@code text} that fits {@code
     * budget} JSON bytes together with its truncation marker, never ending
     * inside an escaped entity. */
    private String fit(String text, int budget) {
        String marker = "\n… (truncated)";
        if (jsonBytes(text) <= budget) {
            return text;
        }
        int[] points = text.codePoints().toArray();
        int low = 0;
        int high = points.length;
        while (low < high) {
            int middle = (low + high + 1) >>> 1;
            if (jsonBytes(new String(points, 0, middle) + marker) <= budget) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        String kept = new String(points, 0, low);
        int entity = kept.lastIndexOf('&');
        if (entity > kept.lastIndexOf(';')) {
            kept = kept.substring(0, entity);
        }
        return kept + marker;
    }

    private static String escapeXml(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;");
    }

    private int jsonBytes(String text) {
        try {
            return mapper.writeValueAsString(text)
                    .getBytes(StandardCharsets.UTF_8).length;
        } catch (Exception error) {
            throw new IllegalStateException("continuation text is unwritable",
                    error);
        }
    }

    private void bind(RelayRow row, long now) {
        if (row.childSessionId() == null) {
            relayStore.advance(row, owner, "creating", null, 0,
                    "creation answer lost", now + LEASE_MS, now);
            return;
        }
        // The physical Runtime binding exists from the construction of the
        // child's Hosted tool turn — a child that answers end-to-end in
        // plain text holds one without ever acquiring a tool Session.
        RuntimeBindingRecord binding = broker == null ? null
                : broker.findLatestBindingByHarnessSession(row.tenantId(),
                        row.childSessionId());
        if (binding == null) {
            throw new RelayRetry("child runtime binding is not visible yet");
        }
        String generation = Long.toString(binding.getGeneration());
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("operationId", UUID.randomUUID().toString());
        operation.put("kind", "dispatch_started");
        operation.put("childRunId", row.childRunId());
        operation.put("dispatchId", row.creationKey());
        operation.put("runtimeBindingId", binding.getBindingId());
        operation.put("generation", generation);
        harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                operation);
        Map<String, Object> attach = new LinkedHashMap<>();
        attach.put("operationId", UUID.randomUUID().toString());
        attach.put("kind", "attach");
        attach.put("childRunId", row.childRunId());
        attach.put("childSessionId", row.childSessionId());
        harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                attach);
        relayStore.advance(row, owner, "watching", row.childSessionId(), 0,
                null, now + LEASE_MS, now);
    }

    private void watch(RelayRow row, PendingChild pending, long now) {
        if (row.childSessionId() == null) {
            relayStore.advance(row, owner, "creating", null, 0,
                    "creation answer lost", now + LEASE_MS, now);
            return;
        }
        ChildResultRelayStore.TurnLine turn = relayStore.latestTurn(
                row.tenantId(), row.childSessionId());
        if (turn == null) {
            throw new RelayRetry("child Session has no Turn yet");
        }
        String status = turn.status();
        String turnId = turn.turnId();
        long completedAt = turn.completedAt() == null ? 0L
                : turn.completedAt();
        boolean journalTurn = false;
        Integer messageCount = null;
        if ("COMPLETED".equals(status) || "CANCELLED".equals(status)
                || "FAILED".equals(status)) {
            // H4d-b: the child's result is its newest settled API or message
            // turn, and only once nothing on its edge is still on its way.
            // The journal is read first: a turn that messages the parent
            // commits that outbox entry before it settles, so the edge read
            // after an idle journal misses nothing the child sent. A message
            // waiting for its turn holds the settlement — the message
            // relay's reconciliation reloads a child a replaced Harness
            // dropped — but not past MESSAGE_TURN_WAIT_MS of no activity.
            ChildResultRelayStore.JournalTurns journal = journalTurns(row);
            if (journal != null) {
                if (journal.pendingMessageInputs() > 0
                        && now - journal.lastActivityAt()
                                < MESSAGE_TURN_WAIT_MS) {
                    relayStore.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                            now + LEASE_MS, now);
                    return;
                }
                ChildResultRelayStore.SettledTurn last = journal.lastSettled();
                if (last != null && "session_message".equals(last.source())) {
                    status = "completed".equals(last.outcome()) ? "COMPLETED"
                            : "FAILED";
                    turnId = last.turnId();
                    completedAt = last.settledAt();
                    journalTurn = true;
                }
            }
            ChildResultRelayStore.EdgeMessages edge = relayStore.edgeMessages(
                    row.tenantId(), row.parentSessionId(), row.childRunId(),
                    row.childSessionId());
            if (edge.undelivered() > 0) {
                relayStore.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                        now + LEASE_MS, now);
                return;
            }
            messageCount = edge.toChild();
        }
        try {
            settleFrom(row, pending, status, turnId, completedAt, journalTurn,
                    messageCount, now);
        } catch (DaemonHttpException error) {
            if (!"child_messages_pending".equals(error.getErrorCode())) {
                throw error;
            }
            // A message opened after the reads above: watch again.
            relayStore.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                    now + LEASE_MS, now);
        }
    }

    /** The child's journal turns, or null where a compacted journal of a
     * child that never messaged leaves H4b's API Turn result alone. */
    private ChildResultRelayStore.JournalTurns journalTurns(RelayRow row) {
        try {
            return relayStore.journalTurns(row.tenantId(),
                    row.childSessionId());
        } catch (IllegalStateException error) {
            if (relayStore.hasSessionMessages(row.tenantId(),
                    row.childSessionId())) {
                throw error;
            }
            return null;
        }
    }

    private void settleFrom(RelayRow row, PendingChild pending,
            String status, String turnId, long completedAt,
            boolean journalTurn, Integer messageCount, long now) {
        switch (status) {
            case "COMPLETED" -> complete(row, pending, status, turnId,
                    completedAt, journalTurn, messageCount, now);
            case "CANCELLED", "FAILED" -> {
                // Close before the fail commit: a faltered admission now
                // parks the row while delivery is still discoverable; the
                // fail commit itself moves delivery to `cancelled`, which
                // the discovery page keeps surfacing until the close has
                // durably admitted and classify lands. A host without the
                // close capability at all settles on time and keeps the
                // debt as close_debt instead.
                boolean closed = closeFinishedChild(row, now);
                Map<String, Object> fail = new LinkedHashMap<>();
                fail.put("operationId", UUID.randomUUID().toString());
                fail.put("kind", "fail");
                fail.put("childRunId", row.childRunId());
                fail.put("stopReason", "child_failed");
                fail.put("started", true);
                if (messageCount != null) {
                    fail.put("messageCount", messageCount);
                }
                harness.runChildOperation(row.tenantId(),
                        row.parentSessionId(), fail);
                finishOrRetainDebt(row, row.childSessionId(), closed, "done",
                        "child Turn " + status, now);
            }
            // A running child is not a failed watch: look again after the
            // scan gap instead of eating the attempt budget — the lifetime
            // cap measures failures, never a child's own runtime.
            default -> relayStore.scheduleRetry(row, owner,
                    now + HEARTBEAT_MS,
                    now + LEASE_MS, now);
        }
    }

    private void complete(RelayRow row, PendingChild pending, String status,
            String turnId, long completedAt, boolean journalTurn,
            Integer messageCount, long now) {
        JsonNode settled = relayStore.childRunBody(row.tenantId(),
                row.parentSessionId(), row.childRunId());
        if (settled != null && settled.path("resultRef").isObject()) {
            // The result already committed (its reply was lost): the newest
            // turn may have moved since, and a recomputed result would only
            // conflict with the committed one, so the acceptance follows it.
            accept(row, pending, now);
            return;
        }
        String text = journalTurn
                ? relayStore.journalTurnText(row.tenantId(),
                        row.childSessionId(), turnId)
                : relayStore.terminalResultText(row.tenantId(),
                        row.childSessionId(), turnId);
        if (text == null) {
            throw new RelayRetry(
                    "child Turn settled without an assistant result");
        }
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_RESULT_BYTES) {
            // The same done-arm debt as every sibling: the close lands
            // before any classification — and before the fail commit that
            // moves delivery to `cancelled` — so a faltered admission can
            // never strand the child Session behind a terminal row.
            boolean closed = closeFinishedChild(row, now);
            Map<String, Object> quota = new LinkedHashMap<>();
            quota.put("operationId", UUID.randomUUID().toString());
            quota.put("kind", "fail");
            quota.put("childRunId", row.childRunId());
            quota.put("stopReason", "quota_exceeded");
            quota.put("reason", "byte_limit");
            quota.put("started", true);
            harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                    quota);
            finishOrRetainDebt(row, row.childSessionId(), closed, "done",
                    "child result exceeds the copy bound", now);
            return;
        }
        JsonNode receiptJson = mapper.createObjectNode()
                .put("childSessionId", row.childSessionId())
                .put("turnId", turnId)
                .put("status", status)
                .put("completedAt", completedAt);
        String receipt = receiptJson.toString();
        Map<String, Object> commit = new LinkedHashMap<>();
        commit.put("operationId", UUID.randomUUID().toString());
        commit.put("kind", "commit_result");
        commit.put("childRunId", row.childRunId());
        commit.put("result", text);
        commit.put("receipt", receipt);
        if (messageCount != null) {
            commit.put("messageCount", messageCount);
        }
        harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                commit);
        accept(row, pending, now);
    }

    /** The acceptance of a committed result, on its completion arm. */
    private void accept(RelayRow row, PendingChild pending, long now) {
        // The acceptance rides the launch's own completion arm: a sent
        // child wakes the parent with a durable notification input; a
        // foreground child's acceptance commits alone and its answer
        // arrives through the original tool result, never a second wake.
        JsonNode body = readJson(relayStore.readResource(pending.tenantId(),
                pending.recordResourceId()), "child run body");
        boolean background = "sent"
                .equals(body.required("completion").asText());
        Map<String, Object> accept = new LinkedHashMap<>();
        accept.put("operationId", UUID.randomUUID().toString());
        accept.put("kind", "accept");
        accept.put("childRunId", row.childRunId());
        if (background) {
            Map<String, Object> notification = new LinkedHashMap<>();
            notification.put("description", readJson(
                    relayStore.readResource(pending.tenantId(), body
                            .required("inputRef").required("resourceId")
                            .asText()),
                    "child launch envelope").required("description")
                    .asText());
            accept.put("notification", notification);
        }
        harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                accept);
        relayStore.advance(row, owner, "delivering", row.childSessionId(), 0,
                null, now + LEASE_MS, now);
    }

    private void deliver(RelayRow row, long now) {
        Map<String, Object> accepted = new LinkedHashMap<>();
        accepted.put("operationId", UUID.randomUUID().toString());
        accepted.put("kind", "mark_accepted");
        accepted.put("childRunId", row.childRunId());
        harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                accepted);
        boolean closed = closeFinishedChild(row, now);
        finishOrRetainDebt(row, row.childSessionId(), closed, "done", null,
                now);
    }

    /** A run whose classification would be durable `done` owes its child
     * Session the close first: a `done` committed before that admission
     * exists would park the child with nothing owed anywhere — no ledger
     * scan and no operation row could ever find it again. The admission
     * is idempotent, a faltherd is owed and retried via the ordinary
     * relay defer, never settled on suspicion. A host that cannot close
     * Workspace Sessions at all differs from a faltered admission: no
     * retry here can ever land the close, so the settlement must not wait
     * on it — the caller retains the debt instead (false), parked as a
     * discoverable `close_debt` row that a later capable scan discharges.
     * Returns false only then; anything else either admitted or had no
     * child to close. */
    private boolean closeFinishedChild(RelayRow row, long now) {
        if (row.childSessionId() == null) {
            return true;
        }
        if (!childCloses.closeSupported()) {
            return false;
        }
        try {
            childCloses.admitChildClose(row.tenantId(),
                    row.parentSessionId(), row.childSessionId(),
                    row.childRunId());
        } catch (RuntimeException error) {
            relayStore.advance(row, owner, row.state(), row.childSessionId(),
                    0, "child close admission faltered",
                    now + LEASE_MS, now);
            LOG.warn("child result relay's close admission for a done child"
                            + " faltered tenant={} parent={} run={} child={}"
                            + " — owed, retried on the ledger row; failure={}",
                    row.tenantId(), row.parentSessionId(), row.childRunId(),
                    row.childSessionId(), error.getMessage());
            throw error;
        }
        return true;
    }

    /** The terminal write of every settled arm: with its close admitted
     * the row retires to its proven classification; without close
     * capability the settled record already freed its quota and the
     * parent's next Turn, so the row keeps only the close debt — parked
     * due on the heartbeat, named by the child id, still claimed, and
     * still discoverable, because a settled parent record is not the
     * child Session's close and discarding this row would strand the
     * ACTIVE child with no durable owner anywhere. */
    private void finishOrRetainDebt(RelayRow row, String child,
            boolean closed, String classification, String lastError,
            long now) {
        if (closed) {
            relayStore.classify(row, owner, classification, lastError, now);
            return;
        }
        relayStore.advance(row, owner, "close_debt", child,
                now + HEARTBEAT_MS,
                "close debt retained: host cannot close a Workspace Session",
                now + LEASE_MS, now);
    }

    /** A retained close debt owes exactly one verb: admit the durable
     * close. No capability yet is a wait, not a failure — look again on
     * the heartbeat without eating the attempt budget; a faltered
     * admission parks as ever; the admission lands → terminal, with the
     * prior error line kept, because the record's own settled revision
     * (never this ledger state) is the consumption truth either way. */
    private void dischargeCloseDebt(RelayRow row, long now) {
        if (row.childSessionId() == null) {
            relayStore.classify(row, owner, "done", row.lastError(), now);
            return;
        }
        if (!childCloses.closeSupported()) {
            relayStore.scheduleRetry(row, owner, now + CLOSE_DEBT_IDLE_MS,
                    now + LEASE_MS, now);
            return;
        }
        // A debt whose child no longer stands is discharged by fact, not
        // retried by suspicion: admission would refuse permanently, and
        // nothing but this re-read can tell the two apart for days.
        if (!childSessionNeedsClose(row.tenantId(), row.childSessionId())) {
            relayStore.classify(row, owner, "done", row.lastError(), now);
            return;
        }
        try {
            childCloses.admitChildClose(row.tenantId(),
                    row.parentSessionId(), row.childSessionId(),
                    row.childRunId());
        } catch (RuntimeException error) {
            relayStore.advance(row, owner, "close_debt", row.childSessionId(),
                    0, "child close admission faltered", now + LEASE_MS,
                    now);
            LOG.warn("child result relay's close-debt discharge faltered"
                            + " tenant={} parent={} run={} child={} — owed,"
                            + " retried on the ledger row; failure={}",
                    row.tenantId(), row.parentSessionId(), row.childRunId(),
                    row.childSessionId(), error.getMessage());
            throw error;
        }
        relayStore.classify(row, owner, "done", row.lastError(), now);
    }

    private void defer(RelayRow row, RuntimeException error, long now) {
        if (row.attempts() + 1 >= MAX_ATTEMPTS
                && !"close_debt".equals(row.state())) {
            // The close and the parent settlement outlive the bounded
            // retries, and this row is their only durable holder: the
            // give-up chain owes and retries on any refusal instead of
            // retiring the ledger with the debt still airborne.
            settleThenClassifyGaveUp(row, error, now);
            return;
        }
        long delay = Math.min(300_000L,
                1_000L * (1L << Math.min(row.attempts(), 8)));
        relayStore.defer(row, owner, now + delay, error.getMessage(),
                now + LEASE_MS, now);
    }

    /**
     * The give-up chain, attach truth first: the replayed `attach` op IS
     * the parent's committed dispatch/attach evidence — a replay landing
     * means the record really attached (the owed step commits cleanly
     * even after its reply was lost, and the ledger's own walk never
     * decides). Then the ordinary close admission, the settle with that
     * pairing, and only then the classification. Any refusal anywhere
     * owes through the ordinary defer; the row never retires with the
     * debt airborne. A host without close capability at all settles the
     * parent record on time (the give-up and its pairing are proven
     * facts, not capability-held), then parks the row as `close_debt` —
     * the settlement is nobody's close, so the ledger keeps the owed
     * admission discoverable instead of classifying `unknown` over it.
     */
    private void settleThenClassifyGaveUp(RelayRow row,
            RuntimeException error, long now) {
        String resolvedChild;
        boolean closed;
        try {
            // Resolve the child BEFORE choosing the failure proof: a lost
            // relay session id is not evidence that execution never
            // began — the committed lineage row names the same child.
            String child = row.childSessionId() != null ? row.childSessionId()
                    : relayStore.findLineageChild(row.tenantId(),
                            row.parentSessionId(), row.childRunId());
            boolean started = reconcileAttach(row, child);
            // A no-child proof read before the create side resumed is only
            // pre-collapse evidence: a creation committing between that
            // read and this request turns creation_failed into a wrong
            // verdict over a running child. At the commit seam, re-read
            // what the file side can prove now; new evidence owes one more
            // bounded wait instead of the confidently wrong pairing.
            if (!started) {
                String lateChild = relayStore.findLineageChild(row.tenantId(),
                        row.parentSessionId(), row.childRunId());
                if (lateChild != null && !lateChild.equals(child)) {
                    throw new RelayRetry("child lineage materialized after"
                            + " the no-child proof");
                }
            }
            // One read of the capability feeds both decisions: reading it
            // twice could flip between the admit order and the retention
            // flag and silently lose the debt either way.
            boolean closeActionable = child != null
                    && childCloses.closeSupported();
            closed = child == null || closeActionable;
            if (closeActionable) {
                childCloses.admitChildClose(row.tenantId(),
                        row.parentSessionId(), child, row.childRunId());
            }
            Map<String, Object> fail = new LinkedHashMap<>();
            fail.put("operationId", UUID.randomUUID().toString());
            fail.put("kind", "fail");
            fail.put("childRunId", row.childRunId());
            fail.put("stopReason", started ? "child_failed" : "creation_failed");
            fail.put("started", started);
            if (child != null) {
                // A minted child dies named: the terminal verdict carries
                // the Session the creation committed, so the close owed
                // it is never invented out of the ledger's absence later.
                fail.put("childSessionId", child);
            }
            harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                    fail);
            resolvedChild = child;
        } catch (RuntimeException settlementError) {
            LOG.warn("child result relay's give-up chain owes and retries"
                            + " tenant={} parent={} run={} — the row keeps"
                            + " the debt; failure={}", row.tenantId(),
                    row.parentSessionId(), row.childRunId(),
                    settlementError.getMessage(), settlementError);
            relayStore.defer(row, owner,
                    now + Math.min(300_000L,
                            1_000L * (1L << Math.min(row.attempts(), 8))),
                    settlementError.getMessage(), now + LEASE_MS, now);
            return;
        }
        finishOrRetainDebt(row, resolvedChild, closed, "unknown",
                error.getMessage(), now);
        LOG.warn("child result relay gives up tenant={} parent={}"
                        + " run={} after={} failure={} closeDebt={}",
                row.tenantId(), row.parentSessionId(), row.childRunId(),
                row.attempts(), error.getMessage(), !closed);
    }

    /**
     * Whether the parent's committed record PROVES the run started, read
     * from the record itself, never guessed from a wire answer. Rows
     * past the watch already proved it by their committed walk. A run
     * whose record still sits at `intent` never dispatched — `intent`'s
     * own successors are `dispatch_started` and `not_started_proven`,
     * and refusing code like `child_operation_...` carries no start
     * evidence whether 409 too, or sketchier. The window that committed
     * its child but lost the chain replays from the same evidence the
     * coordinator uses: the lineage names the child, the binding tells
     * the physical identity — anything unprovable simply defers, never
     * inventedverdicts.
     */
    private boolean reconcileAttach(RelayRow row, String child) {
        if ("watching".equals(row.state()) || "delivering".equals(row.state())) {
            return true;
        }
        String execution = relayStore.executionState(row.tenantId(),
                row.parentSessionId(), row.childRunId());
        if (execution == null) {
            // Nothing written about the run at all: absence of commit
            // evidence itself is the proof of never-started.
            return false;
        }
        if ("not_started_proven".equals(execution)) {
            // The record already carries its own never-started proof:
            // the only truthful pairing left is the unstarted one.
            return false;
        }
        if ("intent".equals(execution)) {
            ChildResultRelayStore.TurnLine childTurn = child == null ? null
                    : relayStore.latestTurn(row.tenantId(), child);
            if (childTurn != null && !childTurn.dispatched()
                    && !childTurn.preAdmissionTerminal()) {
                // The Turn is enqueued, not failed: a live Turn with an
                // outstanding outcome shares the undispatched shape with
                // the terminal one, and a pairing minted ahead of it is
                // the same false verdict with better timing — the give-up
                // owes the bounded wait until the coordinator settles the
                // admission one way or the other.
                throw new RelayRetry("child Turn admitted but its"
                        + " admission never landed yet");
            }
            RuntimeBindingRecord binding = child == null ? null
                    : broker.findLatestBindingByHarnessSessionAnyState(
                            row.tenantId(), child);
            if ((childTurn != null && childTurn.dispatched())
                    || binding != null) {
                // Dispatch evidence of one honest kind or the other: the
                // proven G3 pair, or the historical binding row — the
                // reset mark cannot disprove what it proves (G3 withdraws
                // the mark after a lost reply, and a terminal status never
                // upgrades that reset to proof of non-admission, R25).
                // The chain replays dispatch first (intent allows exactly
                // that successor), then the attach — from the binding's
                // own identity, warmth never required to rebuild a record.
                if (binding == null) {
                    throw new RelayRetry("child provably dispatched, yet"
                            + " its binding's own dispatch is not an honest"
                            + " chain");
                }
                Map<String, Object> dispatch = new LinkedHashMap<>();
                dispatch.put("operationId", UUID.randomUUID().toString());
                dispatch.put("kind", "dispatch_started");
                dispatch.put("childRunId", row.childRunId());
                dispatch.put("dispatchId", row.creationKey());
                dispatch.put("runtimeBindingId", binding.getBindingId());
                dispatch.put("generation",
                        Long.toString(binding.getGeneration()));
                harness.runChildOperation(row.tenantId(),
                        row.parentSessionId(), dispatch);
                attachReplay(row, child);
                return true;
            }
            // Record truth: truly nothing ever dispatched — the
            // `creation_failed` pairing is the lawful verdict here.
            return false;
        }
        if ("dispatch_started".equals(execution)) {
            // Just the ack was lost: a replay of attach is the same
            // command, owning the same truth the record confirms now.
            attachReplay(row, child);
            return true;
        }
        // running_attached or past it: the record confirms alone.
        return true;
    }

    private void attachReplay(RelayRow row, String child) {
        Map<String, Object> attach = new LinkedHashMap<>();
        attach.put("operationId", UUID.randomUUID().toString());
        attach.put("kind", "attach");
        attach.put("childRunId", row.childRunId());
        attach.put("childSessionId", child);
        harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                attach);
    }

    private JsonNode readJson(String content, String label) {
        if (content == null) {
            throw new RelayRetry(label + " is not readable yet");
        }
        try {
            return mapper.readTree(content);
        } catch (Exception error) {
            throw new IllegalStateException(label + " is unreadable", error);
        }
    }

    private static final class RelayRetry extends RuntimeException {
        RelayRetry(String message) {
            super(message);
        }
    }
}
