package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * D7-2 of #14122: the one rule for an operation whose command's acceptance
 * is unknown. Such an operation is parked {@code recovery_blocked}; no claim
 * takes it and nothing sends it again. This reconciler alone settles it, and
 * only from its kind's {@link AcceptanceEvidence}: committed evidence
 * completes it, evidence that the command can no longer land fails it with
 * the proven code, and anything else parks it for another
 * {@link #RECHECK}. A lifecycle operation's {@code recovery_blocked} is a
 * different thing, a published wait the lifecycle coordinator re-drives, and
 * never reaches this scan. Session kinds come from one Session-scoped scan; a
 * kind outside any Session, such as an SSH Workspace registration, lists its
 * own parked rows.
 */
@Component
public class OperationReconciler {
    private static final Logger LOG = LoggerFactory.getLogger(
            OperationReconciler.class);
    private static final int SCAN_LIMIT = 50;
    /** How often a parked operation reads its evidence again. */
    static final Duration RECHECK = Duration.ofMinutes(5);

    private final AgentStateStore store;
    private final Map<String, AcceptanceEvidence> evidence;
    private final Clock clock;

    public OperationReconciler(AgentStateStore store,
            List<AcceptanceEvidence> evidence, Clock clock) {
        this.store = store;
        this.evidence = new LinkedHashMap<>();
        for (AcceptanceEvidence source : evidence) {
            if (this.evidence.put(source.kind(), source) != null) {
                throw new IllegalStateException(
                        "Two evidence sources for " + source.kind());
            }
        }
        this.clock = clock;
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void reconcile() {
        for (ParkedOperation parked : store.findParkedOperations(
                SCAN_LIMIT)) {
            reconcile(parked);
        }
        for (AcceptanceEvidence source : evidence.values()) {
            for (ParkedOperation parked : source.parked(SCAN_LIMIT)) {
                reconcile(parked);
            }
        }
    }

    private void reconcile(ParkedOperation parked) {
        AcceptanceEvidence source = evidence.get(parked.kind());
        try {
            AcceptanceVerdict verdict = source == null
                    ? AcceptanceVerdict.unknown()
                    : source.read(parked).orElse(null);
            // Empty is a row that left the parked state since the scan; the
            // settle itself applies only to a row that is still parked.
            if (verdict != null) {
                settle(source, parked, verdict);
            }
        } catch (RuntimeException error) {
            // Unreadable evidence must not pin the row at the head of the
            // page: it waits a whole recheck like any unproven one.
            LOG.warn("Parked operation reconciliation failed tenant={}"
                            + " session={} operation={} kind={} failure={}",
                    parked.tenantId(), parked.sessionId(),
                    parked.operationId(), parked.kind(), error.getMessage());
            try {
                settle(source, parked, AcceptanceVerdict.unknown());
            } catch (RuntimeException ignored) {
                // The next scan retries the whole reconciliation.
            }
        }
    }

    private void settle(AcceptanceEvidence source, ParkedOperation parked,
            AcceptanceVerdict verdict) {
        if (source == null) {
            store.settleParkedOperation(parked, verdict, recheckAt());
        } else {
            source.settle(store, parked, verdict, recheckAt());
        }
    }

    private long recheckAt() {
        return Math.addExact(clock.millis(), RECHECK.toMillis());
    }
}
