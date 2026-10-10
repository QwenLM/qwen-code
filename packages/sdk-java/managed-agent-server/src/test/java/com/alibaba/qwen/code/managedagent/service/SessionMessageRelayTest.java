package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore.Lineage;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore.MessageRow;
import com.alibaba.qwen.code.managedagent.store.SessionMessageRelayStore.PendingMessage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

/** The message relay's state machine against recorded harness calls. */
class SessionMessageRelayTest {
    private static final String TENANT = "tenant-messages";
    private static final String PARENT = UUID.randomUUID().toString();
    private static final String CHILD = UUID.randomUUID().toString();
    private static final String MESSAGE = "msg_1";
    private static final byte[] CONTENT = "also check the tests"
            .getBytes(StandardCharsets.UTF_8);

    private SessionMessageRelayStore store;
    private ChildResultRelayStore records;
    private RecordingHarness harness;
    private SessionMessageRelay relay;
    private AtomicReference<MessageRow> row;
    private AtomicReference<PendingMessage> pending;
    private final ObjectMapper mapper = new ObjectMapper();

    /** One recorded message operation: the Session it went to, and its body. */
    private record Call(String sessionId, Map<String, Object> body) {
        String kind() {
            return (String) body.get("kind");
        }
    }

    private static final class RecordingHarness implements HarnessConnector {
        final List<Call> calls = new CopyOnWriteArrayList<>();
        volatile String refuseKind;
        volatile String refuseCode;
        volatile String refuseSecondKind;
        volatile boolean available = true;

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public Attachment createOrLoad(String tenantId, String sessionId,
                boolean loadExisting) {
            return new Attachment("boot");
        }

        @Override
        public HarnessConnector.Admission submit(String tenantId,
                String sessionId, String promptId,
                List<Map<String, Object>> input, String payloadDigest) {
            throw new UnsupportedOperationException();
        }

        @Override
        public SourceStream stream(String tenantId, String sessionId,
                long lastEventId, String eventEpoch) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void cancel(String tenantId, String sessionId) {
        }

        @Override
        public void rename(String tenantId, String sessionId, String title) {
        }

        @Override
        public String closeSession(String tenantId, String sessionId) {
            return "boot";
        }

        @Override
        public void runMessageOperation(String tenantId, String sessionId,
                Map<String, Object> body) {
            if (refuseKind != null && refuseKind.equals(body.get("kind"))
                    || refuseSecondKind != null
                            && refuseSecondKind.equals(body.get("kind"))) {
                throw refusal(refuseCode);
            }
            calls.add(new Call(sessionId, Map.copyOf(body)));
        }

        static DaemonHttpException refusal(String code) {
            try {
                var ctor = DaemonHttpException.class.getDeclaredConstructor(
                        String.class, int.class, String.class);
                ctor.setAccessible(true);
                return ctor.newInstance("runMessageOperation", 409,
                        "{\"code\":\"" + code + "\"}");
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }
    }

    @BeforeEach
    void setUp() {
        store = mock(SessionMessageRelayStore.class);
        records = mock(ChildResultRelayStore.class);
        harness = new RecordingHarness();
        relay = new SessionMessageRelay(store, records, harness, mapper,
                () -> 1_000L);
        row = new AtomicReference<>(new MessageRow(TENANT, PARENT, MESSAGE,
                null, "relaying", "owner", 31_000L, 0, 0, null));
        pending = new AtomicReference<>(new PendingMessage(TENANT, PARENT,
                MESSAGE, "planned", "resource-message"));
        when(store.findPendingMessages(anyString(), anyLong(),
                Mockito.anyInt())).thenAnswer(ignored -> List.of(pending.get()));
        when(store.claim(anyString(), anyString(), anyString(), anyString(),
                anyLong(), anyLong())).thenAnswer(ignored -> row.get());
        Mockito.doAnswer(args -> {
                    MessageRow before = row.get();
                    row.set(new MessageRow(before.tenantId(),
                            before.senderSessionId(), before.messageId(),
                            args.getArgument(3), args.getArgument(2),
                            before.claimedBy(), before.claimedUntil(),
                            before.attempts(), args.getArgument(4),
                            before.lastError()));
                    return null;
                }).when(store).advance(any(MessageRow.class), anyString(),
                        anyString(), any(), anyLong(), anyLong(), anyLong());
        Mockito.doAnswer(args -> {
                    MessageRow before = row.get();
                    row.set(new MessageRow(before.tenantId(),
                            before.senderSessionId(), before.messageId(),
                            before.targetSessionId(), args.getArgument(2),
                            null, 0, before.attempts(), before.nextRetryAt(),
                            args.getArgument(3)));
                    return null;
                }).when(store).classify(any(MessageRow.class), anyString(),
                        anyString(), any(), anyLong());
        Mockito.doAnswer(args -> {
                    MessageRow before = row.get();
                    row.set(new MessageRow(before.tenantId(),
                            before.senderSessionId(), before.messageId(),
                            before.targetSessionId(), before.state(),
                            before.claimedBy(), before.claimedUntil(),
                            before.attempts() + 1, args.getArgument(2),
                            args.getArgument(3)));
                    return null;
                }).when(store).defer(any(MessageRow.class), anyString(),
                        anyLong(), any(), anyLong(), anyLong());
        when(store.currentRecord(anyString(), anyString(), anyString()))
                .thenAnswer(ignored -> new SessionMessageRelayStore
                        .CurrentRecord(pending.get().deliveryState(),
                                "resource-message"));
        when(records.sessionStatus(TENANT, PARENT)).thenReturn("ACTIVE");
        when(records.sessionStatus(TENANT, CHILD)).thenReturn("ACTIVE");
        when(records.readResourceBytes(TENANT, "resource-content"))
                .thenReturn(CONTENT);
        body("to_child", PARENT, null);
        childRun("running", CHILD);
    }

