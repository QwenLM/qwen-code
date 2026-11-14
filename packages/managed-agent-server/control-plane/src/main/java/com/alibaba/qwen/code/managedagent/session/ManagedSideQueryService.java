package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SideQueryTarget;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Claim;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Context;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Create;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Page;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Query;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSideQueries;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

@Service
public class ManagedSideQueryService {
    private static final Logger LOG = LoggerFactory.getLogger(ManagedSideQueryService.class);
    private static final long RELEASE_GRACE_MILLIS = 30_000;
    private final ManagedSideQueries queries;
    private final ManagedAgentSettings settings;
    private final HarnessConnector harness;
    private final ExecutorService executor;
    private final Map<String, Execution> executions = new ConcurrentHashMap<>();

    private record Execution(String tenant, String actor, String session, String query,
            SideQueryTarget target, Claim claim, AtomicBoolean submitted, long deadlineAt) {
        Map<String, Object> wireClaim() {
            return Map.of("instanceId", claim.instanceId(), "bootId", claim.bootId(),
                    "generation", claim.generation(), "token", claim.token());
        }
    }

    public ManagedSideQueryService(ManagedSideQueries queries, ManagedAgentSettings settings,
            HarnessConnector harness, @Qualifier("managedAgentExecutor") ExecutorService executor) {
        this.queries = queries;
        this.settings = settings;
        this.harness = harness;
        this.executor = executor;
    }

    private boolean available() {
        return settings.isSideQueriesEnabled() && settings.getSessionStore().isEnabled() && harness.supportsSideQueries();
    }

    public Context context(String tenant, String actor, String session) {
        var context = queries.context(tenant, actor, session);
        boolean generation = context.generationAvailable() && available();
        String reason = context.unavailableReason();
        if (context.generationAvailable() && !generation) {
            reason = settings.isSideQueriesEnabled() ? "harness_unavailable" : "side_queries_disabled";
        }
        return new Context(context.actorScopeKey(), context.contentVersion(), context.completedUserTurnCount(),
                context.mainInputBoundary(), generation && context.automaticEligible(), generation, reason,
                context.latestRecapContentVersion(), context.latestRecapUserTurnCount());
    }

    public Query create(String tenant, String actor, String session, Create request) {
        var admitted = queries.admit(tenant, actor, session, request, available());
        if (admitted.dispatch()) {
            dispatch(tenant, actor, session, admitted.query());
        }
        return queries.get(tenant, actor, session, admitted.query().queryId());
    }

    private void dispatch(String tenant, String actor, String session, Query query) {
        SideQueryTarget target = null;
        Execution execution = null;
        try {
            target = harness.prepareSideQuery();
            Claim claim = queries.claim(tenant, session, query.queryId(), target.instanceId(), target.bootId());
            execution = new Execution(tenant, actor, session, query.queryId(), target, claim, new AtomicBoolean(),
                    query.deadlineAt());
            executions.put(query.queryId(), execution);
            Execution accepted = execution;
            executor.execute(() -> submit(accepted, query.deadlineAt()));
        } catch (RuntimeException refused) {
            if (execution != null) {
                release(execution);
            } else if (target != null) {
                target.close();
            }
            interrupt(tenant, session, query.queryId(), "side_query_dispatch_interrupted");
        }
    }

    private void submit(Execution execution, long deadlineAt) {
        boolean sent = false;
        try {
            String base = settings.getSessionStore().getBaseUrl().replaceAll("/+$", "");
            var frozen = queries.frozen(execution.tenant(), execution.session(), execution.query(), execution.claim());
            var body = Map.<String, Object>of("queryId", execution.query(), "sessionId", execution.session(),
                    "claim", execution.wireClaim(), "deadlineAt", deadlineAt,
                    "modelConfigDigest", frozen.modelConfigDigest(),
                    "store", Map.of("baseUrl", base + "/internal/managed-session-store/v1/sessions/"
                            + execution.session() + "/side-queries/" + execution.query(),
                            "tenantId", execution.tenant(), "token", settings.getHarness().getToken()));
            sent = true;
            var result = execution.target().submit(body);
            if (Boolean.FALSE.equals(result.get("active"))) {
                interrupt(execution.tenant(), execution.session(), execution.query(), "side_query_owner_lost");
                release(execution);
            }
        } catch (RuntimeException uncertain) {
            interrupt(execution.tenant(), execution.session(), execution.query(), "side_query_dispatch_interrupted");
            if (!sent) {
                release(execution);
            }
        } finally {
            execution.submitted().set(true);
        }
    }

