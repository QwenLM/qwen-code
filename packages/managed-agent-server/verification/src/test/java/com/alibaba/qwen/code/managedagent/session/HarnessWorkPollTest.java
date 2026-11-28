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
import java.util.concurrent.TimeUnit;

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
        when(placements.findReservedClaims("pod-b", "boot-b", 3)).thenReturn(List.of(held));
        when(placements.findClaimCandidates(2)).thenReturn(List.of(live, released));
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
    void aNonMemberOrAPollerWithoutAFreeSlotClaimsNothing() throws Exception {
        when(harness.acceptsWorkPullClaims("pod-b", "boot-b")).thenReturn(false);
        assertThat(work.poll("test-token", poll(1, 0)).get(5, TimeUnit.SECONDS).claims()).isEmpty();
        when(harness.acceptsWorkPullClaims("pod-b", "boot-b")).thenReturn(true);
        assertThat(work.poll("test-token", poll(0, 0)).get(5, TimeUnit.SECONDS).claims()).isEmpty();
        verifyNoInteractions(placements);
    }

    @Test
    void demandOnThisInstanceWakesAWaitingPoll() throws Exception {
        var woken = candidate("woken", 2);
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        when(placements.findClaimCandidates(1)).thenReturn(List.of()).thenReturn(List.of(woken));
        when(placements.claim("t", "woken", woken, "pod-b", "boot-b")).thenReturn(claim("woken", 3));
        when(harness.claimLoad(any(), any(), any())).thenReturn(Map.of());

        var pending = work.poll("test-token", poll(1, 20_000));
        verify(placements, timeout(1_000)).findClaimCandidates(1);
        demand.run();

        assertThat(pending.get(400, TimeUnit.MILLISECONDS).claims())
                .extracting(HarnessWorkPoll.ClaimOffer::sessionId).containsExactly("woken");
    }

    @Test
    void aSessionWhoseLoadCannotBeBuiltIsNeverClaimed() throws Exception {
        var released = candidate("released", 2);
        when(placements.findReservedClaims(anyString(), anyString(), anyInt())).thenReturn(List.of());
        when(placements.findClaimCandidates(1)).thenReturn(List.of(released));
        when(harness.claimLoad(any(), any(), any())).thenThrow(new IllegalStateException("not loadable"));

        assertThat(work.poll("test-token", poll(1, 0)).get(5, TimeUnit.SECONDS).claims()).isEmpty();
        verify(harness).claimLoad("t", "released",
                new Placement("t", "released", "ws", "pod-b", "boot-b", 3, "ACTIVE"));
        verify(placements, never()).claim(any(), any(), any(), any(), any());
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