    private void body(String route, String sender, String target) {
        when(records.readResource(TENANT, "resource-message")).thenReturn(
                "{\"direction\":\"outbound\",\"messageId\":\"" + MESSAGE
                        + "\",\"route\":\"" + route
                        + "\",\"childRunId\":\"run-1\",\"senderSessionId\":\""
                        + sender + "\",\"targetSessionId\":"
                        + (target == null ? "null" : "\"" + target + "\"")
                        + ",\"contentRef\":{\"resourceId\":"
                        + "\"resource-content\"},\"contentDigest\":\"d1\"}");
    }

    private void childRun(String state, String childSessionId) {
        childRun(state, childSessionId, false);
    }

    private void childRun(String state, String childSessionId,
            boolean stopRequested) {
        when(records.childRunBody(TENANT, PARENT, "run-1")).thenReturn(json(
                "{\"childSessionId\":" + (childSessionId == null ? "null"
                        : "\"" + childSessionId + "\"")
                        + ",\"stopRequested\":" + stopRequested
                        + ",\"run\":{\"state\":\"" + state + "\"}}"));
    }

    private JsonNode json(String text) {
        try {
            return mapper.readTree(text);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private List<String> kinds() {
        return harness.calls.stream().map(Call::kind).toList();
    }

    @Test
    void handsAMessageToItsAttachedChildAndNamesTheReceipt() {
        relay.scan();
        assertThat(kinds()).containsExactly("handover", "receive",
                "accepted");
        assertThat(harness.calls.get(0).sessionId()).isEqualTo(PARENT);
        assertThat(harness.calls.get(0).body().get("targetSessionId"))
                .isEqualTo(CHILD);
        Call receive = harness.calls.get(1);
        assertThat(receive.sessionId()).isEqualTo(CHILD);
        assertThat(receive.body()).containsEntry("route", "to_child")
                .containsEntry("childRunId", "run-1")
                .containsEntry("senderSessionId", PARENT)
                .containsEntry("contentDigest", "d1")
                .containsEntry("contentBase64",
                        Base64.getEncoder().encodeToString(CONTENT));
        assertThat(harness.calls.get(2).body().get("inputId"))
                .isEqualTo("msg_1:message");
        assertThat(row.get().state()).isEqualTo("delivered");
        assertThat(row.get().targetSessionId()).isEqualTo(CHILD);
    }

    @Test
    void anInstanceWithoutAHarnessLeavesTheLedgerAlone() {
        harness.available = false;
        relay.scan();
        assertThat(harness.calls).isEmpty();
        verify(store, never()).findPendingMessages(anyString(), anyLong(),
                Mockito.anyInt());
        verify(store, never()).claim(anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyLong());
    }

    @Test
    void holdsAMessageUntilItsChildAttaches() {
        childRun("running", null);
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().attempts()).isZero();
        verify(store).scheduleRetry(any(MessageRow.class), anyString(),
                anyLong(), anyLong(), anyLong());
    }

    @Test
    void cancelsAMessageWhoseRunEndedBeforeTheHandover() {
        childRun("settled", CHILD);
        relay.scan();
        assertThat(kinds()).containsExactly("cancelled");
        assertThat(row.get().state()).isEqualTo("done");
    }

    @Test
    void cancelsAMessageWhoseTargetIsNoLongerActive() {
        when(records.sessionStatus(TENANT, CHILD)).thenReturn("CLOSED");
        relay.scan();
        assertThat(kinds()).containsExactly("cancelled");
        assertThat(row.get().state()).isEqualTo("done");
    }

    @Test
    void routesAChildMessageToItsRecordedParent() {
        row.set(new MessageRow(TENANT, CHILD, MESSAGE, null, "relaying",
                "owner", 31_000L, 0, 0, null));
        pending.set(new PendingMessage(TENANT, CHILD, MESSAGE, "planned",
                "resource-message"));
        body("to_parent", CHILD, null);
        when(store.lineage(TENANT, CHILD))
                .thenReturn(new Lineage(PARENT, "run-1"));
        relay.scan();
        assertThat(kinds()).containsExactly("handover", "receive",
                "accepted");
        assertThat(harness.calls.get(0).sessionId()).isEqualTo(CHILD);
        assertThat(harness.calls.get(1).sessionId()).isEqualTo(PARENT);
        assertThat(harness.calls.get(1).body().get("route"))
                .isEqualTo("to_parent");
    }

    @Test
    void holdsAChildMessageThatItsParentCannotTakeYet() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepting",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        harness.refuseKind = "receive";
        harness.refuseCode = "session_message_not_ready";
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().attempts()).isZero();
        verify(store).scheduleRetry(any(MessageRow.class), anyString(),
                anyLong(), anyLong(), anyLong());
    }

