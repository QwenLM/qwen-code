package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessSessionRefusedFailure;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class HarnessCoordinatorProvisioningTest {
    @Test
    void preparationCompletesBeforeTheOriginalTurnLoadsAndSubmitsOnce() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.start();
            fixture.awaitPreparation();

            assertThat(fixture.drive.get().isDone()).isFalse();
            fixture.verifyNoLoadOrRetry();
            assertThat(fixture.current.retryCount()).isZero();
            fixture.warming.complete(null);
            fixture.join();

            var order = inOrder(fixture.warmer, fixture.harness);
            order.verify(fixture.warmer).warm("session");
            order.verify(fixture.harness).createOrLoad("tenant", "session", false);
            order.verify(fixture.harness).submit(eq("tenant"), eq("session"), eq("prompt"), any(), anyString());
            verify(fixture.store).recordHarnessEvents(eq("tenant"), eq("session"), eq("turn"), anyString(),
                    eq("epoch"), argThat(events -> events.stream().anyMatch(event -> event.projection().terminal()
                            && "COMPLETED".equals(event.projection().terminalStatus()))));
            assertThat(fixture.failureCode).isNull();
        }
    }

    @Test
    void readinessPublicationCompletesBeforeLoad() throws Exception {
        CountDownLatch publishing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            doAnswer(invocation -> {
                publishing.countDown();
                assertTrue(release.await(3, TimeUnit.SECONDS));
                return null;
            }).when(fixture.store).appendPublicEventIfAbsent(eq("tenant"), eq("session"), eq("turn"),
                    eq("environment.ready"), any(), eq(false), anyString());
            try {
                fixture.start();
                fixture.awaitPreparation();
                Future<?> completion = fixture.threads.submit(() -> fixture.warming.complete(null));
                assertTrue(publishing.await(1, TimeUnit.SECONDS));

                fixture.verifyNoLoadOrRetry();
                assertThat(fixture.drive.get().isDone()).isFalse();
                release.countDown();
                completion.get(3, TimeUnit.SECONDS);
                fixture.join();

                verify(fixture.harness).submit(eq("tenant"), eq("session"), eq("prompt"), any(), anyString());
                assertThat(fixture.failureCode).isNull();
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    void cancellationWhilePreparingDoesNotCancelSharedWarmOrLoadAfterLateCompletion() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.start();
            fixture.awaitPreparation();
            fixture.current = turn(0, false, "CANCELLING", null);
            fixture.join();

            verify(fixture.store).cancelBeforeAdmission(eq("tenant"), eq("session"), eq("turn"), anyString());
            assertThat(fixture.warming.isDone()).isFalse();
            fixture.warming.complete(null);
            fixture.verifyNoLoadOrRetry();
            assertThat(fixture.warming.isCancelled()).isFalse();
        }
    }

    @Test
    void cancellationDuringRetryBackoffDoesNotStartAnotherWarm() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false, Duration.ofSeconds(4))) {
            fixture.warming.completeExceptionally(new RuntimeBrokerException(503,
                    "any_retryable_broker_error", "Try again", true));
            AtomicInteger reads = new AtomicInteger();
            CountDownLatch backoffEntered = new CountDownLatch(1);
            when(fixture.store.findTurn("tenant", "session", "turn")).thenAnswer(invocation -> {
                if (reads.incrementAndGet() == 2) {
                    backoffEntered.countDown();
                }
                return Optional.ofNullable(fixture.row());
            });
            fixture.start();
            assertTrue(backoffEntered.await(1, TimeUnit.SECONDS));
            fixture.current = turn(0, false, "CANCELLING", null);
            fixture.join();

            verify(fixture.store).cancelBeforeAdmission(eq("tenant"), eq("session"), eq("turn"), anyString());
            verify(fixture.warmer).warm("session");
            fixture.verifyNoLoadOrRetry();
            assertThat(fixture.warming.isCancelled()).isFalse();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"CANCELLED", "COMPLETED", "missing"})
    void aTurnSettledElsewhereDoesNotLoadAfterPreparation(String status) throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.start();
            fixture.awaitPreparation();
            fixture.current = "missing".equals(status) ? null : turn(0, false, status, null);
            fixture.warming.complete(null);
            fixture.join();

            fixture.verifyNoLoadOrRetry();
            assertThat(fixture.failureCode).isNull();
        }
    }

    @Test
    void preparationTimeoutDoesNotMutateTheSharedWarmFuture() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofMillis(30), false)) {
            fixture.start();
            fixture.join();

            assertThat(fixture.failureCode).isEqualTo("runtime_preparation_timeout");
            assertThat(fixture.warming.isDone()).isFalse();
            fixture.warming.complete(null);
            fixture.verifyNoLoadOrRetry();
            assertThat(fixture.warming.isCancelled()).isFalse();
        }
    }

    @Test
    void aLostDispatchLeasePreventsLoadWithoutCancellingSharedWarm() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), true)) {
            fixture.start();
            fixture.awaitPreparation();
            fixture.leaseOwned.set(false);
            assertTrue(fixture.leaseLossObserved.await(1, TimeUnit.SECONDS));
            fixture.join();

            verify(fixture.harness, never()).createOrLoad(anyString(), anyString(), anyBoolean());
            verify(fixture.harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
            assertThat(fixture.warming.isDone()).isFalse();
            assertThat(fixture.failureCode).isNull();
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void aChangedOrExpiredDispatchLeaseStopsTheWaitBeforeWarmCompletes(boolean expired) throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.start();
            fixture.awaitPreparation();
            if (expired) {
                fixture.leaseUntil = 0L;
            } else {
                fixture.currentOwner = "another-owner";
            }
            fixture.join();

            assertThat(fixture.warming.isDone()).isFalse();
            fixture.warming.complete(null);
            fixture.verifyNoLoadOrRetry();
            assertThat(fixture.failureCode).isNull();
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void preparationFailureTerminatesBeforeLoad(boolean brokerFailure) throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.warming.completeExceptionally(brokerFailure
                    ? new CompletionException(new RuntimeBrokerException(503, "runtime_broker_provision_failed",
                            "Provisioning failed", false))
                    : new IllegalStateException("Unexpected warm failure"));
            fixture.start();
            fixture.join();

            assertThat(fixture.failureCode).isEqualTo(brokerFailure
                    ? "runtime_broker_provision_failed" : "runtime_warm_failed");
            fixture.verifyNoLoadOrRetry();
        }
    }

    @Test
    void retryableBrokerFailureRetriesPreparationThenSubmitsWithoutATurnRetry() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            when(fixture.warmer.warm("session")).thenReturn(CompletableFuture.failedFuture(
                    new RuntimeBrokerException(503, "any_retryable_broker_error", "Try again", true)), fixture.warming);
            fixture.start();
            fixture.awaitPreparation();

            verify(fixture.warmer, times(2)).warm("session");
            fixture.verifyNoLoadOrRetry();
            fixture.warming.complete(null);
            fixture.join();

            verify(fixture.harness).submit(eq("tenant"), eq("session"), eq("prompt"), any(), anyString());
            assertThat(fixture.current.retryCount()).isZero();
            assertThat(fixture.failureCode).isNull();
        }
    }

    @Test
    void repeatedRetryableBrokerFailuresShareOnePreparationTimeout() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofMillis(30), false)) {
            fixture.warming.completeExceptionally(new RuntimeBrokerException(503,
                    "any_retryable_broker_error", "Still unavailable", true));
            fixture.start();
            fixture.join();

            assertThat(fixture.failureCode).isEqualTo("runtime_preparation_timeout");
            fixture.verifyNoLoadOrRetry();
            assertThat(fixture.current.retryCount()).isZero();
        }
    }

    @Test
    void disabledWarmerLoadsImmediately() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            when(fixture.warmer.isEnabled()).thenReturn(false);
            fixture.start();
            fixture.join();

            verify(fixture.warmer, never()).warm(anyString());
            verify(fixture.harness).submit(eq("tenant"), eq("session"), eq("prompt"), any(), anyString());
            assertThat(fixture.warming.isDone()).isFalse();
            assertThat(fixture.failureCode).isNull();
        }
    }

    @Test
    void unboundTextSessionsDoNotWaitForOptionalWarm() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.session = new SessionRecord("tenant", "session", "qwen-code", null,
                    "ACTIVE", null, null, 0, 0, 1, 1, null, 1);
            when(fixture.harness.isWorkspaceFilesAvailable()).thenReturn(false);
            fixture.start();
            fixture.join();

            verify(fixture.warmer).warm("session");
            verify(fixture.harness).submit(eq("tenant"), eq("session"), eq("prompt"), any(), anyString());
            assertThat(fixture.warming.isDone()).isFalse();
            assertThat(fixture.failureCode).isNull();
        }
    }

    @Test
    void submittedTurnsRecoverWithoutWaitingForOptionalWarm() throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.current = turn(0, true, "RUNNING", "epoch");
            fixture.session = workspaceSession("boot");
            fixture.start();
            fixture.join();

            verify(fixture.warmer).warm("session");
            verify(fixture.harness).recoverManagedRuntime("tenant", "session", false);
            verify(fixture.harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
            assertThat(fixture.warming.isDone()).isFalse();
            assertThat(fixture.failureCode).isNull();
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void aLoadRefusalAfterPreparationStillMeetsTheOriginalBudget(boolean legacy) throws Exception {
        try (Fixture fixture = new Fixture(Duration.ofSeconds(5), false)) {
            fixture.warming.complete(null);
            fixture.refusal = legacy
                    ? new HarnessHttpFailure("Workspace unavailable", null, 409, "{}", Map.of("code", "workspace_unavailable"))
                    : new HarnessSessionRefusedFailure("Workspace unavailable", null, 503, "workspace_runtime_unavailable");
            for (int attempt = 0; attempt < 3; attempt++) {
                fixture.start();
                fixture.join();
            }

            assertThat(fixture.failureCode).isEqualTo(legacy ? "workspace_unavailable" : "workspace_runtime_unavailable");
            assertThat(fixture.current.retryCount()).isEqualTo(2);
            assertThat(fixture.current.budgetExemptFailures()).isZero();
            verify(fixture.store, times(2)).scheduleTurnRetry(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), anyLong(), eq(false));
            verify(fixture.harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
        }
    }

    private static SessionRecord workspaceSession(String bootId) {
        return new SessionRecord("tenant", "session", "qwen-code", null, null, "ACTIVE", bootId, bootId == null ? null : "epoch",
                0, 0, 0, 1, 1, null, 1,
                new ContextBinding("tenant", "workspace", 1, "storage", ".", "config", 1),
                "yolo", "hosted-workspace-files/1");
    }

    private static TurnRecord turn(int failures, boolean submitted, String status, String epoch) {
        return new TurnRecord("tenant", "session", "turn", "prompt",
                List.of(Map.of("type", "text", "text", "hello")), "sha256:" + "a".repeat(64),
                status, submitted, epoch, 0L, null, Long.MAX_VALUE, failures, failures, 0,
                null, null, null, 1, 1, null, 1);
    }

    private static final class Fixture implements AutoCloseable {
        private final AgentStateStore store = mock(AgentStateStore.class);
        private final HarnessConnector harness = mock(HarnessConnector.class);
        private final RuntimeWarmer warmer = mock(RuntimeWarmer.class);
        private final WarmFuture<Void> warming = new WarmFuture<>();
        private final ExecutorService threads = Executors.newVirtualThreadPerTaskExecutor();
        private final AtomicReference<Future<?>> drive = new AtomicReference<>();
        private final AtomicBoolean leaseOwned = new AtomicBoolean(true);
        private final CountDownLatch leaseLossObserved = new CountDownLatch(1);
        private final HarnessCoordinator coordinator;
        private volatile TurnRecord current = turn(0, false, "RUNNING", null);
        private volatile SessionRecord session = workspaceSession(null);
        private volatile RuntimeException refusal;
        private volatile String failureCode;
        private volatile String currentOwner;
        private volatile Long leaseUntil = Long.MAX_VALUE;

        private Fixture(Duration timeout, boolean shortLease) {
            this(timeout, shortLease, Duration.ofMillis(5));
        }

        private Fixture(Duration timeout, boolean shortLease, Duration retryDelay) {
            ExecutorService executor = mock(ExecutorService.class);
            doAnswer(invocation -> {
                FutureTask<Void> task = new FutureTask<>((Runnable) invocation.getArgument(0), null);
                drive.compareAndSet(null, task);
                threads.execute(task);
                return null;
            }).when(executor).execute(any(Runnable.class));
            doAnswer(invocation -> threads.submit((Runnable) invocation.getArgument(0)))
                    .when(executor).submit(any(Runnable.class));
            when(warmer.isEnabled()).thenReturn(true);
            when(warmer.warm("session")).thenReturn(warming);
            when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
            when(store.requireSession("tenant", "session")).thenAnswer(invocation -> session);
            when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"), anyString(), any(Duration.class)))
                    .thenAnswer(invocation -> {
                        currentOwner = invocation.getArgument(3);
                        return Optional.ofNullable(row());
                    });
            when(store.findTurn("tenant", "session", "turn")).thenAnswer(invocation -> Optional.ofNullable(row()));
            when(store.renewTurn(eq("tenant"), eq("session"), eq("turn"), anyString(), any(Duration.class)))
                    .thenAnswer(invocation -> {
                        if (!leaseOwned.get()) {
                            leaseLossObserved.countDown();
                        }
                        return leaseOwned.get();
                    });
            doAnswer(invocation -> {
                if (leaseOwned.get()) {
                    current = turn(current.retryCount() + 1, current.submissionAttempted(),
                            current.status(), current.harnessEventEpoch());
                }
                return null;
            }).when(store).scheduleTurnRetry(anyString(), anyString(), anyString(), anyString(), anyLong(), anyBoolean());
            doAnswer(invocation -> {
                failureCode = invocation.getArgument(4);
                return null;
            }).when(store).failTurn(anyString(), anyString(), anyString(), anyString(), anyString(), anyString());
            when(harness.createOrLoad("tenant", "session", false)).thenAnswer(invocation -> load());
            when(harness.recoverManagedRuntime("tenant", "session", false)).thenAnswer(invocation -> load());
            when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"), anyString(), eq("boot")))
                    .thenReturn(true);
            doAnswer(invocation -> {
                current = turn(current.retryCount(), true, current.status(), current.harnessEventEpoch());
                return null;
            }).when(store).markSubmissionAttempted(eq("tenant"), eq("session"), eq("turn"), anyString());
            when(harness.submit(eq("tenant"), eq("session"), eq("prompt"), any(), anyString()))
                    .thenReturn(new Admission(0, "epoch"));
            doAnswer(invocation -> {
                current = turn(0, true, current.status(), "epoch");
                return null;
            }).when(store).recordAdmission(eq("tenant"), eq("session"), eq("turn"), anyString(), eq("epoch"), eq(0L));
            when(harness.stream("tenant", "session", 0, "epoch")).thenAnswer(invocation -> terminalStream());
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getHarness().setLoadTimeout(timeout);
            properties.getDispatch().setMaxPreAdmissionRetries(2);
            properties.getDispatch().setRetryInitialDelay(retryDelay);
            if (shortLease) {
                properties.getDispatch().setLeaseDuration(Duration.ofMillis(100));
                properties.getDispatch().setLeaseRenewInterval(Duration.ofMillis(20));
            }
            coordinator = new HarnessCoordinator(store, harness, new HarnessEventProjector(), warmer,
                    executor, Clock.systemUTC(), properties);
        }

        private Attachment load() {
            if (refusal != null) {
                throw refusal;
            }
            return new Attachment("boot", null, 0L, "epoch");
        }

        private TurnRecord row() {
            TurnRecord value = current;
            return value == null ? null : new TurnRecord(value.tenantId(), value.sessionId(), value.turnId(),
                    value.promptId(), value.input(), value.payloadDigest(), value.status(), value.submissionAttempted(),
                    value.harnessEventEpoch(), value.harnessLastEventId(), currentOwner, leaseUntil,
                    value.retryCount(), value.consecutiveFailures(), value.budgetExemptFailures(), value.retryAfter(),
                    value.errorCode(), value.errorMessage(), value.createdAt(), value.updatedAt(), value.completedAt(), value.version());
        }

        private void start() {
            drive.set(null);
            coordinator.dispatch("tenant", "session", "turn");
        }

        private void awaitPreparation() throws InterruptedException {
            assertTrue(warming.awaited.await(1, TimeUnit.SECONDS));
        }

        private void join() throws Exception {
            drive.get().get(3, TimeUnit.SECONDS);
        }

        private void verifyNoLoadOrRetry() {
            verify(harness, never()).createOrLoad(anyString(), anyString(), anyBoolean());
            verify(harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
            verify(store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                    anyString(), anyLong(), anyBoolean());
        }

        @Override
        public void close() throws InterruptedException {
            coordinator.close();
            threads.shutdownNow();
            assertTrue(threads.awaitTermination(3, TimeUnit.SECONDS));
        }
    }

    private static final class WarmFuture<T> extends CompletableFuture<T> {
        private final CountDownLatch awaited;

        private WarmFuture() {
            this(new CountDownLatch(1));
        }

        private WarmFuture(CountDownLatch awaited) {
            this.awaited = awaited;
        }

        @Override
        public <U> CompletableFuture<U> newIncompleteFuture() {
            return new WarmFuture<>(awaited);
        }

        @Override
        public T get(long timeout, TimeUnit unit) throws InterruptedException, ExecutionException, TimeoutException {
            awaited.countDown();
            return super.get(timeout, unit);
        }
    }

    private static SourceStream terminalStream() {
        return new SourceStream() {
            private boolean emitted;

            @Override
            public String eventEpoch() {
                return "epoch";
            }

            @Override
            public SourceEvent next() {
                if (emitted) {
                    return null;
                }
                emitted = true;
                return new SourceEvent(1L, "turn_complete", Map.of("stopReason", "end_turn"), "prompt", Map.of());
            }

            @Override
            public void close() {
            }
        };
    }
}
