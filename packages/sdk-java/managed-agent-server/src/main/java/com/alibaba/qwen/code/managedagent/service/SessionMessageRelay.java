package com.alibaba.qwen.code.managedagent.service;

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
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
 * consumes it. A message whose child run ended before the handover, or
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
    private static final int MAX_ATTEMPTS = 64;
    private static final long LEASE_MS = 30_000;
    /** The gap for a wait on the other side — an attach, a consumption. */
    private static final long HEARTBEAT_MS = 5_000;

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
        String delivery = store.deliveryState(row.tenantId(),
                row.senderSessionId(), row.messageId());
        if (delivery == null) {
            delivery = pending.deliveryState();
        }
        String senderStatus = records.sessionStatus(row.tenantId(),
                row.senderSessionId());
        if (!"ACTIVE".equals(senderStatus)) {
            // A closing or gone sender's journal takes no further revision:
            // the entry stays as committed, classified on this side. One
            // already accepted was delivered — H4b closes a child right
            // after its settlement — and the target's receipt stays the
            // consumption truth.
            String reason = senderStatus == null ? "sender session is gone"
                    : "sender session is " + senderStatus;
            store.classify(row, owner,
                    "accepted".equals(delivery) ? "done" : "orphaned",
                    reason, now);
            return;
        }
        try {
            JsonNode body = readJson(records.readResource(row.tenantId(),
                    pending.recordResourceId()), "message body");
            switch (delivery) {
                case "planned" -> handover(row, body, now);
                case "accepting", "unknown" -> deliver(row, body,
                        body.path("targetSessionId").asText(), now);
                case "accepted" -> awaitConsumption(row, body, now);
                default -> store.classify(row, owner, "done", null, now);
            }
        } catch (RuntimeException error) {
            defer(row, error, now);
        }
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
                    run.path("run").path("state").asText())) {
                // The run ended before the handover: never handed over.
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
        String inputId = row.messageId() + ":message";
        if (store.deliveryState(row.tenantId(), target,
                row.messageId()) == null) {
            if (!"ACTIVE".equals(records.sessionStatus(row.tenantId(),
                    target))) {
                senderOperation(row, "rejected", Map.of());
                store.classify(row, owner, "done",
                        "target session closed before the receipt", now);
                return;
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
                    // The target's rules refuse this message for good: a
                    // receipt committed already answers its replay, so a
                    // conflict is never this message's own redelivery.
                    senderOperation(row, "rejected", Map.of());
                    store.classify(row, owner, "done", error.getMessage(),
                            now);
                    return;
                }
                throw error;
            }
        }
        senderOperation(row, "accepted", Map.of("inputId", inputId));
        store.advance(row, owner, "delivered", target, now + HEARTBEAT_MS,
                now + LEASE_MS, now);
    }

    /** The sender's last step follows the target's own receipt. */
    private void awaitConsumption(MessageRow row, JsonNode body, long now) {
        String target = body.required("targetSessionId").asText();
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
        store.scheduleRetry(row, owner, now + HEARTBEAT_MS, now + LEASE_MS,
                now);
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

    private void defer(MessageRow row, RuntimeException error, long now) {
        if (row.attempts() + 1 >= MAX_ATTEMPTS) {
            store.classify(row, owner, "unknown", error.getMessage(), now);
            LOG.warn("session message relay gives up tenant={} sender={}"
                            + " message={} after={} failure={}",
                    row.tenantId(), row.senderSessionId(), row.messageId(),
                    row.attempts(), error.getMessage());
            return;
        }
        long delay = Math.min(300_000L,
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
