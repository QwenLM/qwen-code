package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore.Claim;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore.Placement;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Work pull (P1.1): hands released Sessions to the Harness poller that claims them. */
@Service
@ConditionalOnProperty(prefix = "qwen.managed-agent.harness-pull", name = "enabled", havingValue = "true")
public class HarnessWorkPoll {
    public static final long MAX_WAIT_MILLIS = 20_000;
    private static final long RECHECK_MILLIS = 500;
    private static final int MAX_SLOTS = 100;
    private static final int ATTEMPT_THREADS = 4;
    private static final List<String> REQUIRED_FEATURES =
            List.of("work-pull/1", "harness-pool-owner/1", "harness-instance-lifecycle/1");
    private static final Set<String> SKIPPED_CLAIMS = Set.of("harness_owner_still_live",
            "harness_placement_changed", "harness_placement_not_admitted", "session_not_found");
    private static final Logger LOG = LoggerFactory.getLogger(HarnessWorkPoll.class);

    private final HarnessPlacementStore placements;
    private final HarnessConnector harness;
    private final ManagedAgentSettings settings;
    private final ConcurrentMap<ProcessKey, Waiter> waiters = new ConcurrentHashMap<>();
    private final ConcurrentMap<ProcessKey, Waiter> inFlight = new ConcurrentHashMap<>();
    private final AtomicBoolean wakePending = new AtomicBoolean();
    private final ScheduledExecutorService poller = Executors.newScheduledThreadPool(ATTEMPT_THREADS, runnable -> {
        Thread thread = new Thread(runnable, "managed-harness-work-poll");
        thread.setDaemon(true);
        return thread;
    });

    public record Poll(String instanceId, String bootId, String capabilityDigest, List<String> features,
            int freeSlots, long waitMillis) {
    }

    public record ClaimOffer(String tenantId, String sessionId, long placementEpoch, long reservedUntil,
            Map<String, Object> load) {
    }

    public record Reply(List<ClaimOffer> claims) {
    }

    private record ProcessKey(String instanceId, String bootId) {
    }

    private record Waiter(ProcessKey key, Poll poll, long deadline, CompletableFuture<Reply> reply) {
    }

    public HarnessWorkPoll(HarnessPlacementStore placements, HarnessConnector harness, ManagedAgentSettings settings) {
        this.placements = placements;
        this.harness = harness;
        this.settings = settings;
        harness.onClaimDemand(this::wake);
    }

    @PreDestroy
    void shutdown() {
        poller.shutdownNow();
    }

    /** Answers with claims at once when there are any, otherwise when one appears or the wait elapses. */
    public CompletableFuture<Reply> poll(String token, Poll poll) {
        authenticate(token, poll);
        long wait = Math.min(Math.max(poll.waitMillis(), 0), MAX_WAIT_MILLIS);
        var key = new ProcessKey(poll.instanceId(), poll.bootId());
        var waiter = new Waiter(key, poll, System.currentTimeMillis() + wait, new CompletableFuture<>());
        // One open poll per process: a newer poll supersedes an older one, whose caller has given up,
        // so the same reserved claim is never offered twice and free slots are never counted twice.
        Waiter older = waiters.put(key, waiter);
        if (older != null) {
            older.reply().complete(new Reply(List.of()));
        }
        poller.execute(() -> attempt(waiter));
        return waiter.reply();
    }

