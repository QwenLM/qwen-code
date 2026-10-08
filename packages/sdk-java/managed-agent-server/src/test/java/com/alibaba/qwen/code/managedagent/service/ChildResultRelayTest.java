package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore.PendingChild;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore.RelayRow;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore.TurnLine;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;

/** The relay's state machine against recorded control-plane calls. */
class ChildResultRelayTest {
    private static final String TENANT = "tenant-relay";
    private static final String PARENT = UUID.randomUUID().toString();
    private static final String CHILD = UUID.randomUUID().toString();
    private static final String RUN = "run-1";

    private ChildResultRelayStore store;
    private ManagedAgentService sessions;
    private RuntimeBrokerService broker;
    private RecordingHarness harness;
    private ChildResultRelay relay;
    private ChildLifecycleAdmissions childCloses;
    private PendingChild pending;
    private AtomicReference<RelayRow> row;
    private long now;

    private static final class RecordingHarness implements HarnessConnector {
        final List<Map<String, Object>> operations = new CopyOnWriteArrayList<>();
        private boolean available = true;
        volatile String refuseKind;
        volatile String refuseRecord;

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
        public void runChildOperation(String tenantId, String sessionId,
                Map<String, Object> body) {
            if (refuseRecord != null && refuseRecord.equals(body.get("kind")))
                throw recordRefusal();
            if (refuseKind != null && refuseKind.equals(body.get("kind")))
                throw new IllegalStateException("harness down");
            operations.add(Map.copyOf(body));
        }

        /** The route's `409 child_operation_record` — the parent's own
         * committed veto, never a transient shape: its constructor is
         * package-private inside qwencode, so the double reaches it
         * reflectively. */
        private static DaemonHttpException recordRefusal() {
            try {
                var ctor = DaemonHttpException.class.getDeclaredConstructor(
                        String.class, int.class, String.class);
                ctor.setAccessible(true);
                return ctor.newInstance("runChildOperation", 409,
                        "{\"code\":\"child_operation_record\"}");
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        store = mock(ChildResultRelayStore.class);
        sessions = mock(ManagedAgentService.class);
        broker = mock(RuntimeBrokerService.class);
        ObjectProvider<RuntimeBrokerService> provider =
                Mockito.mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenAnswer(ignored -> broker);
        harness = new RecordingHarness();
        childCloses = mock(ChildLifecycleAdmissions.class);
        when(childCloses.closeSupported()).thenReturn(true);
        now = 1_000_000L;
        AtomicReference<Long> clock = new AtomicReference<>(now);
        relay = new ChildResultRelay(store, sessions, provider, harness,
                new ObjectMapper(), childCloses, clock::get);
        pending = new PendingChild(TENANT, PARENT, RUN, 1, "planned",
                "resource-body");
        row = new AtomicReference<>(new RelayRow(TENANT, PARENT, RUN,
                "creation-key", null, "creating", "owner", now + 30_000, 0, 0,
                null, now, now));
        when(store.findPendingChildren(Mockito.anyString(), Mockito.anyInt()))
                .thenAnswer(ignored -> List.of(pending));
        when(store.claim(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyLong()))
                .thenAnswer(ignored -> row.get());
        when(store.find(anyString(), anyString(), anyString()))
                .thenAnswer(ignored -> row.get());
        Mockito.doAnswer(args -> {
                    RelayRow before = row.get();
                    row.set(new RelayRow(before.tenantId(),
                            before.parentSessionId(), before.childRunId(),
                            before.creationKey(),
                            (String) args.getArgument(3),
                            args.getArgument(2),
                            (String) args.getArgument(1),
                            ((Number) args.getArgument(6)).longValue(),
                            before.attempts(),
                            ((Number) args.getArgument(4)).longValue(),
                            (String) args.getArgument(5), before.createdAt(),
                            clock.get()));
                    return null;
                }).when(store).advance(any(RelayRow.class), anyString(),
                        anyString(), any(), anyLong(), any(), anyLong(),
                        anyLong());
        Mockito.doAnswer(args -> {
                    RelayRow before = row.get();
                    row.set(new RelayRow(before.tenantId(),
                            before.parentSessionId(), before.childRunId(),
                            before.creationKey(), before.childSessionId(),
                            args.getArgument(2), null, 0, before.attempts(),
                            before.nextRetryAt(),
                            (String) args.getArgument(3), before.createdAt(),
                            clock.get()));
                    return null;
                }).when(store).classify(any(RelayRow.class), anyString(),
                        anyString(), any(), anyLong());
        Mockito.doAnswer(args -> {
                    RelayRow before = row.get();
                    row.set(new RelayRow(before.tenantId(),
                            before.parentSessionId(), before.childRunId(),
                            before.creationKey(), before.childSessionId(),
                            before.state(), before.claimedBy(),
                            before.claimedUntil(), before.attempts() + 1,
                            args.getArgument(2),
                            (String) args.getArgument(3), before.createdAt(),
                            clock.get()));
                    return null;
                }).when(store).defer(any(RelayRow.class), anyString(),
                        anyLong(), any(), anyLong(), anyLong());
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("ACTIVE");
        when(store.hasAcceptance(TENANT, PARENT, RUN)).thenReturn(false);
        when(store.readResource(TENANT, "resource-body")).thenReturn(
                "{\"inputRef\":{\"resourceId\":\"resource-input\"},"
                        + "\"completion\":\"sent\"}");
        when(store.readResource(TENANT, "resource-input")).thenReturn(
                "{\"description\":\"audit the diff\",\"prompt\":\"review\"}");
    }

    @Test
    void completesTheToolArmWithoutANotification() {
        // The same walk on the tool arm: the same commits, and never a
        // bundled wake input on the acceptance op.
        when(store.readResource(TENANT, "resource-body")).thenReturn(
                "{\"inputRef\":{\"resourceId\":\"resource-input\"},"
                        + "\"completion\":\"tool\"}");
        when(sessions.createChildSession(TENANT, PARENT, RUN,
                "audit the diff", "review")).thenReturn(
                new CommandAdmission(CHILD, null, "accepted", false));
        RuntimeBindingRecord binding = mock(RuntimeBindingRecord.class);
        when(binding.getBindingId()).thenReturn("binding-1");
        when(binding.getGeneration()).thenReturn(7L);
        when(broker.findLatestBindingByHarnessSession(TENANT, CHILD))
                .thenReturn(binding);
        relay.scan();
        relay.scan();
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "COMPLETED", now + 1L, null));
        when(store.terminalResultText(TENANT, CHILD, "turn-1"))
                .thenReturn("审阅通过");
        relay.scan();
        relay.scan();
        Map<String, Object> accept = harness.operations.stream()
                .filter(operation -> "accept".equals(operation.get("kind")))
                .findFirst().orElseThrow();
        assertThat(accept).doesNotContainKey("notification");
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
    }

