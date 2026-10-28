package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore.CleanupDebt;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 */
@Component
public class HostedCleanupRetryCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(HostedCleanupRetryCoordinator.class);
    private static final int SCAN_LIMIT = 20;
    static final Duration INITIAL_DELAY = Duration.ofSeconds(10);
    static final Duration MAX_DELAY = Duration.ofMinutes(5);

    private final HostedCleanupDebtStore store;
    private final HarnessConnector harness;
    private final ExecutorService executor;
    private final Clock clock;
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final Map<String, Attempt> attempts = new ConcurrentHashMap<>();

    private record Attempt(long nextAt, int failures) {
    }

    public HostedCleanupRetryCoordinator(HostedCleanupDebtStore store,
            HarnessConnector harness, ExecutorService executor, Clock clock) {
        this.store = store;
        this.harness = harness;
        this.executor = executor;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void retryOwedCleanup() {
        if (!harness.isAvailable()) {
            return;
        }
        long now = clock.millis();
        Set<String> page = new HashSet<>();
        Set<String> dispatched = new HashSet<>();
        for (CleanupDebt debt : store.findOwed(SCAN_LIMIT)) {
            String key = paceKey(debt);
            page.add(key);
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
        attempts.keySet().retainAll(page);
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
                attempts.put(paceKey(debt), new Attempt(
                        clock.millis() + INITIAL_DELAY.toMillis(), 0));
                LOG.info("Hosted cleanup retry accepted tenant={} session={} owner={}",
                        debt.tenantId(), debt.sessionId(), debt.ownerKey());
                return;
            }
            backoff(debt, null);
        } catch (RuntimeException error) {
            // A cached attachment can name the crashed generation. Dropping it
            // makes the next attempt perform its own cold cleanup load.
            harness.discardManagedRecovery(debt.tenantId(), debt.sessionId());
            backoff(debt, error);
        }
    }

    private static String paceKey(CleanupDebt debt) {
        return debt.tenantId() + "\n" + debt.ownerKey();
    }

    private void backoff(CleanupDebt debt, RuntimeException error) {
        Attempt previous = attempts.get(paceKey(debt));
        int failures = Math.min(previous == null ? 1 : previous.failures() + 1, 8);
        long delay = Math.min(MAX_DELAY.toMillis(),
                INITIAL_DELAY.toMillis() << Math.min(failures - 1, 5));
        attempts.put(paceKey(debt), new Attempt(clock.millis() + delay, failures));
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