    private void authenticate(String token, Poll poll) {
        var expected = settings.getHarness();
        boolean valid = token != null && !expected.getToken().isBlank()
                && MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8),
                        expected.getToken().getBytes(StandardCharsets.UTF_8))
                && expected.getCapabilityDigest().equals(poll.capabilityDigest())
                && poll.features() != null && poll.features().containsAll(REQUIRED_FEATURES)
                && poll.freeSlots() >= 0 && poll.freeSlots() <= MAX_SLOTS;
        try {
            BrokerValues.requireInstanceId(poll.instanceId(), "instanceId");
            BrokerValues.requireShortId(poll.bootId(), "bootId");
        } catch (IllegalArgumentException invalid) {
            valid = false;
        }
        if (!valid) {
            throw new ManagedAgentException(403, "harness_work_poller_refused", "The Harness work poller was refused.");
        }
    }

    private void wake() {
        // One pending sweep at a time; it only adds checks, so each waiter's recheck chain stays single.
        if (wakePending.compareAndSet(false, true)) {
            poller.execute(() -> {
                wakePending.set(false);
                waiters.values().forEach(this::check);
            });
        }
    }

    private void attempt(Waiter waiter) {
        if (!check(waiter)) {
            poller.schedule(() -> attempt(waiter), RECHECK_MILLIS, TimeUnit.MILLISECONDS);
        }
    }

    /** Answers the waiter when it has claims or its wait elapsed; false while it keeps waiting. */
    private boolean check(Waiter waiter) {
        if (waiter.reply().isDone()) {
            waiters.remove(waiter.key(), waiter);
            return true;
        }
        // Worker threads keep unrelated deadlines observable during a blocked store call. This separate
        // ownership map still serializes attempts for a process when supersession replaces its waiter.
        if (inFlight.putIfAbsent(waiter.key(), waiter) != null) {
            return false;
        }
        try {
            if (waiter.reply().isDone() || waiters.get(waiter.key()) != waiter) {
                waiters.remove(waiter.key(), waiter);
                return true;
            }
            List<ClaimOffer> offers;
            try {
                offers = offers(waiter.poll());
            } catch (RuntimeException failure) {
                LOG.warn("work poll attempt failed instance={} failure={}", waiter.poll().instanceId(),
                        failure.getMessage(), failure);
                offers = List.of();
            }
            if (!offers.isEmpty() || System.currentTimeMillis() >= waiter.deadline()) {
                waiters.remove(waiter.key(), waiter);
                waiter.reply().complete(new Reply(offers));
                return true;
            }
            return false;
        } finally {
            inFlight.remove(waiter.key(), waiter);
        }
    }

    private List<ClaimOffer> offers(Poll poll) {
        boolean acceptsNew = harness.acceptsWorkPullClaims(poll.instanceId(), poll.bootId());
        List<ClaimOffer> offers = new ArrayList<>();
        // Re-offering an existing reservation is recovery, not new-work admission:
        // a draining or zero-slot member can receive it, but cannot claim more.
        if (harness.acceptsWorkPullReoffers(poll.instanceId(), poll.bootId())) {
            List<Claim> held = placements.findReservedClaims(poll.instanceId(), poll.bootId(), MAX_SLOTS);
            for (Claim claim : held) {
                Map<String, Object> load = load(claim.placement());
                if (load != null) {
                    offers.add(offer(claim, load));
                }
            }
        }
        int remaining = poll.freeSlots() - offers.size();
        if (!acceptsNew || remaining <= 0) {
            return offers;
        }
        for (Placement candidate : placements.findClaimCandidates(MAX_SLOTS)) {
            if (offers.size() >= poll.freeSlots()) {
                break;
            }
            // The load is built for the placement the claim will create, so a Session that cannot
            // be loaded is never claimed; the takeover always advances the epoch by one.
            Placement next = new Placement(candidate.tenantId(), candidate.sessionId(), candidate.workspaceId(),
                    poll.instanceId(), poll.bootId(), candidate.epoch() + 1, "ACTIVE");
            Map<String, Object> load = load(next);
            if (load == null) {
                continue;
            }
            Claim claim;
            try {
                claim = placements.claim(candidate.tenantId(), candidate.sessionId(), candidate,
                        poll.instanceId(), poll.bootId());
            } catch (ManagedAgentException refused) {
                if (!SKIPPED_CLAIMS.contains(refused.getCode())) {
                    throw refused;
                }
                continue;
            }
            if (!claim.placement().equals(next)) {
                load = load(claim.placement());
            }
            if (load != null) {
                offers.add(offer(claim, load));
            }
        }
        return offers;
    }

    private Map<String, Object> load(Placement placement) {
        try {
            return harness.claimLoad(placement.tenantId(), placement.sessionId(), placement);
        } catch (RuntimeException failure) {
            LOG.warn("work poll could not build a claim load tenant={} session={} failure={}",
                    placement.tenantId(), placement.sessionId(), failure.getMessage(), failure);
            return null;
        }
    }

    private static ClaimOffer offer(Claim claim, Map<String, Object> load) {
        Placement placement = claim.placement();
        return new ClaimOffer(placement.tenantId(), placement.sessionId(), placement.epoch(),
                claim.reservedUntil(), load);
    }
}
