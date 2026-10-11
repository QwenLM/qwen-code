package com.alibaba.qwen.code.managedagent.service;

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore.MessageRow;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore.PendingMessage;

/**
 * H4d-b: the session message relay. It discovers outbox entries whose
 * delivery still needs work, fixes each one's target at the handover,
 * commits the receipt into the target together with the input and wake
 * that carry it, and advances the sender as the target accepts and then
 * consumes it. A message to a child is held until the Harness admitted
 * the child's task. A message whose child run ended before the handover,
 * or whose task ended without an admission, or
 * whose target is gone, is cancelled or rejected on the sender; one whose
 * sender is closing or gone is `orphaned` here, since its own journal can
 * no longer take a revision; one that stays unproven past its bounded
 * retries is `unknown`. Every step reconciles from the two journals'
 * committed records and replays idempotently, so a restart of this worker
 * re-runs the same verbs and never delivers a message twice. See
 * docs/design/2026-10-10-managed-session-message-runtime.md.
 */
@Service
public class SessionMessageRelay {
    private static final Logger LOG = LoggerFactory
            .getLogger(SessionMessageRelay.class);
    private static final int SCAN_LIMIT = 50;
    private static final int MAX_ATTEMPTS =
            SessionMessageRelayStore.MAX_ATTEMPTS;
    private static final long LEASE_MS = 30_000;
    /** The gap for a wait on the other side — an attach, a busy parent. */
    private static final long HEARTBEAT_MS = 5_000;
    /** The gap while a handed-over message waits to be read. */
    private static final long AWAIT_MS = 15_000;
    private static final long MAX_BACKOFF_MS = 300_000;
    private static final Set<String> TERMINAL_TURNS =
            Set.of("COMPLETED", "FAILED", "CANCELLED");

    private final SessionMessageRelayStore store;
    private final ChildResultRelayStore records;
    private final HarnessConnector harness;
    private final ObjectMapper mapper;
    private final Supplier<Long> clock;
    private final String owner = "message-relay-" + UUID.randomUUID();

    @Autowired
    public SessionMessageRelay(SessionMessageRelayStore store,
            ChildResultRelayStore records, HarnessConnector harness,
            ObjectMapper mapper) {
        this(store, records, harness, mapper, System::currentTimeMillis);
    }

    SessionMessageRelay(SessionMessageRelayStore store,
            ChildResultRelayStore records, HarnessConnector harness,
            ObjectMapper mapper, Supplier<Long> clock) {
        this.store = store;
        this.records = records;
        this.harness = harness;
        this.mapper = mapper;
        this.clock = clock;
    }

    @Scheduled(scheduler = "messageRelayScheduler", fixedDelayString =
            "${qwen.managed-agent.message-relay.scan-delay:2s}")
    public void scan() {
        // An instance without a Harness (a Session Store replica) leaves the
        // ledger to one with it: a claim it cannot work only counts
        // failures against the entry and delays its real worker.
        if (!harness.isAvailable()) {
            return;
        }
        for (PendingMessage pending : store.findPendingMessages(owner,
                clock.get(), SCAN_LIMIT)) {
            try {
                work(pending);
            } catch (RuntimeException error) {
                LOG.warn("session message relay failed tenant={} sender={}"
                        + " message={} failure={}", pending.tenantId(),
                        pending.senderSessionId(), pending.messageId(),
                        error.getMessage(), error);
            }
        }
    }