    @Test
    void drivesAChildFromCreationToDelivery() {
        when(sessions.createChildSession(TENANT, PARENT, RUN,
                "audit the diff", "review")).thenReturn(
                new CommandAdmission(CHILD, null, "accepted", false));
        RuntimeBindingRecord binding = mock(RuntimeBindingRecord.class);
        when(binding.getBindingId()).thenReturn("binding-1");
        when(binding.getGeneration()).thenReturn(7L);
        when(broker.findLatestBindingByHarnessSession(TENANT, CHILD))
                .thenReturn(binding);

        relay.scan();
        assertThat(row.get().state()).isEqualTo("binding");
        assertThat(row.get().childSessionId()).isEqualTo(CHILD);

        relay.scan();
        assertThat(row.get().state()).isEqualTo("watching");
        assertThat(harness.operations.stream()
                .map(operation -> operation.get("kind")))
                .containsExactly("dispatch_started", "attach");

        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "COMPLETED", now + 1L, null));
        when(store.terminalResultText(TENANT, CHILD, "turn-1"))
                .thenReturn("审阅通过");
        relay.scan();
        assertThat(row.get().state()).isEqualTo("delivering");
        assertThat(harness.operations.stream()
                .map(operation -> operation.get("kind")))
                .containsExactly("dispatch_started", "attach", "commit_result",
                        "accept");
        Map<String, Object> accept = harness.operations.get(3);
        assertThat(accept.get("notification")).isEqualTo(
                Map.of("description", "audit the diff"));

        // The acceptance is committed: the next scan must still issue the
        // relay's own mark_accepted — the early-out covers only arms past
        // delivering, never the delivering arm itself.
        when(store.hasAcceptance(TENANT, PARENT, RUN)).thenReturn(true);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations.stream()
                .map(operation -> operation.get("kind")))
                .containsExactly("dispatch_started", "attach", "commit_result",
                        "accept", "mark_accepted");
        // A done child owes its own Session a close (P2-1).
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
    }

    @Test
    void classifiesAResultAtAClosedParentAsOrphanedWithoutRevival() {
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("CLOSING");
        relay.scan();
        assertThat(row.get().state()).isEqualTo("orphaned");
        assertThat(harness.operations).isEmpty();
        verify(sessions, never()).createChildSession(anyString(), anyString(),
                anyString(), anyString(), anyString());
        // An orphaned run closes nothing: the cascade owns that side.
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
    }

    @Test
    void completesNothingWhenTheAcceptanceAlreadyExists() {
        when(store.hasAcceptance(TENANT, PARENT, RUN)).thenReturn(true);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("creating");
        assertThat(harness.operations).isEmpty();
        verify(store, never()).claim(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyLong(), anyLong());
    }

    @Test
    void anAcceptedWatchRowReconcilesThroughItsIdempotentWalk() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        // The acceptance committed, but the advance to delivering died
        // with the reply: the row stays watching instead.
        when(store.hasAcceptance(TENANT, PARENT, RUN)).thenReturn(true);
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "COMPLETED", now + 1L, null));
        when(store.terminalResultText(TENANT, CHILD, "turn-1"))
                .thenReturn("审阅通过");
        // First scan: no early-out; the same idempotent walk re-plays the
        // result and the acceptance, then advances.
        relay.scan();
        assertThat(row.get().state()).isEqualTo("delivering");
        // Next scan: only the owed mark_accepted remains, and it closes.
        relay.scan();
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations.stream()
                .map(operation -> operation.get("kind")))
                .containsExactly("commit_result", "accept", "mark_accepted");
    }

    @Test
    void aRunningChildWaitsWithoutEatingAttempts() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "RUNNING", now + 1L, null));
        relay.scan();
        // A running Turn is a wait, not a failure: no attempt, no error,
        // no harness call.
        assertThat(row.get().attempts()).isZero();
        assertThat(row.get().lastError()).isNull();
        assertThat(harness.operations).isEmpty();
        verify(store, never()).defer(any(RelayRow.class), anyString(),
                anyLong(), anyString(), anyLong(), anyLong());
        verify(store, never()).classify(any(RelayRow.class), anyString(),
                anyString(), any(), anyLong());
    }

    @Test
    void aTurnFailureSettlesTheRunFailedWithoutAnAcceptance() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "FAILED", now + 1L, "model"));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        Map<String, Object> fail = harness.operations.get(0);
        assertThat(fail).containsEntry("stopReason", "child_failed")
                .containsEntry("started", true);
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
    }

    // A host that cannot close a Workspace Session never admits one, and
    // the close-first order must not hold the parent's settlement on it:
    // the failed run still settles. But settling the record is not
    // closing the child Session — the row parks as a discoverable
    // `close_debt` instead of retiring, and a later capable scan
    // discharges the owed admission before the row retires.
    @Test
    void aHostWithoutCloseSettlesAndRetainsTheCloseDebt() {
        when(childCloses.closeSupported()).thenReturn(false);
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "FAILED", now + 1L, "model"));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(row.get().childSessionId()).isEqualTo(CHILD);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
        // Capability returns: the next due scan discharges exactly the
        // owed close, nothing else re-commits, and the row retires.
        when(childCloses.closeSupported()).thenReturn(true);
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        relay.scan();
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
    }

    // The capability read that gates the give-up's close feeds both the
    // admission and the retention flag: read twice, a flip between them
    // could lose the debt either way — never admit and call it settled,
    // or admit and still park. One read, one decision, pinned here.
    @Test
    void aGiveUpDecidesCloseFromASingleCapabilityRead() {
        Mockito.when(childCloses.closeSupported()).thenReturn(true, false);
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 63, 0, null, now, now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(null);
        relay.scan();
        verify(childCloses, Mockito.times(1)).closeSupported();
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("unknown");
    }

    // A lost relay session id is not proof that execution never began:
    // ledger `creating/null`, lineage names the child, and its own
    // committed Turn says the run started — the give-up settles
    // child_failed over those proofs, never creation_failed over the
    // missing id.
    @Test
    void aGiveUpReadsLineageAndTurnBeforeChoosingTheFailureProof() {
        when(store.findLineageChild(TENANT, PARENT, RUN)).thenReturn(CHILD);
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "RUNNING", null, null));
        harness.refuseRecord = "attach";
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", null,
                "creating", "owner", now + 30_000, 63, 0, null, now, now));
        when(broker.findLatestBindingByHarnessSession(TENANT, CHILD))
                .thenReturn(null);
        relay.scan();
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        assertThat(harness.operations.get(0))
                .containsEntry("stopReason", "child_failed")
                .containsEntry("started", true);
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
    }

    // The discovery page's own captured delivery is pre-claim evidence
    // only: another worker's settlement landed in between must be the
    // verdict the walk reads — a stale `planned` snapshot must never
    // relaunch creation for a cancelled record.
    @Test
    void aStalePageSnapshotDoesNotRelaunchASettledRecord() {
        when(store.deliveryState(TENANT, PARENT, RUN)).thenReturn(
                "cancelled");
        when(store.sessionStatus(TENANT, CHILD)).thenReturn("ACTIVE");
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(harness.operations).isEmpty();
        verify(sessions, never()).createChildSession(anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    // The bounded give-up on a capability-less host settles the parent's
    // record on time — the give-up and its started pairing are proven
    // facts — but never classifies `unknown` over the owed close: the
    // row parks as `close_debt`, still names the child, and discharges
    // once a capable scan sees it.
    @Test
    void aGiveUpWithoutCloseSupportRetainsItsCloseDebt() {
        when(childCloses.closeSupported()).thenReturn(false);
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 63, 0, null, now, now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(null);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(row.get().childSessionId()).isEqualTo(CHILD);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        assertThat(harness.operations.get(0))
                .containsEntry("stopReason", "child_failed")
                .containsEntry("started", true);
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
        when(childCloses.closeSupported()).thenReturn(true);
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        relay.scan();
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("done");
    }

    // A close-debt row may exhaust its attempt budget (the admission can
    // falter past 64): the give-up chain behind that budget settles
    // records and classifies `unknown` — both already done for this row.
    // It must never run again on it: the debt arm only ever retries its
    // own single verb, and a stopped falter discharges the same row.
    // A host that cannot close parks a debt for the idle interval, not the
    // heartbeat: nothing discharges it before a restart brings the
    // capability back, and every visit costs a page slot and a write.
    @Test
    void aCloseDebtWithoutCloseSupportWaitsTheIdleInterval() {
        when(childCloses.closeSupported()).thenReturn(false);
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "close_debt", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        verify(store).scheduleRetry(any(RelayRow.class), anyString(),
                Mockito.eq(now + 300_000L), anyLong(), anyLong());
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
    }

    @Test
    void aCloseDebtRowNeverEntersTheGiveUpChain() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "close_debt", "owner", now + 30_000, 63, 0, null, now, now));
        Mockito.doThrow(new IllegalStateException("admission refused"))
                .when(childCloses).admitChildClose(TENANT, PARENT, CHILD,
                        RUN);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(row.get().attempts()).isEqualTo(64);
        assertThat(harness.operations).isEmpty();
        Mockito.doReturn(null).when(childCloses)
                .admitChildClose(TENANT, PARENT, CHILD, RUN);
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations).isEmpty();
    }

    // An answered acceptance short-circuits arms the relay owes nothing
    // — never the retained close debt: a delivered run parked on a
    // capability-less host discharges like every sibling.
    @Test
    void anAcceptedCloseDebtStillDischarges() {
        when(store.hasAcceptance(TENANT, PARENT, RUN)).thenReturn(true);
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "close_debt", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations).isEmpty();
    }

    // The settlement committed but the close_debt write never landed —
    // a crash or a lost reply between them: the record is terminal, the
    // ledger still walks, and the parent's cascade already skipped the
    // settled task. A parent that closes in that window must not erase
    // the owed close under `orphaned`: the reconciliation retains the
    // debt (nothing re-settles), and the ordinary discharge closes it.
    @Test
    void aSettledRowRetainsItsCloseAcrossTheParentsClose() {
        when(store.findPendingChildren(Mockito.anyString(), Mockito.anyInt()))
                .thenAnswer(ignored -> List.of(new PendingChild(TENANT,
                        PARENT, RUN, 1, "cancelled", "resource-body")));
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("CLOSED");
        when(store.sessionStatus(TENANT, CHILD)).thenReturn("ACTIVE");
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(row.get().childSessionId()).isEqualTo(CHILD);
        assertThat(harness.operations).isEmpty();
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        relay.scan();
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("done");
    }

    // A creation failure whose settle committed but whose terminal
    // classification write never landed: the settled arm discovers the
    // row for reconciliation, and the walk must never re-enter the
    // creation path — launching here would start work already recorded
    // as never started. With no child standing it retires `unknown`.
    @Test
    void aSettledCancelledRecordNeverReEntersCreation() {
        when(store.findPendingChildren(Mockito.anyString(), Mockito.anyInt()))
                .thenAnswer(ignored -> List.of(new PendingChild(TENANT,
                        PARENT, RUN, 1, "cancelled", "resource-body")));
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", null,
                "creating", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        assertThat(harness.operations).isEmpty();
        verify(sessions, never()).createChildSession(anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
    }

    // The same settled-cancelled surface re-arms only its owed residue:
    // a binding-state interruption that left a standing child parks the
    // close debt — no fail commit, no dispatch — and the ordinary
    // discharge then admits exactly one close.
    @Test
    void aSettledCancelledRecordWithAStandingChildRetainsItsClose() {
        when(store.findPendingChildren(Mockito.anyString(), Mockito.anyInt()))
                .thenAnswer(ignored -> List.of(new PendingChild(TENANT,
                        PARENT, RUN, 1, "cancelled", "resource-body")));
        when(store.sessionStatus(TENANT, CHILD)).thenReturn("ACTIVE");
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "binding", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(harness.operations).isEmpty();
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        relay.scan();
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("done");
    }

    // The lineage fallback of the same boundary: a creation-answer-lost
    // row that learned its child only from the committed lineage keeps
    // that id on the parked debt, so the discharge knows its Session.
    @Test
    void aSettledLineageRowRetainsItsCloseAcrossParentDelete() {
        when(store.findPendingChildren(Mockito.anyString(), Mockito.anyInt()))
                .thenAnswer(ignored -> List.of(new PendingChild(TENANT,
                        PARENT, RUN, 1, "cancelled", "resource-body")));
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("DELETED");
        when(store.sessionStatus(TENANT, CHILD)).thenReturn("ACTIVE");
        when(store.findLineageChild(TENANT, PARENT, RUN)).thenReturn(CHILD);
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", null,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(row.get().childSessionId()).isEqualTo(CHILD);
        assertThat(harness.operations).isEmpty();
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
    }

    // The orphaned arm still owns every walk whose child no longer
    // stands: a ledger row with no Session row to close classifies
    // orphaned, exactly as it always has.
    @Test
    void anUnsettledRowStillOrphansAtParentClose() {
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("CLOSED");
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("orphaned");
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
    }

    // The retention default of the same arm: whichever side wins the
    // parent-first race, a child that still stands keeps its one
    // discoverable holder — the debt parks with its name, and no
    // classification retires the owed close while the child stands.
    @Test
    void aStandingChildNeverOrphansAcrossParentClose() {
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("CLOSED");
        when(store.sessionStatus(TENANT, CHILD)).thenReturn("ACTIVE");
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(row.get().childSessionId()).isEqualTo(CHILD);
        assertThat(harness.operations).isEmpty();
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
    }

    // The no-child proof is pre-collapse evidence only: if the create
    // side's lineage shows up after the veto, the give-up owes the
    // bounded wait and never commits a `creation_failed` verdict over a
    // now-provable running child.
    @Test
    void aGiveUpDefersALateLifecycleChildRatherThanMisclassifyIt() {
        when(store.findLineageChild(TENANT, PARENT, RUN))
                .thenReturn(null, CHILD, CHILD, CHILD);
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "RUNNING", null, null));
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", null,
                "creating", "owner", now + 30_000, 63, 0, null, now, now));
        when(broker.findLatestBindingByHarnessSession(TENANT, CHILD))
                .thenReturn(null);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("creating");
        assertThat(row.get().attempts()).isEqualTo(64);
        assertThat(harness.operations).isEmpty();
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "COMPLETED", now + 1, null));
        harness.refuseRecord = "attach";
        relay.scan();
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        assertThat(harness.operations.get(0))
                .containsEntry("stopReason", "child_failed")
                .containsEntry("started", true);
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("unknown");
    }

    // And nothing is owed a close that already happened: a settled row
    // whose child is terminaled for any other reason classifies exactly
    // as the old orphaned arm did.
    @Test
    void aSettledRowWithAnAlreadyClosedChildStillOrphans() {
        when(store.findPendingChildren(Mockito.anyString(), Mockito.anyInt()))
                .thenAnswer(ignored -> List.of(new PendingChild(TENANT,
                        PARENT, RUN, 1, "cancelled", "resource-body")));
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("CLOSED");
        when(store.sessionStatus(TENANT, CHILD)).thenReturn("CLOSED");
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("orphaned");
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
    }

    // Task settlement leads delivery settlement: `commitChildResult`
    // already projects task `completed` (out of the close cascade's live
    // scopes) the moment delivery reaches `accepting`, and a lost reply
    // or a failed acceptance call interrupts before `accepted`. A parent
    // closing in that walk must not orphan the owed close either — the
    // same retention parks and discharges it.
    @Test
    void anAcceptingDeliveryRetainsItsCloseAcrossParentClose() {
        when(store.findPendingChildren(Mockito.anyString(), Mockito.anyInt()))
                .thenAnswer(ignored -> List.of(new PendingChild(TENANT,
                        PARENT, RUN, 1, "accepting", "resource-body")));
        when(store.sessionStatus(TENANT, PARENT)).thenReturn("DELETED");
        when(store.sessionStatus(TENANT, CHILD)).thenReturn("ACTIVE");
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "delivering", "owner", now + 30_000, 0, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("close_debt");
        assertThat(harness.operations).isEmpty();
        verify(childCloses, never()).admitChildClose(anyString(), anyString(),
                anyString(), anyString());
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        relay.scan();
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(row.get().state()).isEqualTo("done");
    }

    // R4-3: a faltered close admission parks the row BEFORE the fail
    // commit, so nothing moves delivery to `cancelled` while the child
    // Session is still owed its durable close; the recovered retry
    // closes first, then commits exactly once.
    @Test
    void aFalteredCloseDelaysTheFailCommitUntilAdmitted() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "FAILED", now + 1L, "model"));
        Mockito.doThrow(new IllegalStateException("admission refused"))
                .when(childCloses).admitChildClose(TENANT, PARENT, CHILD,
                        RUN);

        relay.scan();
        assertThat(harness.operations).isEmpty();
        assertThat(row.get().state()).isEqualTo("watching");
        assertThat(row.get().attempts()).isEqualTo(1);

        Mockito.doReturn(null).when(childCloses).admitChildClose(TENANT,
                PARENT, CHILD, RUN);
        // The retry window arrived: the parked row is due again.
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        verify(childCloses, Mockito.times(2)).admitChildClose(TENANT, PARENT,
                CHILD, RUN);
    }

    // R1-10/R1-11: the copy bound is the parent's durable inline limit —
    // an over-bound result takes the quota refusal with its proven
    // classification, and the child close lands before it, never after
    // the classification.
    @Test
    void anOverBoundResultSettlesQuotaWithItsClose() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 0, 0, null, now, now));
        when(store.latestTurn(TENANT, CHILD)).thenReturn(
                new TurnLine("turn-1", "COMPLETED", now + 1L, null));
        when(store.terminalResultText(TENANT, CHILD, "turn-1"))
                .thenReturn("x".repeat(64 * 1024 + 1));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("done");
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        assertThat(harness.operations.get(0))
                .containsEntry("stopReason", "quota_exceeded")
                .containsEntry("reason", "byte_limit")
                .containsEntry("started", true);
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
    }

    // R1-7/12: an attached give-up closes the child BEFORE the parent
    // settlement — and `started` names exactly what the parent's
    // committed attach proves, so the funnel accepts the transition.
    @Test
    void anAttachedGiveUpClosesSettlesAndClassifies() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "watching", "owner", now + 30_000, 63, 0, null, now, now));
        // A settled Turn that yields no Turn line at all retried 64
        // times: the watcher defers until the give-up chain runs.
        when(store.latestTurn(TENANT, CHILD)).thenReturn(null);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        assertThat(harness.operations.get(0))
                .containsEntry("stopReason", "child_failed")
                .containsEntry("started", true);
    }

    // R1-7/12: a binding-state give-up with an attached record — the
    // replayed attach IS that evidence; the ledger's walk never decides.
    // The reconciliation recovers a lost attach reply.
    @Test
    void aBindingGiveUpReconcilesItsLostAttachReply() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "binding", "owner", now + 30_000, 63, 0, null, now, now));
        when(broker.findLatestBindingByHarnessSession(TENANT, CHILD))
                .thenReturn(null);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("attach", "fail");
        assertThat(harness.operations.get(1))
                .containsEntry("stopReason", "child_failed")
                .containsEntry("started", true);
    }

    // R1-7/12: when the record vetoes the attach replay
    // (`child_operation_record`), it carries the unattached truth —
    // the settle takes the unstarted pairing and classifies; the row
    // only defers on a refusal the record never owes an answer for.
    @Test
    void aRecordVetoReconcilesUnstartedAtGiveUp() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "binding", "owner", now + 30_000, 63, 0, null, now, now));
        harness.refuseRecord = "attach";
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        assertThat(harness.operations.get(0))
                .containsEntry("stopReason", "creation_failed")
                .containsEntry("started", false);
    }

    @Test
    void aTransientAttachRefusalKeepsTheDebtAtGiveUp() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "binding", "owner", now + 30_000, 63, 0, null, now, now));
        harness.refuseKind = "attach";
        relay.scan();
        assertThat(row.get().state()).isEqualTo("binding");
        assertThat(harness.operations).isEmpty();
        harness.refuseKind = null;
        dueAgain();
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(childCloses).admitChildClose(TENANT, PARENT, CHILD, RUN);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("attach", "fail");
    }

    // R1-7/12: a creation the control plane never proved has no close
    // obligation and takes the never-started pairing only.
    @Test
    void anUnprovenCreationSettlesCreationFailedWithoutAClose() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", null,
                "creating", "owner", now + 30_000, 63, 0, null, now, now));
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(childCloses, never()).admitChildClose(anyString(),
                anyString(), anyString(), anyString());
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("fail");
        assertThat(harness.operations.get(0))
                .containsEntry("stopReason", "creation_failed")
                .containsEntry("started", false);
    }

    // R1-7/12: a refusal anywhere in the give-up chain keeps the row as
    // the settlement's durable holder — no speculative retirement; the
    // recovered retry closes, settles and only then classifies.
    @Test
    void aRefusedGiveUpChainKeepsItsDebtRecoverable() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "binding", "owner", now + 30_000, 63, 0, null, now, now));
        harness.refuseKind = "fail";
        relay.scan();
        assertThat(row.get().state()).isEqualTo("binding");
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("attach");
        verify(store, never()).classify(any(RelayRow.class), anyString(),
                anyString(), any(), anyLong());
        harness.refuseKind = null;
        dueAgain();
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        // The close replays idempotently under its stable key each round.
        verify(childCloses, Mockito.times(2)).admitChildClose(TENANT,
                PARENT, CHILD, RUN);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("attach", "attach", "fail");
        assertThat(harness.operations.get(2))
                .containsEntry("stopReason", "child_failed")
                .containsEntry("started", true);
    }

    // R1-7/12: the same debt ordering guards the close gate itself — a
    // faltered admission parks before any settlement reaches the wire.
    @Test
    void aFalteredGiveUpCloseRetainsTheCleanupDebt() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "binding", "owner", now + 30_000, 63, 0, null, now, now));
        Mockito.doThrow(new IllegalStateException("admission refused"))
                .when(childCloses).admitChildClose(TENANT, PARENT, CHILD,
                        RUN);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("binding");
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("attach");
        Mockito.doReturn(null).when(childCloses).admitChildClose(TENANT,
                PARENT, CHILD, RUN);
        dueAgain();
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(childCloses, Mockito.times(2)).admitChildClose(TENANT, PARENT,
                CHILD, RUN);
        assertThat(harness.operations)
                .extracting(operation -> operation.get("kind"))
                .containsExactly("attach", "attach", "fail");
    }

    /** The retry window arrived: the parked row is due again. */
    private void dueAgain() {
        RelayRow parked = row.get();
        row.set(new RelayRow(parked.tenantId(), parked.parentSessionId(),
                parked.childRunId(), parked.creationKey(),
                parked.childSessionId(), parked.state(), parked.claimedBy(),
                now + 30_000, parked.attempts(), 0, parked.lastError(),
                parked.createdAt(), now));
    }

    // R1-66: the relay's page of sequential harness calls must not ride
    // the shared default scheduler — its pin is the annotation itself.
    @Test
    void scanRunsOnItsOwnScheduler() throws Exception {
        var scheduled = ChildResultRelay.class.getMethod("scan")
                .getAnnotation(
                        org.springframework.scheduling.annotation.Scheduled.class);
        assertThat(scheduled.scheduler()).isEqualTo("childRelayScheduler");
    }
}
