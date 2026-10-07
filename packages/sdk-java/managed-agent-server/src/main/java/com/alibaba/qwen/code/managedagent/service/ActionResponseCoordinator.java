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
        try {
            Response response = actions.response(tenant, session, operation);
            if (settled(op, response)) {
                return;
            }
            try {
                harness.resolveAction(tenant, session, response.actionId(), response.body());
            } catch (DaemonHttpException error) {
                if (settled(op, response)) {
                    return;
                }
                if (error.getStatusCode() == 400) {
                    actions.complete(op, owner, "invalid_action_response", null, clock.millis());
                    return;
                }
                throw error;
            }
            if (settled(op, response)) {
                return;
            }
            throw new IllegalStateException("The Action has no committed decision yet");
        } catch (HostedHarnessCapabilityMismatchException error) {
            // A Harness whose capability digest no longer matches will
            // still mismatch on every future negotiation, so returning
            // this command to the outbox would retry it forever. Complete
            // it with the mismatch as the terminal answer — the same
            // terminal path the coordinator takes.
            actions.complete(op, owner, error.getCode(), null,
                    clock.millis());
            LOG.warn("Action response completed terminally operation={}"
                            + " code={}",
                    operation, error.getCode());
            return;
        } catch (RuntimeException error) {
            // A lost answer may follow a committed decision. Inspect the projection
            // again before returning this command to the outbox.
            if (settled(op, actions.response(tenant, session, operation))) {
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
                clock.millis());
        return true;
    }
}