    private void work(PendingMessage pending) {
        long now = clock.get();
        MessageRow row = store.claim(pending.tenantId(),
                pending.senderSessionId(), pending.messageId(), owner,
                now + LEASE_MS, now);
        if (row == null || row.nextRetryAt() > now) {
            return;
        }
        // The page is a snapshot: another worker can have advanced the
        // entry since, so the delivery and the body it decides by are the
        // ones committed now.
        SessionMessageRelayStore.CurrentRecord current = store.currentRecord(
                row.tenantId(), row.senderSessionId(), row.messageId());
        if (current == null) {
            return;
        }
        try {
            JsonNode body = readJson(records.readResource(row.tenantId(),
                    current.recordResourceId()), "message body");
            String senderStatus = records.sessionStatus(row.tenantId(),
                    row.senderSessionId());
            if (!"ACTIVE".equals(senderStatus)) {
                // A closing or gone sender's journal takes no further
                // revision: the entry stays as committed, classified here.
                // One its target already received was delivered — H4b
                // closes a child right after its settlement — and the
                // target's receipt stays the consumption truth.
                String target = body.path("targetSessionId").isTextual()
                        ? body.path("targetSessionId").textValue() : null;
                boolean delivered = "accepted".equals(current.deliveryState())
                        || target != null && store.deliveryState(
                                row.tenantId(), target, row.messageId()) != null;
                store.classify(row, owner, delivered ? "done" : "orphaned",
                        senderStatus == null ? "sender session is gone"
                                : "sender session is " + senderStatus,
                        now);
                return;
            }
            if ("to_parent".equals(body.required("route").asText())
                    && stopStillSettling(row, body, row.senderSessionId())) {
                // H4f: while a stopped run's child still owes message work,
                // the child relay's stop is settling it. The child's own
                // outbox steps would attach it, and a load could start a
                // message the stop is about to cancel, so they wait for
                // that work to be settled; after it a load starts nothing,
                // and the entry proceeds, so the run's settlement, which
                // waits on this entry, is never left waiting on it.
                store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                        now + LEASE_MS, now);
                return;
            }
            switch (current.deliveryState()) {
                case "planned" -> handover(row, body, now);
                case "accepting", "unknown" -> deliver(row, body,
                        target(body), now);
                case "accepted" -> awaitConsumption(row, body, now);
                default -> store.classify(row, owner, "done", null, now);
            }
        } catch (RuntimeException error) {
            defer(row, error, now);
        }
    }

    /** Whether the message's child run carries a committed stop request
     * and its child still owes message work the stop is settling. */
    private boolean stopStillSettling(MessageRow row, JsonNode body,
            String child) {
        if (!childRunStopped(row, body)
                || !records.hasSessionMessages(row.tenantId(), child)) {
            return false;
        }
        return records.journalTurns(row.tenantId(), child)
                .pendingMessageInputs() > 0;
    }

    /** Whether the message's child run carries a committed stop request. */
    private boolean childRunStopped(MessageRow row, JsonNode body) {
        String parent = row.senderSessionId();
        if ("to_parent".equals(body.required("route").asText())) {
            SessionMessageRelayStore.Lineage lineage = store.lineage(
                    row.tenantId(), row.senderSessionId());
            if (lineage == null) {
                return false;
            }
            parent = lineage.parentSessionId();
        }
        JsonNode run = records.childRunBody(row.tenantId(), parent,
                body.required("childRunId").asText());
        return run != null && run.path("stopRequested").asBoolean(false);
    }

    /** The receipt's input, as the Hosted side derives it
     * (sessionMessageInputId); its sender refuses any other id. */
    private static String inputIdOf(String messageId) {
        return messageId + ":message";
    }

    private static String target(JsonNode body) {
        JsonNode target = body.path("targetSessionId");
        if (!target.isTextual()) {
            throw new IllegalStateException(
                    "a handed-over message names no target");
        }
        return target.textValue();
    }

    /** Fixes the target: the attached child of the run, or the sender's
     * own recorded parent. */
    private void handover(MessageRow row, JsonNode body, long now) {
        String childRunId = body.required("childRunId").asText();
        String target;
        if ("to_child".equals(body.required("route").asText())) {
            JsonNode run = records.childRunBody(row.tenantId(),
                    row.senderSessionId(), childRunId);
            if (run == null) {
                throw new IllegalStateException("child run " + childRunId
                        + " is not readable yet");
            }
            if (ManagedExtensionRecords.isTerminalRunState(
                    run.path("run").path("state").asText())
                    || run.path("stopRequested").asBoolean(false)) {
                // The run ended, or is being stopped, before the handover:
                // never handed over, and no wake for a child going away.
                senderOperation(row, "cancelled", Map.of());
                store.classify(row, owner, "done",
                        "child run ended before the handover", now);
                return;
            }
            JsonNode child = run.path("childSessionId");
            if (!child.isTextual()) {
                // A message to a child not yet attached is held (H4d-a
                // decision 4): the attach is the child's own progress.
                store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                        now + LEASE_MS, now);
                return;
            }
            target = child.textValue();
            // The run attaches as soon as its Runtime binding exists, before
            // the coordinator submits the child's task: a message received
            // earlier would wake a turn without that task, and the task
            // would then meet the busy Session. It is held until the Harness
            // admitted the task, and cancelled when the task ended without
            // an admission, since there is no task left for it to follow.
            // The epoch is that admission's record (a submission attempted
            // is not one); the one exception is a task cancelled while its
            // admission was unproven, which adopts the attach's epoch, and
            // a message then follows a task that is going away anyway.
            ChildResultRelayStore.TurnLine task = records.firstTurn(
                    row.tenantId(), target);
            if (task == null || task.harnessEventEpoch() == null) {
                if (task != null && TERMINAL_TURNS.contains(task.status())) {
                    senderOperation(row, "cancelled", Map.of());
                    store.classify(row, owner, "done",
                            "child task ended before its admission", now);
                    return;
                }
                store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                        now + LEASE_MS, now);
                return;
            }
        } else {
            SessionMessageRelayStore.Lineage lineage = store.lineage(
                    row.tenantId(), row.senderSessionId());
            if (lineage == null
                    || !childRunId.equals(lineage.parentChildRunId())) {
                throw new IllegalStateException(
                        "sender's recorded lineage does not name run "
                                + childRunId);
            }
            target = lineage.parentSessionId();
        }
        if (!"ACTIVE".equals(records.sessionStatus(row.tenantId(), target))) {
            senderOperation(row, "cancelled", Map.of());
            store.classify(row, owner, "done", "target session is not active",
                    now);
            return;
        }
        senderOperation(row, "handover", Map.of("targetSessionId", target));
        store.advance(row, owner, "relaying", target, now, now + LEASE_MS,
                now);
        deliver(row, body, target, now);
    }

    /** Commits the receipt in the target, then names its input on the
     * sender. A redelivery replays the same receipt. */
    private void deliver(MessageRow row, JsonNode body, String target,
            long now) {
        String inputId = inputIdOf(row.messageId());
        if (store.deliveryState(row.tenantId(), target,
                row.messageId()) == null) {
            if (!"ACTIVE".equals(records.sessionStatus(row.tenantId(),
                    target))) {
                senderOperation(row, "rejected", Map.of());
                store.classify(row, owner, "done",
                        "target session closed before the receipt", now);
                return;
            }
            if ("to_child".equals(body.required("route").asText())) {
                // A run that ended or is being stopped after the handover
                // takes no receipt either: it would wake a child going away.
                JsonNode run = records.childRunBody(row.tenantId(),
                        row.senderSessionId(),
                        body.required("childRunId").asText());
                if (run != null && (ManagedExtensionRecords.isTerminalRunState(
                        run.path("run").path("state").asText())
                        || run.path("stopRequested").asBoolean(false))) {
                    senderOperation(row, "rejected", Map.of());
                    store.classify(row, owner, "done",
                            "child run ended before the receipt", now);
                    return;
                }
            }
            JsonNode contentRef = body.required("contentRef");
            byte[] content = records.readResourceBytes(row.tenantId(),
                    contentRef.required("resourceId").asText());
            if (content == null) {
                throw new IllegalStateException(
                        "message content is not readable yet");
            }
            Map<String, Object> receive = new LinkedHashMap<>();
            receive.put("operationId", UUID.randomUUID().toString());
            receive.put("messageId", row.messageId());
            receive.put("kind", "receive");
            receive.put("route", body.required("route").asText());
            receive.put("childRunId", body.required("childRunId").asText());
            receive.put("senderSessionId", row.senderSessionId());
            receive.put("contentBase64",
                    Base64.getEncoder().encodeToString(content));
            receive.put("contentDigest",
                    body.required("contentDigest").asText());
            try {
                harness.runMessageOperation(row.tenantId(), target, receive);
            } catch (DaemonHttpException error) {
                if ("session_message_not_ready".equals(error.getErrorCode())) {
                    // A parent takes its child's message only once that
                    // child's run attached: held, never a failure.
                    store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                            now + LEASE_MS, now);
                    return;
                }
                if ("session_message_record".equals(error.getErrorCode())
                        || "session_message_conflict"
                                .equals(error.getErrorCode())) {
                    // The target's own rules refuse this message for good
                    // (its store's faults answer 503 and retry): a receipt
                    // committed already answers its replay, so a conflict
                    // is never this message's own redelivery.
                    senderOperation(row, "rejected", Map.of());
                    store.classify(row, owner, "done", error.getMessage(),
                            now);
                    return;
                }
                throw error;
            }
        }
        senderOperation(row, "accepted", Map.of("inputId", inputId));
        store.advance(row, owner, "delivered", target, now + AWAIT_MS,
                now + LEASE_MS, now);
    }

    /**
     * The sender's last step follows the target's own receipt. The target
     * is asked to reconcile it: consumed once the turn that read it
     * completed (that commit may have been lost after the turn), not yet
     * while it waits — the call itself reloads a Session a replaced
     * Harness no longer holds, so its wake pump runs the waiting input —
     * and never when the turn ended otherwise.
     */
    private void awaitConsumption(MessageRow row, JsonNode body, long now) {
        String target = target(body);
        if ("consumed".equals(store.deliveryState(row.tenantId(), target,
                row.messageId()))) {
            senderOperation(row, "consumed", Map.of());
            store.classify(row, owner, "done", null, now);
            return;
        }
        if (!"ACTIVE".equals(records.sessionStatus(row.tenantId(), target))) {
            // Accepted and never consumed stays exactly that on both
            // sides: nothing widens it into consumption.
            store.classify(row, owner, "done",
                    "target session closed before consuming", now);
            return;
        }
        if ("to_child".equals(body.required("route").asText())
                && stopStillSettling(row, body, target)) {
            // H4f: the consume would reload a child the Harness dropped and
            // start the message its stop is settling: it waits until that
            // work is settled, after which the reconciliation is harmless.
            store.scheduleRetry(row, owner, now + AWAIT_MS, now + LEASE_MS,
                    now);
            return;
        }
        Map<String, Object> consume = new LinkedHashMap<>();
        consume.put("operationId", UUID.randomUUID().toString());
        consume.put("messageId", row.messageId());
        consume.put("kind", "consume");
        try {
            harness.runMessageOperation(row.tenantId(), target, consume);
        } catch (DaemonHttpException error) {
            if ("session_message_not_ready".equals(error.getErrorCode())) {
                store.scheduleRetry(row, owner, now + AWAIT_MS,
                        now + LEASE_MS, now);
                return;
            }
            if ("session_message_record".equals(error.getErrorCode())) {
                // The turn that read it ended without completing: the
                // receipt stays accepted, never widened into consumption.
                store.classify(row, owner, "done", error.getMessage(), now);
                return;
            }
            throw error;
        }
        store.scheduleRetry(row, owner, now, now + LEASE_MS, now);
    }

    private void senderOperation(MessageRow row, String kind,
            Map<String, Object> fields) {
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("operationId", UUID.randomUUID().toString());
        operation.put("messageId", row.messageId());
        operation.put("kind", kind);
        operation.putAll(fields);
        harness.runMessageOperation(row.tenantId(), row.senderSessionId(),
                operation);
    }

    /**
     * A failed step counts an attempt. Past the bound the relay gives up,
     * but first ends the entry on its sender, so nothing still reads it as
     * owing a handover (the child it holds would never settle): a message
     * never handed over is cancelled; a handed-over one is accepted when
     * its receipt exists and otherwise unknown. A give-up whose sender
     * step faltered owes it and retries, never classifying over it.
     */
    private void defer(MessageRow row, RuntimeException error, long now) {
        if (row.attempts() + 1 >= MAX_ATTEMPTS) {
            try {
                // The failed step may have moved the entry (a handover that
                // landed before its delivery failed): decide from it as
                // committed now.
                SessionMessageRelayStore.CurrentRecord latest =
                        store.currentRecord(row.tenantId(),
                                row.senderSessionId(), row.messageId());
                String state = latest == null ? null : latest.deliveryState();
                if ("planned".equals(state)) {
                    senderOperation(row, "cancelled", Map.of());
                } else if ("accepting".equals(state)
                        || "unknown".equals(state)) {
                    JsonNode body = readJson(records.readResource(
                            row.tenantId(), latest.recordResourceId()),
                            "message body");
                    if (store.deliveryState(row.tenantId(), target(body),
                            row.messageId()) != null) {
                        senderOperation(row, "accepted",
                                Map.of("inputId", inputIdOf(row.messageId())));
                    } else if ("accepting".equals(state)) {
                        senderOperation(row, "unknown", Map.of());
                    }
                }
            } catch (RuntimeException settlement) {
                store.defer(row, owner, now + MAX_BACKOFF_MS,
                        settlement.getMessage(), now + LEASE_MS, now);
                return;
            }
            store.classify(row, owner, "unknown", error.getMessage(), now);
            LOG.warn("session message relay gives up tenant={} sender={}"
                            + " message={} after={} failure={}",
                    row.tenantId(), row.senderSessionId(), row.messageId(),
                    row.attempts(), error.getMessage());
            return;
        }
        long delay = Math.min(MAX_BACKOFF_MS,
                1_000L * (1L << Math.min(row.attempts(), 8)));
        store.defer(row, owner, now + delay, error.getMessage(),
                now + LEASE_MS, now);
    }

    private JsonNode readJson(String content, String label) {
        if (content == null) {
            throw new IllegalStateException(label + " is not readable yet");
        }
        try {
            return mapper.readTree(content);
        } catch (Exception error) {
            throw new IllegalStateException(label + " is unreadable", error);
        }
    }
}
