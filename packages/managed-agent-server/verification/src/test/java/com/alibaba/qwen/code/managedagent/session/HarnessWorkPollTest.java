package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore.Claim;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore.Placement;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class HarnessWorkPollTest {
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final List<String> FEATURES =
            List.of("work-pull/1", "harness-pool-owner/1", "harness-instance-lifecycle/1");
    private final HarnessPlacementStore placements = mock(HarnessPlacementStore.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private HarnessWorkPoll work;
    private Runnable demand;

    @BeforeEach
    void setup() {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setToken("test-token");
        properties.getHarness().setCapabilityDigest(DIGEST);
        work = new HarnessWorkPoll(placements, harness, properties);
        var listener = ArgumentCaptor.forClass(Runnable.class);
        verify(harness).onClaimDemand(listener.capture());
        demand = listener.getValue();
        when(harness.acceptsWorkPullClaims("pod-b", "boot-b")).thenReturn(true);
        when(harness.acceptsWorkPullReoffers("pod-b", "boot-b")).thenReturn(true);
    }

    @AfterEach
    void stop() {
        work.shutdown();
    }

    @Test
    void refusesAPollerOutsideTheHarnessContract() {
        for (Runnable refused : List.<Runnable>of(
                () -> work.poll("wrong-token", poll(1, 0)),
                () -> work.poll(null, poll(1, 0)),
                () -> work.poll("test-token", new HarnessWorkPoll.Poll("pod-b", "boot-b",
                        "sha256:" + "b".repeat(64), FEATURES, 1, 0)),
                () -> work.poll("test-token", new HarnessWorkPoll.Poll("pod-b", "boot-b", DIGEST,
                        List.of("harness-pool-owner/1", "harness-instance-lifecycle/1"), 1, 0)),
                () -> work.poll("test-token", new HarnessWorkPoll.Poll("pod b", "boot-b", DIGEST, FEATURES, 1, 0)),
                () -> work.poll("test-token", new HarnessWorkPoll.Poll("pod-b", null, DIGEST, FEATURES, 1, 0)),
                () -> work.poll("test-token", new HarnessWorkPoll.Poll("pod-b", "boot-b", DIGEST, FEATURES, 101, 0)))) {
            assertThatThrownBy(refused::run).isInstanceOf(ManagedAgentException.class)
                    .extracting("code").isEqualTo("harness_work_poller_refused");
        }
        verifyNoInteractions(placements);
    }

    @Test
    void reoffersLiveClaimsThenClaimsOldestDemandWithinFreeSlots() throws Exception {
        var held = claim("held", 4);
        var live = candidate("live", 2);
        var released = candidate("released", 5);
        var taken = claim("released", 6);
        when(placements.findReservedClaims("pod-b", "boot-b", 100)).thenReturn(List.of(held));
        when(placements.findClaimCandidates(100)).thenReturn(List.of(live, released));
        when(placements.claim("t", "live", live, "pod-b", "boot-b"))
                .thenThrow(new ManagedAgentException(409, "harness_owner_still_live", "live"));
        when(placements.claim("t", "released", released, "pod-b", "boot-b")).thenReturn(taken);
        when(harness.claimLoad(eq("t"), anyString(), any()))
                .thenAnswer(call -> Map.of("sessionId", call.getArgument(1)));

        var reply = work.poll("test-token", poll(3, 20_000)).get(5, TimeUnit.SECONDS);

        assertThat(reply.claims()).extracting(HarnessWorkPoll.ClaimOffer::sessionId)
                .containsExactly("held", "released");
        var offer = reply.claims().get(1);
        assertThat(offer.placementEpoch()).isEqualTo(6);
        assertThat(offer.reservedUntil()).isEqualTo(99);
        assertThat(offer.load()).containsEntry("sessionId", "released");
    }

    @Test
    void aNonMemberClaimsNothing() throws Exception {
        when(harness.acceptsWorkPullClaims("pod-b", "boot-b")).thenReturn(false);
        when(harness.acceptsWorkPullReoffers("pod-b", "boot-b")).thenReturn(false);
        assertThat(work.poll("test-token", poll(1, 0)).get(5, TimeUnit.SECONDS).claims()).isEmpty();
        verifyNoInteractions(placements);
    }

    @Test
    void aZeroSlotOrDrainingPollerStillReceivesItsHeldClaim() throws Exception {
        var held = claim("held", 4);
        when(placements.findReservedClaims("pod-b", "boot-b", 100)).thenReturn(List.of(held));
        when(harness.claimLoad("t", "held", held.placement())).thenReturn(Map.of("sessionId", "held"));

        assertThat(work.poll("test-token", poll(0, 0)).get(5, TimeUnit.SECONDS).claims())
                .extracting(HarnessWorkPoll.ClaimOffer::sessionId).containsExactly("held");

        when(harness.acceptsWorkPullClaims("pod-b", "boot-b")).thenReturn(false);
        assertThat(work.poll("test-token", poll(0, 0)).get(5, TimeUnit.SECONDS).claims())
                .extracting(HarnessWorkPoll.ClaimOffer::sessionId).containsExactly("held");
        verify(placements, never()).findClaimCandidates(anyInt());
    }

    @Test
    void aHeldClaimWhoseLoadFailsDoesNotConsumeANewClaimSlot() throws Exception {
        var held = claim("held", 4);
        var live = candidate("live", 2);
        var released = candidate("released", 5);
        when(placements.findReservedClaims("pod-b", "boot-b", 100)).thenReturn(List.of(held));
        when(placements.findClaimCandidates(100)).thenReturn(List.of(live, released));
        when(placements.claim("t", "live", live, "pod-b", "boot-b")).thenReturn(claim("live", 3));
        when(placements.claim("t", "released", released, "pod-b", "boot-b")).thenReturn(claim("released", 6));
        when(harness.claimLoad(eq("t"), anyString(), any())).thenAnswer(call -> {
            if (call.getArgument(1).equals("held")) {
                throw new IllegalStateException("not loadable");
            }
            return Map.of("sessionId", call.getArgument(1));
        });

        var reply = work.poll("test-token", poll(2, 0)).get(5, TimeUnit.SECONDS);

        assertThat(reply.claims()).extracting(HarnessWorkPoll.ClaimOffer::sessionId)
                .containsExactly("live", "released");
    }

    @Test
    void demandOnThisInstanceWakesAWaitingPoll() throws Exception {
        var woken = candidate("woken", 2);
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        when(placements.findClaimCandidates(100)).thenReturn(List.of()).thenReturn(List.of(woken));
        when(placements.claim("t", "woken", woken, "pod-b", "boot-b")).thenReturn(claim("woken", 3));
        when(harness.claimLoad(any(), any(), any())).thenReturn(Map.of());

        var pending = work.poll("test-token", poll(1, 20_000));
        verify(placements, timeout(1_000)).findClaimCandidates(100);
        demand.run();

        assertThat(pending.get(400, TimeUnit.MILLISECONDS).claims())
                .extracting(HarnessWorkPoll.ClaimOffer::sessionId).containsExactly("woken");
    }

    @Test
    void aSessionWhoseLoadCannotBeBuiltIsNeverClaimed() throws Exception {
        var released = candidate("released", 2);
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        when(placements.findClaimCandidates(100)).thenReturn(List.of(released));
        when(harness.claimLoad(any(), any(), any())).thenThrow(new IllegalStateException("not loadable"));

        assertThat(work.poll("test-token", poll(1, 0)).get(5, TimeUnit.SECONDS).claims()).isEmpty();
        verify(harness).claimLoad("t", "released",
                new Placement("t", "released", "ws", "pod-b", "boot-b", 3, "ACTIVE"));
        verify(placements, never()).claim(any(), any(), any(), any(), any());
    }

    @Test
    void anUnloadableCandidateDoesNotConsumeTheCandidateBatch() throws Exception {
        var unloadable = candidate("unloadable", 2);
        var claimable = candidate("claimable", 5);
        var unneeded = candidate("unneeded", 8);
        when(placements.findClaimCandidates(100)).thenReturn(List.of(unloadable, claimable, unneeded));
        when(placements.claim("t", "claimable", claimable, "pod-b", "boot-b")).thenReturn(claim("claimable", 6));
        when(harness.claimLoad(eq("t"), anyString(), any())).thenAnswer(call -> {
            if (call.getArgument(1).equals("unloadable")) {
                throw new IllegalStateException("not loadable");
            }
            return Map.of("sessionId", call.getArgument(1));
        });

        var reply = work.poll("test-token", poll(1, 0)).get(5, TimeUnit.SECONDS);

        assertThat(reply.claims()).extracting(HarnessWorkPoll.ClaimOffer::sessionId).containsExactly("claimable");
        verify(harness, never()).claimLoad(eq("t"), eq("unneeded"), any());
    }

    @Test
    void aBlockedClaimDoesNotDelayAnUnrelatedWaiterPastItsDeadline() throws Exception {
        when(harness.acceptsWorkPullClaims(anyString(), anyString())).thenReturn(true);
        when(harness.acceptsWorkPullReoffers(anyString(), anyString())).thenReturn(true);
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        var blocked = candidate("blocked", 2);
        var queries = new AtomicInteger();
        var claimEntered = new CountDownLatch(1);
        var releaseClaim = new CountDownLatch(1);
        when(placements.findClaimCandidates(100))
                .thenAnswer(call -> queries.getAndIncrement() == 0 ? List.of(blocked) : List.of());
        when(harness.claimLoad(any(), any(), any())).thenReturn(Map.of());
        when(placements.claim("t", "blocked", blocked, "pod-b", "boot-b")).thenAnswer(call -> {
            claimEntered.countDown();
            if (!releaseClaim.await(2, TimeUnit.SECONDS)) {
                throw new IllegalStateException("claim release timed out");
            }
            return claim("blocked", 3);
        });
        var first = work.poll("test-token", poll(1, 20_000));
        assertThat(claimEntered.await(1, TimeUnit.SECONDS)).isTrue();

        var second = work.poll("test-token", new HarnessWorkPoll.Poll(
                "pod-c", "boot-c", DIGEST, FEATURES, 1, 100));
        HarnessWorkPoll.Reply secondReply;
        try {
            secondReply = second.get(1, TimeUnit.SECONDS);
        } finally {
            releaseClaim.countDown();
        }
        first.get(1, TimeUnit.SECONDS);

        assertThat(secondReply.claims()).isEmpty();
    }

    @Test
    void aWakeRacingAPeriodicAttemptDoesNotRunConcurrentOffers() throws Exception {
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        var woken = candidate("woken", 2);
        var queries = new AtomicInteger();
        var periodicEntered = new CountDownLatch(1);
        var releasePeriodic = new CountDownLatch(1);
        var wakeQuery = new CountDownLatch(1);
        when(placements.findClaimCandidates(100)).thenAnswer(call -> {
            int query = queries.incrementAndGet();
            if (query == 2) {
                periodicEntered.countDown();
                if (!releasePeriodic.await(2, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("periodic attempt release timed out");
                }
            } else if (query == 3) {
                wakeQuery.countDown();
            }
            return query == 1 ? List.of() : List.of(woken);
        });
        when(placements.claim("t", "woken", woken, "pod-b", "boot-b")).thenReturn(claim("woken", 3));
        when(harness.claimLoad(any(), any(), any())).thenReturn(Map.of());
        var pending = work.poll("test-token", poll(1, 20_000));
        assertThat(periodicEntered.await(2, TimeUnit.SECONDS)).isTrue();

        demand.run();
        try {
            assertThat(wakeQuery.await(200, TimeUnit.MILLISECONDS))
                    .as("the wake waits for the periodic process attempt").isFalse();
        } finally {
            releasePeriodic.countDown();
        }

        assertThat(pending.get(2, TimeUnit.SECONDS).claims())
                .extracting(HarnessWorkPoll.ClaimOffer::sessionId).containsExactly("woken");
        assertThat(queries).hasValue(2);
    }

    @Test
    void supersessionMidOfferKeepsOneClaimAndReoffersTheCommittedReservation() throws Exception {
        when(harness.acceptsWorkPullClaims(anyString(), anyString())).thenReturn(true);
        when(harness.acceptsWorkPullReoffers(anyString(), anyString())).thenReturn(true);
        var taken = candidate("taken", 2);
        var held = claim("taken", 3);
        var committed = new AtomicBoolean();
        var claimEntered = new CountDownLatch(1);
        var releaseClaim = new CountDownLatch(1);
        var secondCandidateQuery = new CountDownLatch(1);
        var candidateQueries = new AtomicInteger();
        when(placements.findReservedClaims(anyString(), anyString(), anyInt()))
                .thenAnswer(call -> committed.get() ? List.of(held) : List.of());
        when(placements.findClaimCandidates(100)).thenAnswer(call -> {
            if (candidateQueries.incrementAndGet() == 2) {
                secondCandidateQuery.countDown();
            }
            return committed.get() ? List.of() : List.of(taken);
        });
        when(harness.claimLoad(any(), any(), any())).thenReturn(Map.of());
        when(placements.claim("t", "taken", taken, "pod-b", "boot-b")).thenAnswer(call -> {
            claimEntered.countDown();
            if (!releaseClaim.await(2, TimeUnit.SECONDS)) {
                throw new IllegalStateException("claim release timed out");
            }
            committed.set(true);
            return held;
        });
        var older = work.poll("test-token", poll(1, 20_000));
        assertThat(claimEntered.await(1, TimeUnit.SECONDS)).isTrue();

        var newer = work.poll("test-token", poll(1, 20_000));
        try {
            assertThat(older.get(1, TimeUnit.SECONDS).claims()).isEmpty();
            assertThat(secondCandidateQuery.await(200, TimeUnit.MILLISECONDS))
                    .as("the replacement waits for the superseded process attempt").isFalse();
        } finally {
            releaseClaim.countDown();
        }

        assertThat(newer.get(2, TimeUnit.SECONDS).claims())
                .extracting(HarnessWorkPoll.ClaimOffer::sessionId).containsExactly("taken");
        assertThat(candidateQueries).hasValue(1);
        verify(placements).claim("t", "taken", taken, "pod-b", "boot-b");
    }

    @Test
    void aNewerPollFromTheSameProcessSupersedesTheOlderOne() throws Exception {
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        when(placements.findClaimCandidates(anyInt())).thenReturn(List.of());
        var older = work.poll("test-token", poll(1, 20_000));
        var newer = work.poll("test-token", poll(1, 20_000));

        assertThat(older.get(1, TimeUnit.SECONDS).claims()).isEmpty();
        assertThat(newer).isNotDone();
    }

    @Test
    void concurrentPollsKeepOneWaiterPerProcess() throws Exception {
        when(harness.acceptsWorkPullClaims(anyString(), anyString())).thenReturn(true);
        when(harness.acceptsWorkPullReoffers(anyString(), anyString())).thenReturn(true);
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        when(placements.findClaimCandidates(anyInt())).thenReturn(List.of());
        var requests = Executors.newFixedThreadPool(2);
        try {
            for (int round = 0; round < 2_000; round++) {
                var start = new CountDownLatch(1);
                var poll = new HarnessWorkPoll.Poll("pod-b", "boot-" + round, DIGEST, FEATURES, 1, 20_000);
                var first = requests.submit(() -> {
                    start.await();
                    return work.poll("test-token", poll);
                });
                var second = requests.submit(() -> {
                    start.await();
                    return work.poll("test-token", poll);
                });
                start.countDown();
                var firstReply = first.get(5, TimeUnit.SECONDS);
                var secondReply = second.get(5, TimeUnit.SECONDS);
                assertThat(firstReply.isDone() ^ secondReply.isDone()).as("round %s", round).isTrue();
                var superseded = firstReply.isDone() ? firstReply : secondReply;
                assertThat(superseded.get(1, TimeUnit.SECONDS).claims()).isEmpty();
            }
        } finally {
            requests.shutdownNow();
        }
    }

    @Test
    void pollsFromDifferentProcessesStayIndependent() {
        when(harness.acceptsWorkPullClaims(anyString(), anyString())).thenReturn(true);
        when(harness.acceptsWorkPullReoffers(anyString(), anyString())).thenReturn(true);
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        when(placements.findClaimCandidates(anyInt())).thenReturn(List.of());
        var first = work.poll("test-token", new HarnessWorkPoll.Poll("pod-b", "boot-a", DIGEST, FEATURES, 1, 20_000));
        var second = work.poll("test-token", poll(1, 20_000));

        assertThat(first).isNotDone();
        assertThat(second).isNotDone();
    }

    private static HarnessWorkPoll.Poll poll(int freeSlots, long waitMillis) {
        return new HarnessWorkPoll.Poll("pod-b", "boot-b", DIGEST, FEATURES, freeSlots, waitMillis);
    }

    private static Placement candidate(String session, long epoch) {
        return new Placement("t", session, "ws", "pod-a", "boot-a", epoch, "RELEASED");
    }

    private static Claim claim(String session, long epoch) {
        return new Claim(new Placement("t", session, "ws", "pod-b", "boot-b", epoch, "ACTIVE"), 99);
    }
}
