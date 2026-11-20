package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.*;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSideQueries;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;

import static com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.PROCESSING_VERSION;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class ManagedSideQueryServiceTest {
    private final ManagedSideQueries queries = mock(ManagedSideQueries.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final HarnessConnector.SideQueryTarget target = mock(HarnessConnector.SideQueryTarget.class);
    private final ManagedAgentProperties properties = new ManagedAgentProperties();
    private final Create request = new Create("btw", "manual", "question", "key", null, null);
    private final Claim claim = new Claim("instance", "boot", 1, "claim-token");
    private final Prefix prefix = new Prefix(1, 10, "digest", 9, "version", 3, 4);
    private ManagedSideQueryService service;
    private ExecutorService executor;

    @BeforeEach
    void setup() {
        properties.setSideQueriesEnabled(true);
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore().setBaseUrl("http://127.0.0.1:8080");
        properties.getHarness().setToken("harness-token");
        when(harness.supportsSideQueries()).thenReturn(true);
        when(harness.prepareSideQuery()).thenReturn(target);
        when(target.instanceId()).thenReturn("instance");
        when(target.bootId()).thenReturn("boot");
        when(target.submit(any())).thenReturn(Map.of("queryId", "query", "active", true));
        when(queries.claim("tenant", "session", "query", "instance", "boot")).thenReturn(claim);
        when(queries.frozen("tenant", "session", "query", claim)).thenReturn(new FrozenInput(
                "query", "tenant", "session", "workspace", "btw", "question", prefix, List.of(),
                PROCESSING_VERSION, "sha256:" + "a".repeat(64), System.currentTimeMillis() + 300_000, null, null));
        when(queries.get("tenant", "actor", "session", "query")).thenReturn(query("preparing"));
        when(queries.admit(eq("tenant"), eq("actor"), eq("session"), eq(request), anyBoolean()))
                .thenReturn(new Admission(query("preparing"), false, true));
        executor = mock(ExecutorService.class);
        doAnswer(call -> {
            call.getArgument(0, Runnable.class).run();
            return null;
        }).when(executor).execute(any());
        service = new ManagedSideQueryService(queries, properties, harness, executor);
    }

    @Test
    void dispatchUsesClaimScopedInputAndNeverAttachesTheSession() {
        service.create("tenant", "actor", "session", request);
        @SuppressWarnings("unchecked")
        var body = ArgumentCaptor.forClass(Map.class);
        verify(target).submit(body.capture());
        assertThat(body.getValue()).containsEntry("modelConfigDigest", "sha256:" + "a".repeat(64));
        assertThat(((Map<?, ?>) body.getValue().get("store")).get("baseUrl")).isEqualTo(
                "http://127.0.0.1:8080/internal/managed-session-store/v1/sessions/session/side-queries/query");
        verify(harness, never()).createOrLoad(any(), any(), anyBoolean());
        verify(target, never()).close();
    }

    @Test
    void replayNeverRedispatches() {
        when(queries.admit("tenant", "actor", "session", request, true))
                .thenReturn(new Admission(query("running"), true, false));
        service.create("tenant", "actor", "session", request);
        verify(harness, never()).prepareSideQuery();
    }

    @Test
    void uncertainDispatchIsInterruptedAndOnlyObserved() {
        when(target.submit(any())).thenThrow(new IllegalStateException("uncertain"));
        service.create("tenant", "actor", "session", request);
        when(target.status(any(), any())).thenReturn(Map.of("active", false));
        service.reconcile();
        verify(target, times(1)).submit(any());
        verify(queries).interrupt("tenant", "session", "query", "side_query_dispatch_interrupted");
        verify(target).close();
    }

    @Test
    void cancelledProviderRetainsConnectorUntilItActuallySettles() {
        service.create("tenant", "actor", "session", request);
        when(queries.get("tenant", "actor", "session", "query")).thenReturn(query("cancelled"));
        when(target.status(any(), any())).thenReturn(Map.of("active", true), Map.of("active", false));
        service.reconcile();
        verify(target, never()).close();
        service.reconcile();
        verify(target).close();
    }

    @Test
    void disablingAdmissionStillReplaysCompletedResults() {
        properties.setSideQueriesEnabled(false);
        when(queries.admit("tenant", "actor", "session", request, false))
                .thenReturn(new Admission(query("completed"), true, false));
        service.create("tenant", "actor", "session", request);
        verify(queries).admit("tenant", "actor", "session", request, false);
        verify(harness, never()).prepareSideQuery();
    }

    @Test
    void rejectedDispatchReleasesAndRemovesItsExecution() {
        doThrow(new RejectedExecutionException()).when(executor).execute(any());
        service.create("tenant", "actor", "session", request);
        service.close();
        verify(target, times(1)).close();
        verify(target, never()).submit(any());
        verify(target, never()).status(any(), any());
        verify(target, never()).cancel(any(), any());
        verify(queries).interrupt("tenant", "session", "query", "side_query_dispatch_interrupted");
    }

    @Test
    void deletedQueryStillRetainsWorkUntilTheProviderSettles() {
        service.create("tenant", "actor", "session", request);
        when(queries.get("tenant", "actor", "session", "query"))
                .thenThrow(new ManagedAgentException(404, "session_not_found", "Session was deleted"));
        when(queries.interrupt("tenant", "session", "query", "side_query_owner_lost"))
                .thenThrow(new ManagedAgentException(404, "side_query_not_found", "Query was deleted"));
        when(target.status(any(), any())).thenReturn(Map.of("active", true), Map.of("active", false));
        service.reconcile();
        verify(target, never()).close();
        service.reconcile();
        verify(target).close();
        verify(target, times(2)).cancel(any(), any());
    }

    @Test
    void failedExpirySweepDoesNotStopObservingPhysicalWork() {
        service.create("tenant", "actor", "session", request);
        when(queries.reconcileExpired()).thenThrow(new IllegalStateException("database unavailable"));
        when(target.status(any(), any())).thenReturn(Map.of("active", false));
        service.reconcile();
        verify(target).close();
    }

    @Test
    void transientReconcileReadDoesNotInterruptAHealthyQuery() {
        service.create("tenant", "actor", "session", request);
        when(queries.get("tenant", "actor", "session", "query"))
                .thenThrow(new IllegalStateException("deadlock rollback"))
                .thenReturn(query("running"));
        when(target.status(any(), any())).thenReturn(Map.of("active", true));
        service.reconcile();
        service.reconcile();
        verify(queries, never()).interrupt(any(), any(), any(), any());
        verify(target, never()).close();
        verify(target, never()).cancel(any(), any());
    }

    @Test
    void transientStatusProbeDoesNotInterruptAHealthyQuery() {
        service.create("tenant", "actor", "session", request);
        when(queries.get("tenant", "actor", "session", "query")).thenReturn(query("running"));
        when(target.status(any(), any())).thenThrow(new IllegalStateException("connection reset"));
        service.reconcile();
        verify(queries, never()).interrupt(any(), any(), any(), any());
        verify(target, never()).close();
        verify(target, never()).cancel(any(), any());
    }

    private Query query(String state) {
        return new Query("query", "session", "btw", "manual", "question", state, null,
                prefix, 1, "", Map.of(), null, 1, 1, System.currentTimeMillis() + 300_000);
    }
}
