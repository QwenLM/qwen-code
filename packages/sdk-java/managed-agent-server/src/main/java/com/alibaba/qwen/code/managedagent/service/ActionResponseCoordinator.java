package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore.Action;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore.Response;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;

@Component
public class ActionResponseCoordinator {
    private static final Logger LOG = LoggerFactory.getLogger(ActionResponseCoordinator.class);
    private final AgentStateStore sessions;
    private final ManagedActionStore actions;
    private final HarnessConnector harness;
    private final ExecutorService executor;
    private final Clock clock;
    private final ManagedAgentProperties.Dispatch dispatch;
    private final String owner = UUID.randomUUID().toString();
    private final Set<String> active = ConcurrentHashMap.newKeySet();

    public ActionResponseCoordinator(
            AgentStateStore sessions,
            ManagedActionStore actions,
            HarnessConnector harness,
            ExecutorService executor,
            Clock clock,
            ManagedAgentProperties properties) {
        this.sessions = sessions;
        this.actions = actions;
        this.harness = harness;
        this.executor = executor;
        this.clock = clock;
        this.dispatch = properties.getDispatch();
    }

    public void dispatch(String tenant, String session, String operation) {
        if (!active.add(operation)) {
            return;
        }
        executor.execute(
                () -> {
                    try {
                        deliver(tenant, session, operation);
                    } finally {
                        active.remove(operation);
                    }
                });
    }

    @Scheduled(fixedDelayString = "${qwen.managed-agent.dispatch.scan-delay:1s}")
    public void recover() {
        actions.deliverable(clock.millis())
                .forEach(op -> dispatch(op.tenantId(), op.sessionId(), op.operationId()));
    }

    private void deliver(String tenant, String session, String operation) {
        OperationRecord op =
                sessions.claimOperation(
                                tenant, session, operation, owner, dispatch.getLeaseDuration())
                        .orElse(null);
        if (op == null) {
            return;
        }
        // The budget terminal records "the Harness never answered", so only
        // a genuinely undelivered answer may reach it. Track the answer
        // itself rather than the exception type: a 200 from resolveAction
        // means the decision IS committed (the Harness commits before it
        // answers) and a 400 is its definitive refusal, so any later failure
        // of that attempt — Java's own projection read or completion write —
        // is not a delivery failure; the attempt keeps retrying until the
        // projection heals or the Action's own end state settles it.
        boolean harnessAnswered = false;
        try {
            Response response = actions.response(tenant, session, operation);
            if (settled(op, response)) {
                return;
            }
            try {
                harness.resolveAction(tenant, session, response.actionId(), response.body());
                harnessAnswered = true;
            } catch (DaemonHttpException error) {
                if (settled(op, response)) {
                    return;
                }
                if (error.getStatusCode() == 400) {
                    harnessAnswered = true;
                    actions.complete(op, owner, "invalid_action_response", null, true, clock.millis());
                    return;
                }
                throw error;
            }
            if (settled(op, response)) {
                return;
            }
            throw new DecisionNotYetProjected();
        } catch (RuntimeException error) {
            // A lost answer may follow a committed decision. Inspect the projection
            // again before returning this command to the outbox.
            if (settled(op, actions.response(tenant, session, operation))) {
                return;
            }
            if (op.attemptCount() >= dispatch.getMaxOperationRetries()
                    && !harnessAnswered) {
                LOG.error(
                        "Action response exhausted retries tenant={} session={} operation={} attempts={}",
                        tenant,
                        session,
                        operation,
                        op.attemptCount(),
                        error);
                // The Harness never answered, so the record must not claim
                // a harness_confirmed admission.
                actions.complete(
                        op,
                        owner,
                        "action_response_delivery_failed",
                        null,
                        false,
                        clock.millis());
                return;
            }
            long delay =
                    HarnessCoordinator.retryDelay(
                            dispatch.getRetryInitialDelay(),
                            dispatch.getRetryMaxDelay(),
                            op.attemptCount());
            sessions.retryOperation(
                    tenant,
                    session,
                    operation,
                    owner,
                    op.claimGeneration(),
                    Math.addExact(clock.millis(), delay));
            LOG.debug(
                    "Action response will retry operation={} failure={}",
                    operation,
                    error.toString());
        }
    }

    private boolean settled(OperationRecord op, Response response) {
        Action action =
                actions.find(op.tenantId(), op.sessionId(), response.actionId()).orElseThrow();
        if ("requested".equals(action.state())) {
            return false;
        }
        boolean matched =
                "decided".equals(action.state())
                        && ManagedActionStore.decisionDigest(response.body())
                                .equals(action.decisionDigest());
        actions.complete(
                op,
                owner,
                matched ? null : ManagedActionStore.endedCode(action.state()),
                matched ? action.decisionReceiptId() : null,
                true,
                clock.millis());
        return true;
    }

    // The Harness answered 200, which it only does after committing the
    // decision, but Java's projection does not show it yet. The delivery
    // succeeded; the pending work is the projection's.
    private static final class DecisionNotYetProjected extends IllegalStateException {
        DecisionNotYetProjected() {
            super("The Action has no committed decision yet");
        }
    }
}
