package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessTransportFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessGenerationFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessMutationUnknownFailure;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.repository.HostedCleanupDebtStore;
import com.alibaba.qwen.code.managedagent.repository.HostedCleanupDebtStore.CleanupDebt;
import com.alibaba.qwen.code.managedagent.repository.HostedCleanupDebtStore.ScanPage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;

/**
 * Keeps retrying an owed Hosted cleanup after its Harness generation died.
 *
 * <p>The Harness retries its own release while it is alive; once it crashes,
 * no Turn is left to dispatch, so a completed Turn's debt would otherwise
 * wait for an operator. The scan hands each Session's oldest due debt to the
 * existing cleanup-only load, which pays the original Runtime identity and
 * commits {@code confirmed}. The durable debt row is the only retry state;
 * the in-memory map merely paces attempts within this process.
 *
 * <p>The scan walks the debt projection with an advancing keyset cursor and
 * wraps to the start when a page comes up short, so a prefix of debts that
 * cannot be cleared (an unsupported profile or an unreadable descriptor) never
 * starves the recoverable debts behind it.
 */
@Component
public class HostedCleanupRetryCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(HostedCleanupRetryCoordinator.class);
    private static final int SCAN_LIMIT = 20;
    static final Duration INITIAL_DELAY = Duration.ofSeconds(10);
    static final Duration MAX_DELAY = Duration.ofMinutes(5);
    /** A debt still owed is re-attempted within MAX_DELAY; idle entries older
     *  than twice that belong to debts that have since been confirmed. */
    private static final Duration PRUNE_AFTER = MAX_DELAY.multipliedBy(2);

    private final HostedCleanupDebtStore store;
    private final HarnessConnector harness;
    private final ExecutorService executor;
    private final Clock clock;
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final Map<String, Attempt> attempts = new ConcurrentHashMap<>();
    // The cursor lives on the single fixed-delay scheduler thread; -1/"" is
    // the start of the projection (gmt_create is unsigned, owner_key non-empty).
    private long cursorCreate = -1;
    private String cursorOwnerKey = "";

    private record Attempt(long nextAt, int failures, long lastAt) {
    }

    public HostedCleanupRetryCoordinator(HostedCleanupDebtStore store,
            HarnessConnector harness,
            @Qualifier("managedAgentExecutor") ExecutorService executor,
            @Qualifier("managedAgentClock") Clock clock) {
        this.store = store;
        this.harness = harness;
        this.executor = executor;
        this.clock = clock;
    }

    @Scheduled(scheduler = "managedAgentScheduler", fixedDelayString =
            "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void retryOwedCleanup() {
        if (!harness.isAvailable()) {
            return;
        }
        long now = clock.millis();
        attempts.entrySet().removeIf(
                entry -> now - entry.getValue().lastAt() > PRUNE_AFTER.toMillis());
        ScanPage page = store.findOwed(SCAN_LIMIT, cursorCreate, cursorOwnerKey);
        Set<String> dispatched = new HashSet<>();
        for (CleanupDebt debt : page.debts()) {
            String key = paceKey(debt);
            String sessionKey = debt.tenantId() + "\n" + debt.sessionId();
            if (dispatched.contains(sessionKey)) {
                continue;
            }
            Attempt attempt = attempts.get(key);
            if (attempt != null && attempt.nextAt() > now) {
                continue;
            }
            dispatched.add(sessionKey);
            dispatch(debt);
        }
        if (page.exhausted()) {
            cursorCreate = -1;
            cursorOwnerKey = "";
        } else {
            cursorCreate = page.nextCreate();
            cursorOwnerKey = page.nextOwnerKey();
        }
    }

    private void dispatch(CleanupDebt debt) {
        String key = paceKey(debt);
        if (!active.add(key)) {
            return;
        }
        try {
            executor.execute(() -> {
                try {
                    retry(debt);
                } finally {
                    active.remove(key);
                }
            });
        } catch (RejectedExecutionException closed) {
            active.remove(key);
        }
    }

    private void retry(CleanupDebt debt) {
        try {
            if (harness.recheckRecoveryCleanup(debt.tenantId(), debt.sessionId(),
                    debt.promptId())) {
                // Accepted, not yet confirmed: the projection disappears with
                // the confirmed event. A short pace keeps a slow confirmation
                // from re-loading the Session on every scan tick.
                long now = clock.millis();
                attempts.put(paceKey(debt),
                        new Attempt(now + INITIAL_DELAY.toMillis(), 0, now));
                LOG.info("Hosted cleanup retry accepted tenant={} session={} owner={}",
                        debt.tenantId(), debt.sessionId(), debt.ownerKey());
                return;
            }
            backoff(debt, null);
        } catch (RuntimeException error) {
            if (staleAttachment(error)) {
                // The cached reference names the crashed generation. Dropping
                // it makes the next attempt perform its own cold cleanup load.
                harness.discardManagedRecovery(debt.tenantId(), debt.sessionId());
            }
            backoff(debt, error);
        }
    }

    /**
     * Only an unreachable generation justifies evicting the cached attachment.
     * The whitelist mirrors {@code HarnessPoolConnector.call}'s own
     * reachability classification — transport loss, a moved generation and an
     * unknown mutation outcome — plus a vanished reference (404) and a 5xx
     * that may come from an intermediary in front of a dead daemon. A named
     * refusal is not staleness: {@code HostedHarnessRecoveryDeclinedException},
     * {@code harness_pool_unavailable} and a 4xx all mean the Session is still
     * owned or the load was declined, and evicting would churn a Session whose
     * Turn is still running, so they only back off.
     */
    private static boolean staleAttachment(RuntimeException error) {
        if (error instanceof HarnessTransportFailure
                || error instanceof HarnessGenerationFailure
                || error instanceof HarnessMutationUnknownFailure) {
            return true;
        }
        if (error instanceof HarnessHttpFailure http) {
            int status = http.getStatusCode();
            return status == 404 || status >= 500;
        }
        return false;
    }

    private static String paceKey(CleanupDebt debt) {
        return debt.tenantId() + "\n" + debt.ownerKey();
    }

    private void backoff(CleanupDebt debt, RuntimeException error) {
        Attempt previous = attempts.get(paceKey(debt));
        int failures = Math.min(previous == null ? 1 : previous.failures() + 1, 8);
        // Explicit ladder: 10s, 20s, 40s, 80s, 160s, then the 5-minute cap.
        // The shift doubles until it would exceed the cap, which clamps it.
        long delay = Math.min(MAX_DELAY.toMillis(),
                INITIAL_DELAY.toMillis() << Math.min(failures - 1, 5));
        long now = clock.millis();
        attempts.put(paceKey(debt), new Attempt(now + delay, failures, now));
        if (error == null) {
            LOG.debug("Hosted cleanup retry waits tenant={} session={} owner={}"
                            + " failures={} delayMs={}", debt.tenantId(),
                    debt.sessionId(), debt.ownerKey(), failures, delay);
        } else {
            LOG.warn("Hosted cleanup retry failed tenant={} session={} owner={}"
                            + " failures={} delayMs={} failure={}", debt.tenantId(),
                    debt.sessionId(), debt.ownerKey(), failures, delay,
                    error.getMessage());
        }
    }
}
