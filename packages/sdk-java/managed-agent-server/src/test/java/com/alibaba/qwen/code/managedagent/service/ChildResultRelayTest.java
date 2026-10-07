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
            operations.add(Map.copyOf(body));
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
        now = 1_000_000L;
        AtomicReference<Long> clock = new AtomicReference<>(now);
        relay = new ChildResultRelay(store, sessions, provider, harness,
                new ObjectMapper(), childCloses, clock::get);
        pending = new PendingChild(TENANT, PARENT, RUN, 1, "planned",
                "resource-body");
        row = new AtomicReference<>(new RelayRow(TENANT, PARENT, RUN,
                "creation-key", null, "creating", "owner", now + 30_000, 0, 0,
                null, now, now));
        when(store.findPendingChildren(Mockito.anyInt()))
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

    @Test
    void persistentProbeFailuresBecomeUnknownNeverRerun() {
        row.set(new RelayRow(TENANT, PARENT, RUN, "creation-key", CHILD,
                "binding", "owner", now + 30_000, 63, 0, null, now, now));
        when(broker.findLatestBindingByHarnessSession(TENANT, CHILD))
                .thenReturn(null);
        relay.scan();
        assertThat(row.get().state()).isEqualTo("unknown");
        verify(store, atLeastOnce()).classify(any(RelayRow.class),
                anyString(), anyString(), any(), anyLong());
        assertThat(harness.operations).isEmpty();
    }
}
