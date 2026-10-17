package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore.MessageRow;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore.PendingMessage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

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
                row.tenantId(), row.senderSessionId(), pending.domain(),
                row.messageId());
        if (current == null) {
            return;
        }
        try {
            JsonNode body = readJson(records.readResource(row.tenantId(), row.senderSessionId(),
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
                                row.tenantId(), target, "session_message",
                                row.messageId()) != null;
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
            if (row.attempts() >= MAX_ATTEMPTS) {
                // Past the bound only the give-up is owed, never the step:
                // a message that a younger one was released past (see
                // olderOwedMessages) must not land after it.
                defer(row, pending.domain(), new IllegalStateException(
                        "past the attempt bound: " + row.lastError()), now);
                return;
            }
            if ("session_command".equals(pending.domain())) {
                workCommand(row, body, current, now);
            } else {
                switch (current.deliveryState()) {
                    case "planned" -> handover(row, body, now);
                    case "accepting", "unknown" -> deliver(row, body,
                            target(body), now);
                    case "accepted" -> awaitConsumption(row, body, now);
                    default -> store.classify(row, owner, "done", null, now);
                }
            }
        } catch (RuntimeException error) {
            defer(row, pending.domain(), error, now);
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

    /** Whether an older message of the sender to the same run still owes
     * its handover or receipt. */
    private boolean olderOwedOnRun(MessageRow row, String childRunId) {
        for (String resource : store.olderOwedMessages(row.tenantId(),
                row.senderSessionId(), row.messageId())) {
            String text = records.readResource(row.tenantId(),
                    row.senderSessionId(), resource);
            JsonNode older;
            try {
                older = readJson(text, "older message body");
            } catch (IllegalStateException unreadable) {
                // A body not readable yet cannot prove its run: it holds
                // like one to this run, at no attempt to this message. Its
                // own step fails the same read, so its give-up ends this.
                return true;
            }
            if (childRunId.equals(older.path("childRunId").textValue())) {
                return true;
            }
        }
        return false;
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
        if (olderOwedOnRun(row, childRunId)) {
            // One run's messages pass in send order: a younger one handed
            // over first would wake its turn ahead of the older. The hold
            // costs no attempt; the older one's give-up bounds it.
            store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                    now + LEASE_MS, now);
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
        if (store.deliveryState(row.tenantId(), target, "session_message",
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
            byte[] content = records.readResourceBytes(row.tenantId(), row.senderSessionId(),
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
                "session_message", row.messageId()))) {
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

    private void senderCommandOperation(MessageRow row, String kind,
            Map<String, Object> fields) {
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("operationId", UUID.randomUUID().toString());
        operation.put("commandId", row.messageId());
        operation.put("kind", kind);
        operation.putAll(fields);
        harness.runMessageOperation(row.tenantId(), row.senderSessionId(),
                operation);
    }

    /**
     * H4e-b3: the command pass. `planned` fixes the parent of the member's
     * lineage; `accepting` and `unknown` drive the leader's `execute`,
     * whose settled reply is then copied back with `answered`. A command
     * never walks `consume` — the parked tool call reads its own reply.
     * The leader's own `session_command_refused` is terminal and rejects
     * the entry at once; every other 4xx is a retryable blocked Session —
     * the closing and recovery gates the design's route table already
     * carries, which the relay defers without spending an attempt. One
     * sender's commands pass strictly in order: an older unclassified one
     * keeps a newer one waiting, so a write the member reads after a
     * timeout can never land behind a later command of the same run.
     */
    private void workCommand(MessageRow row, JsonNode body,
            SessionMessageRelayStore.CurrentRecord current, long now) {
        if (store.olderOpenCommand(row.tenantId(), row.senderSessionId(),
                row.messageId())) {
            store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                    now + LEASE_MS, now);
            return;
        }
        String state = current.deliveryState();
        String target = body.path("targetSessionId").isTextual()
                ? body.path("targetSessionId").textValue()
                : null;
        if ("planned".equals(state)) {
            SessionMessageRelayStore.Lineage lineage = store.lineage(
                    row.tenantId(), row.senderSessionId());
            if (lineage == null) {
                // A command came only from a lineage Session, so a missing
                // one cannot be proven undeliverable: wait, never reject.
                store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                        now + LEASE_MS, now);
                return;
            }
            if (!body.required("childRunId").asText().equals(
                    lineage.parentChildRunId())) {
                throw new IllegalStateException(
                        "sender's recorded lineage does not name run "
                                + body.required("childRunId").asText());
            }
            target = lineage.parentSessionId();
            if (!"ACTIVE".equals(records.sessionStatus(row.tenantId(),
                    target))) {
                senderCommandOperation(row, "cancelled", Map.of());
                store.classify(row, owner, "done",
                        "parent session is not active", now);
                return;
            }
            senderCommandOperation(row, "handover",
                    Map.of("targetSessionId", target));
            store.advance(row, owner, "relaying", target, now,
                    now + LEASE_MS, now);
        }
        if (!"planned".equals(state) && !"accepting".equals(state)) {
            // Decision 2: the sender already holds this command's
            // terminal answer — its own timeout moved accepting to
            // cancelled or unknown while the entry was in flight. The
            // pass owes the ledger row only its classification now,
            // never a second execute, whatever the row's state.
            store.classify(row, owner,
                    "unknown".equals(state) ? "unknown" : "done",
                    "command is already " + state, now);
            return;
        }
        if (target == null) {
            throw new IllegalStateException(
                    "a handed-over command names no target");
        }
        if (!"ACTIVE".equals(records.sessionStatus(row.tenantId(), target))) {
            // A executed write may have landed: never say it did not.
            senderCommandOperation(row, "unknown", Map.of());
            store.classify(row, owner, "unknown",
                    "target session closed before the execution", now);
            return;
        }
        JsonNode argsRef = body.required("argsRef");
        byte[] args = records.readResourceBytes(row.tenantId(), row.senderSessionId(),
                argsRef.required("resourceId").asText());
        if (args == null) {
            throw new IllegalStateException(
                    "command arguments are not readable yet");
        }
        Map<String, Object> execute = new LinkedHashMap<>();
        execute.put("operationId", UUID.randomUUID().toString());
        execute.put("commandId", row.messageId());
        execute.put("kind", "execute");
        execute.put("commandKind", body.required("kind").asText());
        execute.put("route", "to_parent");
        execute.put("childRunId", body.required("childRunId").asText());
        execute.put("senderSessionId", row.senderSessionId());
        execute.put("argsBase64", Base64.getEncoder().encodeToString(args));
        execute.put("argsDigest", body.required("argsDigest").asText());
        Map<String, Object> settled;
        try {
            settled = harness.runMessageOperation(row.tenantId(), target,
                    execute);
        } catch (DaemonHttpException error) {
            if ("session_command_refused".equals(error.getErrorCode())) {
                // The lead cannot accept the command at all: rejected, and
                // never re-executed.
                senderCommandOperation(row, "rejected", Map.of());
                store.classify(row, owner, "done", error.getMessage(), now);
                return;
            }
            if ("hosted_commands_unavailable".equals(error.getErrorCode())
                    || "hosted_turn_recovery_required"
                            .equals(error.getErrorCode())
                    || "hosted_session_closing".equals(error.getErrorCode())
                    || "session_command_blocked".equals(error.getErrorCode())) {
                // A blocked or closing lead is a wait, not a failure — the
                // attempt budget is for real faults. A sender whose run
                // has not attached yet waits the same way: the control
                // plane's attach commit may trail this execute.
                store.scheduleRetry(row, owner, now + HEARTBEAT_MS,
                        now + LEASE_MS, now);
                return;
            }
            throw error;
        }
        Object reply = settled.get("reply");
        senderCommandOperation(row, "answered", Map.of("reply", reply));
        store.classify(row, owner, "done", null, now);
    }

    /**
     * A failed step counts an attempt. Past the bound the relay gives up,
     * but first ends the entry on its sender, so nothing still reads it as
     * owing a handover (the child it holds would never settle): a message
     * never handed over is cancelled; a handed-over one is accepted when
     * its receipt exists and otherwise unknown. A give-up whose sender
     * step faltered owes it and retries, never classifying over it.
     */
    private void defer(MessageRow row, String domain,
            RuntimeException error, long now) {
        if (row.attempts() + 1 >= MAX_ATTEMPTS) {
            try {
                // The failed step may have moved the entry (a handover that
                // landed before its delivery failed): decide from it as
                // committed now.
                SessionMessageRelayStore.CurrentRecord latest =
                        store.currentRecord(row.tenantId(),
                                row.senderSessionId(), domain,
                                row.messageId());
                String state = latest == null ? null : latest.deliveryState();
                if ("session_command".equals(domain)) {
                    // H4e-b3: never handed over is cancelled, as a message's
                    // is. A handed-over command is answered from the
                    // leader's own receipt when that committed — the reply
                    // never gets paraphrased — and otherwise unknown.
                    if ("planned".equals(state)) {
                        senderCommandOperation(row, "cancelled", Map.of());
                    } else if (latest != null
                            && !"cancelled".equals(state)) {
                        JsonNode body = readJson(records.readResource(
                                row.tenantId(), row.senderSessionId(), latest.recordResourceId()),
                                "command body");
                        String target = body.path("targetSessionId")
                                .isTextual()
                                        ? body.path("targetSessionId")
                                                .textValue()
                                        : null;
                        SessionMessageRelayStore.CurrentRecord receipt =
                                target == null ? null
                                        : store.currentRecord(row.tenantId(),
                                                target, domain,
                                                row.messageId());
                        if (receipt != null) {
                            JsonNode receiptBody = readJson(
                                    records.readResource(row.tenantId(), target,
                                            receipt.recordResourceId()),
                                    "command receipt");
                            JsonNode replyRef = receiptBody
                                    .required("replyRef");
                            JsonNode reply = readJson(
                                    records.readResource(row.tenantId(), target,
                                            replyRef.required("resourceId")
                                                    .asText()),
                                    "command reply");
                            senderCommandOperation(row, "answered",
                                    Map.of("reply", mapper
                                            .convertValue(reply, Map.class)));
                        } else {
                            senderCommandOperation(row, "unknown", Map.of());
                        }
                    }
                } else if ("planned".equals(state)) {
                    senderOperation(row, "cancelled", Map.of());
                } else if ("accepting".equals(state)
                        || "unknown".equals(state)) {
                    JsonNode body = readJson(records.readResource(
                            row.tenantId(), row.senderSessionId(), latest.recordResourceId()),
                            "message body");
                    if (store.deliveryState(row.tenantId(), target(body),
                            domain, row.messageId()) != null) {
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
                            + " domain={} message={} after={} failure={}",
                    row.tenantId(), row.senderSessionId(), domain,
                    row.messageId(), row.attempts(), error.getMessage());
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
