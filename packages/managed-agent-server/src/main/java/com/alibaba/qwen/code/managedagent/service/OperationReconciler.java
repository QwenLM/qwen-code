package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.EnumMap;
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
 * never reaches this scan.
 */
@Component
public class OperationReconciler {
    private static final Logger LOG = LoggerFactory.getLogger(
            OperationReconciler.class);
    private static final int SCAN_LIMIT = 50;
    /** How often a parked operation reads its evidence again. */
    static final Duration RECHECK = Duration.ofMinutes(5);

    private final AgentStateStore store;
    private final Map<OperationKind, AcceptanceEvidence> evidence;
    private final Clock clock;

    public OperationReconciler(AgentStateStore store,
            List<AcceptanceEvidence> evidence, Clock clock) {
        this.store = store;
        this.evidence = new EnumMap<>(OperationKind.class);
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
            try {
                reconcile(parked);
            } catch (RuntimeException error) {
                // Unreadable evidence must not pin the row at the head of
                // the page: it waits a whole recheck like any unproven one.
                LOG.warn("Parked operation reconciliation failed tenant={}"
                                + " session={} operation={} kind={} failure={}",
                        parked.tenantId(), parked.sessionId(),
                        parked.operationId(), parked.kind(),
                        error.getMessage());
                try {
                    store.settleParkedOperation(parked,
                            AcceptanceVerdict.unknown(), recheckAt());
                } catch (RuntimeException ignored) {
                    // The next scan retries the whole reconciliation.
                }
            }
        }
    }

    private void reconcile(ParkedOperation parked) {
        OperationRecord operation = store.findOperation(parked.tenantId(),
                parked.sessionId(), parked.operationId()).orElse(null);
        // A guard, not an input: the verdict comes from the evidence, and
        // the settle itself applies only to a row that is still parked.
        if (operation == null
                || !"RECOVERY_BLOCKED".equals(operation.state())) {
            return;
        }
        AcceptanceEvidence source = evidence.get(parked.kind());
        AcceptanceVerdict verdict = source == null
                ? AcceptanceVerdict.unknown()
                : source.read(operation);
        store.settleParkedOperation(parked, verdict, recheckAt());
    }

    private long recheckAt() {
        return Math.addExact(clock.millis(), RECHECK.toMillis());
    }
}
