package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class MessageMaterializer {
    private static final Logger LOG = LoggerFactory.getLogger(
            MessageMaterializer.class);
    private static final int TARGET_LIMIT = 32;
    private static final int EVENT_LIMIT = 200;
    // Selection gate for failing targets: retry on streaks 1, 2, 4, ...,
    // up to the cap, and once every MAX_BACKOFF_STREAK passes at and past
    // it. A skipped pass rotates the target behind fresher rows only when
    // a row sits behind the selection window — at or below the limit the
    // same rows are selected again whatever their order, so the write would
    // buy nothing — and the catch already rotates after a failed attempt.
    // Only the exponential phase warns with the stack, so a poisoned
    // session can neither starve healthy ones nor warn at 10 Hz forever.
    private static final int MAX_BACKOFF_STREAK = 64;
    private final AgentStateStore store;
    private final Map<String, Integer> failures = new ConcurrentHashMap<>();
    private final Set<String> surfaced = ConcurrentHashMap.newKeySet();

    public MessageMaterializer(AgentStateStore store) {
        this.store = store;
    }

    // Driven by ManagedArtifactConfiguration.messageMaterializerTask on the
    // dedicated single-thread scheduler at
    // ManagedAgentProperties.Events.materializeInterval (bound from
    // application.yml's materialize-interval, 100 ms by default).
    public void materialize() {
        // Saturation means a row sits behind the selection window, so
        // probe one row past the limit rather than inferring it from an
        // exactly-full window.
        List<MaterializationTarget> targets =
                store.findMaterializationTargets(TARGET_LIMIT + 1);
        boolean saturated = targets.size() > TARGET_LIMIT;
        // A session that stopped being a target (caught up or deleted)
        // never fails again; drop its entries so both maps track only live
        // failures. A saturated window is truncated, though, so absence
        // there means "crowded out by the deferral rotation", not "gone" —
        // the streak must survive it (review round 12, R12-1).
        if (!failures.isEmpty() && !saturated) {
            Set<String> live = new HashSet<>();
            for (MaterializationTarget target : targets) {
                live.add(target.tenantId() + ":" + target.sessionId());
            }
            failures.keySet().removeIf(key -> !live.contains(key));
            surfaced.removeIf(key -> !live.contains(key));
        }
        for (MaterializationTarget target
                : targets.subList(0, Math.min(TARGET_LIMIT, targets.size()))) {
            String key = target.tenantId() + ":" + target.sessionId();
            int streak = failures.getOrDefault(key, 0);
            if (streak > 0) {
                boolean due = streak < MAX_BACKOFF_STREAK
                        ? (streak & (streak - 1)) == 0
                        : streak % MAX_BACKOFF_STREAK == 0;
                if (!due) {
                    if (saturated) {
                        deferQuietly(target);
                    }
                    failures.put(key, streak + 1);
                    continue;
                }
            }
            try {
                store.materializeNextBatch(target.tenantId(),
                        target.sessionId(), EVENT_LIMIT);
                failures.remove(key);
                surfaced.remove(key);
            } catch (RuntimeException error) {
                int next = streak + 1;
                failures.put(key, next);
                deferQuietly(target);
                if (streak == MAX_BACKOFF_STREAK && surfaced.add(key)) {
                    // A session that survives the whole exponential phase is
                    // a stuck projection, not a blip: surface it once, then
                    // keep retrying on the capped gate. One line, no stack —
                    // the exponential phase already logged it seven times.
                    LOG.error("Managed Agent session {} projection is stuck"
                                    + " after {} consecutive failures;"
                                    + " retrying on the capped gate",
                            target.sessionId(), next);
                }
                if (streak < MAX_BACKOFF_STREAK) {
                    LOG.warn("Failed to materialize Managed Agent session {}",
                            target.sessionId(), error);
                } else {
                    // Past the cap an attempt fires every half minute; keep
                    // the signal but drop the repetitive stack.
                    LOG.warn("Failed to materialize Managed Agent session {}: {}",
                            target.sessionId(), error.toString());
                }
            }
        }
    }

    /**
     * One batch for a Session an EventTransport notice named (design
     * 2026-10-04-managed-agent-event-transport, phase MQ2c): the same store
     * call as the scheduled pass, so ordering, the gap guard and the Snapshot
     * discipline are unchanged, and the store's row locks serialize it with
     * the pass. A Session the pass is backing off is left to the pass — a
     * notice never bypasses the backoff, so a poisoned Session cannot warn at
     * the event rate. Returns whether a batch ran.
     */
    public boolean materializeNotified(String tenantId, String sessionId) {
        String key = tenantId + ":" + sessionId;
        if (failures.containsKey(key)) {
            return false;
        }
        try {
            store.materializeNextBatch(tenantId, sessionId, EVENT_LIMIT);
            return true;
        } catch (RuntimeException error) {
            // Hand the Session to the pass's backoff from its first step.
            failures.putIfAbsent(key, 1);
            LOG.warn("Failed to materialize Managed Agent session {}",
                    sessionId, error);
            return false;
        }
    }

    // A store fault while rotating a target must degrade that one target,
    // not abort the pass for every other selected session. The warn never
    // carries the stack: a persistently faulting rotation fires at
    // scheduler rate, and the stack buys nothing per pass.
    private void deferQuietly(MaterializationTarget target) {
        try {
            store.deferMaterializationTarget(target.tenantId(),
                    target.sessionId());
        } catch (RuntimeException deferError) {
            LOG.warn("Failed to defer Managed Agent session {}: {}",
                    target.sessionId(), deferError.toString());
        }
    }
}
