package com.alibaba.qwen.code.managedagent.service;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
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
    private static final int MAX_RESULT_BYTES = 256 * 1024;
    /** Bounded retries before a fact is declared unknown, never guessed. */
    private static final int MAX_ATTEMPTS = 64;
    private static final long LEASE_MS = 30_000;
    /** The watch gap for a Turn that keeps running — a wait, not a failure. */
    private static final long HEARTBEAT_MS = 5_000;

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

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.child-relay.scan-delay:2s}")
    public void scan() {
        if (broker == null) {
            return;
        }
        for (PendingChild pending : relayStore
                .findPendingChildren(SCAN_LIMIT)) {
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
            // advance) instead of wedging the discovery window closed.
            RelayRow existing = relayStore.find(pending.tenantId(),
                    pending.parentSessionId(), pending.childRunId());
            if (existing == null || !"delivering".equals(existing.state())
                    && !"watching".equals(existing.state())) {
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
        // A parent that is closing or gone gets no acceptance, no wake and
        // no revival: the original result stays, classified, on this side.
        if (!"ACTIVE".equals(parentStatus)) {
            relayStore.classify(row, owner, "orphaned",
                    parentStatus == null ? "parent session is gone"
                            : "parent session is " + parentStatus,
                    now);
            return;
        }
        try {
            switch (row.state()) {
                case "creating" -> create(row, pending, now);
                case "binding" -> bind(row, now);
                case "watching" -> watch(row, pending, now);
                case "delivering" -> deliver(row, now);
                default -> {
                    return;
                }
            }
        } catch (RuntimeException error) {
            defer(row, error, now);
        }
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
        var admission = sessions.createChildSession(pending.tenantId(),
                pending.parentSessionId(), pending.childRunId(), description,
                prompt);
        relayStore.advance(row, owner, "binding", admission.sessionId(), 0,
                null, now + LEASE_MS, now);
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
        switch (turn.status()) {
            case "COMPLETED" -> complete(row, pending, turn, now);
            case "CANCELLED", "FAILED" -> {
                Map<String, Object> fail = new LinkedHashMap<>();
                fail.put("operationId", UUID.randomUUID().toString());
                fail.put("kind", "fail");
                fail.put("childRunId", row.childRunId());
                fail.put("stopReason", "child_failed");
                fail.put("started", true);
                harness.runChildOperation(row.tenantId(),
                        row.parentSessionId(), fail);
                closeFinishedChild(row, now);
                relayStore.classify(row, owner, "done",
                        "child Turn " + turn.status(), now);
            }
            // A running child is not a failed watch: look again after the
            // scan gap instead of eating the attempt budget — the lifetime
            // cap measures failures, never a child's own runtime.
            default -> relayStore.scheduleRetry(row, owner,
                    now + HEARTBEAT_MS,
                    now + LEASE_MS, now);
        }
    }

    private void complete(RelayRow row, PendingChild pending,
            ChildResultRelayStore.TurnLine turn, long now) {
        String text = relayStore.terminalResultText(row.tenantId(),
                row.childSessionId(), turn.turnId());
        if (text == null) {
            throw new RelayRetry(
                    "child Turn settled without an assistant result");
        }
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_RESULT_BYTES) {
            Map<String, Object> quota = new LinkedHashMap<>();
            quota.put("operationId", UUID.randomUUID().toString());
            quota.put("kind", "fail");
            quota.put("childRunId", row.childRunId());
            quota.put("stopReason", "quota_exceeded");
            quota.put("reason", "byte_limit");
            quota.put("started", true);
            harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                    quota);
            relayStore.classify(row, owner, "done",
                    "child result exceeds the copy bound", now);
            return;
        }
        JsonNode receiptJson = mapper.createObjectNode()
                .put("childSessionId", row.childSessionId())
                .put("turnId", turn.turnId())
                .put("status", turn.status())
                .put("completedAt",
                        turn.completedAt() == null ? 0L : turn.completedAt());
        String receipt = receiptJson.toString();
        Map<String, Object> commit = new LinkedHashMap<>();
        commit.put("operationId", UUID.randomUUID().toString());
        commit.put("kind", "commit_result");
        commit.put("childRunId", row.childRunId());
        commit.put("result", text);
        commit.put("receipt", receipt);
        harness.runChildOperation(row.tenantId(), row.parentSessionId(),
                commit);
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
        closeFinishedChild(row, now);
        relayStore.classify(row, owner, "done", null, now);
    }

    /** A run whose classification would be durable `done` owes its child
     * Session the close first: a `done` committed before that admission
     * exists would park the child with nothing owed anywhere — no ledger
     * scan and no operation row could ever find it again. The admission
     * is idempotent, a faltherd is owed and retried via the ordinary
     * relay defer, never settled on suspicion. */
    private void closeFinishedChild(RelayRow row, long now) {
        if (row.childSessionId() == null) {
            return;
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
    }

    private void defer(RelayRow row, RuntimeException error, long now) {
        if (row.attempts() + 1 >= MAX_ATTEMPTS) {
            relayStore.classify(row, owner, "unknown", error.getMessage(), now);
            LOG.warn("child result relay gives up tenant={} parent={}"
                    + " run={} after={} failure={}", row.tenantId(),
                    row.parentSessionId(), row.childRunId(), row.attempts(),
                    error.getMessage());
            return;
        }
        long delay = Math.min(300_000L,
                1_000L * (1L << Math.min(row.attempts(), 8)));
        relayStore.defer(row, owner, now + delay, error.getMessage(),
                now + LEASE_MS, now);
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
