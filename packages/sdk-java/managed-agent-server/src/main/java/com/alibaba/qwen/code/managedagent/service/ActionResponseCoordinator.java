package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore.Action;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore.Response;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

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
    private final java.util.concurrent.ScheduledExecutorService renewals =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor(
                    task -> {
                        Thread thread = new Thread(task,
                                "action-response-renewal");
                        thread.setDaemon(true);
                        return thread;
                    });

    @jakarta.annotation.PreDestroy
    void stopRenewals() {
        renewals.shutdownNow();
    }

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
        // resolveAction can outlast the claim's lease — a cold takeover load
        // is allowed far longer than a steady-state call — so the lease is
        // renewed for the attempt's whole duration. Without it the attempt's
        // fenced writes (the answered watermark among them) silently land
        // nowhere once lease_until passes. A failed renewal is safe to
        // ignore: every write below stays fenced on the claim, so a lost
        // lease no-ops the write and the reclaim re-drives the attempt.
        long renewalPeriod = Math.max(1,
                dispatch.getLeaseDuration().toMillis() / 3);
        var renewal = renewals.scheduleWithFixedDelay(() -> {
            try {
                sessions.renewLifecycleOperation(tenant, session, operation,
                        owner, op.claimGeneration(), dispatch.getLeaseDuration());
            } catch (RuntimeException error) {
                LOG.warn("Action response lease renewal failed tenant={}"
                                + " session={} operation={} failure={}",
                        tenant, session, operation, error.getMessage());
            }
        }, renewalPeriod, renewalPeriod,
                java.util.concurrent.TimeUnit.MILLISECONDS);
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
        } catch (HostedHarnessCapabilityMismatchException error) {
            // A Harness whose capability digest no longer matches will
            // still mismatch on every future negotiation, so returning
            // this command to the outbox would retry it forever. Complete
            // it with the mismatch as the terminal answer — the same
            // terminal path the coordinator takes. Not harness_confirmed:
            // a digest mismatch is a refusal to serve, not the Harness
            // acknowledging the response.
            actions.complete(op, owner, error.getCode(), null, false,
                    clock.millis());
            LOG.warn("Action response completed terminally operation={}"
                            + " code={}",
                    operation, error.getCode());
            return;
        } catch (RuntimeException error) {
            // A lost answer may follow a committed decision. Inspect the projection
            // again before returning this command to the outbox.
            Response current = actions.response(tenant, session, operation);
            if (settled(op, current)) {
                return;
            }
            // The answer is durable, not per-attempt: an answered attempt
            // reschedules budget-exempt, and the row's watermark keeps every
            // later attempt of the same answer waiting on the projection
            // rather than the Harness — so a mid-lag failure after an
            // answered attempt never records action_response_delivery_failed
            // for a decision the Harness already committed.
            boolean answered = harnessAnswered || op.budgetExemptAttempt() > 0;
            // That exemption is bounded by the Action's own life. Once it
            // expired while still `requested`, no projection can make this
            // delivery observable any more, so the wait can no longer
            // succeed — and because Java keeps no expiry scanner of its own,
            // nothing else would ever end it: the row would outlive the
            // Action and, through the open-operation barrier, every later
            // lifecycle operation on the Session. The delivery code would be
            // false here (the Harness did answer), so an expired decision
            // records its own. It stays java_durable: with no projection
            // there is nothing the Harness confirmed that Java could certify.
            if (answered && decisionExpired(tenant, session, current.actionId())) {
                LOG.error(
                        "Action response outlived its Action tenant={} session={}"
                                + " operation={} attempts={}",
                        tenant,
                        session,
                        operation,
                        op.attemptCount(),
                        error);
                actions.complete(
                        op,
                        owner,
                        "action_response_decision_expired",
                        null,
                        false,
                        clock.millis());
                return;
            }
            if (!answered
                    && op.attemptCount() - op.budgetExemptAttempt()
                            >= dispatch.getMaxOperationRetries()) {
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
            if (error instanceof RuntimeBrokerException failure
                    && !failure.isRetryable()
                    && "workspace_unavailable".equals(failure.getCode())) {
                // Not harness_confirmed: the Workspace authority refused
                // before the Harness was ever asked.
                actions.complete(op, owner, failure.getCode(), null, false,
                        clock.millis());
                return;
            }
            long delay =
                    HarnessCoordinator.retryDelay(
                            dispatch.getRetryInitialDelay(),
                            dispatch.getRetryMaxDelay(),
                            op.attemptCount());
            if (answered) {
                sessions.retryOperation(
                        tenant,
                        session,
                        operation,
                        owner,
                        op.claimGeneration(),
                        Math.addExact(clock.millis(), delay),
                        true);
            } else {
                sessions.retryOperation(
                        tenant,
                        session,
                        operation,
                        owner,
                        op.claimGeneration(),
                        Math.addExact(clock.millis(), delay));
            }
            LOG.debug(
                    "Action response will retry operation={} failure={}",
                    operation,
                    error.toString());
        } finally {
            renewal.cancel(false);
        }
    }

    // Admission validates expiresAt as a required number greater than
    // createdAt, so a real Action always carries a deadline. One that is
    // absent is therefore not a deadline but a row this code should not
    // judge: absent a positive expiry the wait continues rather than
    // recording a terminal invented from a missing field.
    private boolean decisionExpired(String tenant, String session, String actionId) {
        long expiresAt =
                actions.find(tenant, session, actionId)
                        .map(action -> action.options().path("expiresAt").asLong())
                        .orElse(0L);
        return expiresAt > 0 && clock.millis() >= expiresAt;
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