    @Test
    void rejectsAMessageItsTargetRefusesForGood() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepting",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        harness.refuseKind = "receive";
        harness.refuseCode = "session_message_conflict";
        relay.scan();
        assertThat(kinds()).containsExactly("rejected");
        assertThat(row.get().state()).isEqualTo("done");
    }

    @Test
    void replaysACommittedReceiptWithoutAnotherInput() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepting",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        when(store.deliveryState(TENANT, CHILD, MESSAGE))
                .thenReturn("accepted");
        relay.scan();
        assertThat(kinds()).containsExactly("accepted");
        assertThat(row.get().state()).isEqualTo("delivered");
    }

    // The target reconciles its receipt on each look (a consumption lost
    // after its turn, a Session a replaced Harness dropped), and the
    // sender's last step follows the receipt.
    @Test
    void advancesTheSenderOnlyOnceTheTargetConsumed() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepted",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        when(store.deliveryState(TENANT, CHILD, MESSAGE))
                .thenReturn("accepted");
        relay.scan();
        assertThat(kinds()).containsExactly("consume");
        assertThat(harness.calls.getFirst().sessionId()).isEqualTo(CHILD);
        verify(store).scheduleRetry(any(MessageRow.class), anyString(),
                anyLong(), anyLong(), anyLong());
        when(store.deliveryState(TENANT, CHILD, MESSAGE))
                .thenReturn("consumed");
        relay.scan();
        assertThat(kinds()).containsExactly("consume", "consumed");
        assertThat(row.get().state()).isEqualTo("done");
    }

    @Test
    void waitsForAMessageNotReadYetWithoutSpendingAnAttempt() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepted",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        when(store.deliveryState(TENANT, CHILD, MESSAGE))
                .thenReturn("accepted");
        harness.refuseKind = "consume";
        harness.refuseCode = "session_message_not_ready";
        relay.scan();
        assertThat(row.get().attempts()).isZero();
        assertThat(row.get().state()).isEqualTo("relaying");
    }

    @Test
    void finishesAMessageWhoseReadingTurnEndedIncomplete() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepted",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        when(store.deliveryState(TENANT, CHILD, MESSAGE))
                .thenReturn("accepted");
        harness.refuseKind = "consume";
        harness.refuseCode = "session_message_record";
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().state()).isEqualTo("done");
    }

    // A target's store fault answers 503: retried, never a rejection.
    @Test
    void retriesATargetStoreFaultInsteadOfRejecting() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepting",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        harness.refuseKind = "receive";
        harness.refuseCode = "session_message_failed";
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().attempts()).isEqualTo(1);
        assertThat(row.get().state()).isEqualTo("relaying");
    }

    // A handed-over entry whose body names no target cannot be delivered
    // anywhere: retried, never rejected over a session named "null".
    @Test
    void neverDeliversAHandedOverMessageWithoutItsTarget() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepting",
                "resource-message"));
        body("to_child", PARENT, null);
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().attempts()).isEqualTo(1);
    }

    @Test
    void cancelsAMessageToAChildBeingStopped() {
        childRun("running", CHILD, true);
        relay.scan();
        assertThat(kinds()).containsExactly("cancelled");
        assertThat(row.get().state()).isEqualTo("done");
    }

    // The receipt landed before the sender closed: delivered, not orphaned.
    @Test
    void finishesAReceivedMessageWhoseSenderClosedBeforeItsAcceptance() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepting",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        when(store.deliveryState(TENANT, CHILD, MESSAGE))
                .thenReturn("accepted");
        when(records.sessionStatus(TENANT, PARENT)).thenReturn("CLOSED");
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().state()).isEqualTo("done");
    }

    @Test
    void neverWidensAnUnconsumedMessageOfAClosedTarget() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepted",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        when(store.deliveryState(TENANT, CHILD, MESSAGE))
                .thenReturn("accepted");
        when(records.sessionStatus(TENANT, CHILD)).thenReturn("CLOSED");
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().state()).isEqualTo("done");
    }

    @Test
    void orphansTheMessageOfASenderThatIsClosing() {
        when(records.sessionStatus(TENANT, PARENT)).thenReturn("CLOSING");
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().state()).isEqualTo("orphaned");
    }

    // H4b closes a child right after its settlement: a message it already
    // handed over is delivered, never orphaned, and the parent's receipt
    // stays the consumption truth.
    @Test
    void finishesADeliveredMessageWhoseSenderClosed() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepted",
                "resource-message"));
        when(records.sessionStatus(TENANT, PARENT)).thenReturn("CLOSED");
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().state()).isEqualTo("done");
    }

    // A give-up ends the entry on its sender first, so nothing reads it as
    // owing a handover any more: never handed over → cancelled.
    @Test
    void givesUpAnUnprovableDeliveryAsUnknown() {
        harness.refuseKind = "handover";
        harness.refuseCode = "session_message_failed";
        row.set(new MessageRow(TENANT, PARENT, MESSAGE, null, "relaying",
                "owner", 31_000L, 63, 0, null));
        relay.scan();
        assertThat(kinds()).containsExactly("cancelled");
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(store, never()).defer(any(MessageRow.class), anyString(),
                anyLong(), any(), anyLong(), anyLong());
    }

    @Test
    void givesUpAHandedOverMessageAsUnknownOnItsSender() {
        pending.set(new PendingMessage(TENANT, PARENT, MESSAGE, "accepting",
                "resource-message"));
        body("to_child", PARENT, CHILD);
        harness.refuseKind = "receive";
        harness.refuseCode = "session_message_failed";
        row.set(new MessageRow(TENANT, PARENT, MESSAGE, CHILD, "relaying",
                "owner", 31_000L, 63, 0, null));
        relay.scan();
        assertThat(kinds()).containsExactly("unknown");
        assertThat(row.get().state()).isEqualTo("unknown");
    }

    // A give-up whose sender step faltered owes it: retried, not classified.
    // The give-up decides from the entry as committed after the failed
    // step: a handover that landed before its delivery failed is never
    // cancelled from the planned state the claim saw.
    @Test
    void givesUpFromTheEntryAsTheFailedStepLeftIt() {
        body("to_child", PARENT, CHILD);
        when(store.currentRecord(anyString(), anyString(), anyString()))
                .thenAnswer(ignored -> new SessionMessageRelayStore
                        .CurrentRecord(kinds().contains("handover")
                                ? "accepting" : "planned",
                                "resource-message"));
        harness.refuseKind = "receive";
        harness.refuseCode = "session_message_failed";
        row.set(new MessageRow(TENANT, PARENT, MESSAGE, null, "relaying",
                "owner", 31_000L, 63, 0, null));
        relay.scan();
        assertThat(kinds()).containsExactly("handover", "unknown");
        assertThat(row.get().state()).isEqualTo("unknown");
    }

    @Test
    void owesAGiveUpWhoseSenderStepFaltered() {
        harness.refuseKind = "handover";
        harness.refuseCode = "session_message_failed";
        row.set(new MessageRow(TENANT, PARENT, MESSAGE, null, "relaying",
                "owner", 31_000L, 63, 0, null));
        harness.refuseSecondKind = "cancelled";
        relay.scan();
        assertThat(harness.calls).isEmpty();
        assertThat(row.get().state()).isEqualTo("relaying");
        assertThat(row.get().attempts()).isEqualTo(64);
    }

    @Test
    void scanRunsOnItsOwnScheduler() throws Exception {
        var scheduled = SessionMessageRelay.class.getMethod("scan")
                .getAnnotation(
                        org.springframework.scheduling.annotation.Scheduled.class);
        assertThat(scheduled.scheduler()).isEqualTo("messageRelayScheduler");
    }
}