    public Query get(String tenant, String actor, String session, String query) {
        return queries.get(tenant, actor, session, query);
    }

    public Page list(String tenant, String actor, String session, String cursor, int limit) {
        return queries.list(tenant, actor, session, cursor, limit);
    }

    public Query cancel(String tenant, String actor, String session, String query) {
        Query cancelled = queries.cancel(tenant, actor, session, query);
        var execution = executions.get(query);
        if (execution != null) {
            try {
                executor.execute(() -> abort(execution));
            } catch (RejectedExecutionException shuttingDown) {
                abort(execution);
            }
        }
        return cancelled;
    }

    private static void abort(Execution execution) {
        try {
            execution.target().cancel(execution.query(), execution.wireClaim());
        } catch (RuntimeException unavailable) {
            // SQL fencing remains authoritative when the process cannot be reached.
        }
    }

    @Scheduled(scheduler = "managedAgentScheduler", fixedDelay = 1000)
    public void reconcile() {
        try {
            queries.reconcileExpired();
        } catch (RuntimeException unavailable) {
            LOG.warn("Side-query expiry reconciliation failed: {}", unavailable.getClass().getSimpleName());
        }
        for (var execution : executions.values()) {
            if (!execution.submitted().get()) {
                continue;
            }
            // Bound retention by the query's own deadline plus a grace window. A
            // harness that dies mid-query makes the status probe throw transport
            // noise forever, so release (idempotent close) must not depend on a
            // successful probe or the pool Member leaks for the control plane's
            // lifetime. SQL expiry reconciliation already interrupts the row past
            // its deadline; this only frees the client-side target and count.
            if (System.currentTimeMillis() > execution.deadlineAt() + RELEASE_GRACE_MILLIS) {
                release(execution);
                continue;
            }
            boolean terminal;
            try {
                terminal = queries.get(execution.tenant(), execution.actor(), execution.session(), execution.query()).terminal();
            } catch (ManagedAgentException revoked) {
                interrupt(execution.tenant(), execution.session(), execution.query(), "side_query_owner_lost");
                terminal = true;
            } catch (RuntimeException unavailable) {
                // A transient read failure (deadlock, lock wait, pool timeout) is
                // not ownership loss; expiry reconciliation remains the backstop.
                LOG.warn("Side-query reconcile read failed for {}: {}", execution.query(),
                        unavailable.getClass().getSimpleName());
                continue;
            }
            if (terminal) {
                abort(execution);
            }
            try {
                var status = execution.target().status(execution.query(), execution.wireClaim());
                if (Boolean.FALSE.equals(status.get("active"))) {
                    if (!terminal) {
                        interrupt(execution.tenant(), execution.session(), execution.query(), "side_query_owner_lost");
                    }
                    release(execution);
                }
            } catch (RuntimeException unavailable) {
                // The connector normalizes genuine loss (unknown generation, 404)
                // to active:false; what escapes is transport noise, not revocation.
                LOG.warn("Side-query status probe failed for {}: {}", execution.query(),
                        unavailable.getClass().getSimpleName());
            }
        }
    }

    private void interrupt(String tenant, String session, String query, String reason) {
        try {
            queries.interrupt(tenant, session, query, reason);
        } catch (ManagedAgentException absent) {
            if (absent.getStatus() != 404) {
                LOG.warn("Side-query fencing failed for {}: {}", query, absent.getCode());
            }
        } catch (RuntimeException unavailable) {
            LOG.warn("Side-query fencing failed for {}: {}", query, unavailable.getClass().getSimpleName());
        }
    }

    private void release(Execution execution) {
        if (executions.remove(execution.query(), execution)) {
            execution.target().close();
        }
    }

    @PreDestroy
    public void close() {
        for (var execution : executions.values()) {
            interrupt(execution.tenant(), execution.session(), execution.query(), "side_query_owner_lost");
            abort(execution);
            release(execution);
        }
    }
}
