package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

class SessionLifecycleCoordinatorTest {
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({
        "hosted-workspace-mcp/1,workspace_close_identity_unverified,true",
        "hosted-workspace-shell/1,workspace_close_identity_unverified,false",
        "hosted-workspace-mcp/1,workspace_close_execution_unsettled,false",
        "hosted-workspace-mcp/1,workspace_lifecycle_claim_fenced,false",
        "hosted-workspace-mcp/1,workspace_lifecycle_authorization_denied,false",
        "hosted-workspace-mcp/1,runtime_admission_closed,false"
    })
    void onlyMcpIdentityFailureCanRecoverOriginalStoppedResources(String profile, String code, boolean recovery) throws Exception {
        var store = Mockito.mock(com.alibaba.qwen.code.managedagent.store.AgentStateStore.class);
        var session = Mockito.mock(StoreModels.SessionRecord.class);
        Mockito.when(session.workspace()).thenReturn(Mockito.mock(com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding.class));
        Mockito.when(session.toolProfile()).thenReturn(profile);
        Mockito.when(store.requireSession("tenant", "session")).thenReturn(session);
        var lifecycle = Mockito.mock(com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.class);
        var operation = new StoreModels.OperationRecord("tenant", "session", "operation", OperationKind.DELETE,
                "digest", "DELIVERING", "ACCEPTED", "DRAINING", "ACTIVE", "receipt", "server", 1, 1, null, 2);
        Mockito.when(lifecycle.recoverEffects(operation)).thenReturn(new ObjectMapper().createObjectNode().put("neverInitialized", false));
        var harness = Mockito.mock(HarnessConnector.class);
        var failure = Mockito.mock(com.alibaba.qwen.code.daemon.DaemonHttpException.class);
        Mockito.when(failure.getErrorCode()).thenReturn(code);
        Mockito.doThrow(failure).when(harness).prepareLifecycleResources(operation);
        var warmer = Mockito.mock(RuntimeWarmer.class);
        Mockito.when(warmer.supportsWorkspaceClose()).thenReturn(true);
        Mockito.when(warmer.supportsWorkspaceClose(session.workspace())).thenReturn(true);
        var authority = com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.authority(operation);
        Mockito.when(warmer.recoverStoppedWorkspaceResources("tenant", "session", authority)).thenReturn(CompletableFuture.completedFuture(null));
        Mockito.when(warmer.closeWorkspace("tenant", "session")).thenReturn(CompletableFuture.completedFuture(null));
        var relay = Mockito.mock(ChildResultRelayStore.class);
        Mockito.when(relay.findLiveScopes("tenant", "session")).thenReturn(List.of());
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(store, Mockito.mock(ManagedSessionStore.class), harness, warmer,
                    relay, new ObjectMapper(), admissions(store, warmer), noTurnCancels(), brokerProvider(null), executor, Clock.systemUTC(), new ManagedAgentProperties());
            coordinator.setWorkspaceLifecycleStore(lifecycle);
            var settle = SessionLifecycleCoordinator.class.getDeclaredMethod("settle", StoreModels.OperationRecord.class,
                    java.util.concurrent.atomic.AtomicBoolean.class);
            settle.setAccessible(true);
            try {
                if (recovery) {
                    assertThat(settle.invoke(coordinator, operation,
                            new java.util.concurrent.atomic.AtomicBoolean())).isEqualTo(true);
                    Mockito.verify(lifecycle).requireSettledExecutions(operation);
                    Mockito.verify(lifecycle).verifyResources(operation);
                    Mockito.verify(lifecycle).verifyOutputContents(operation);
                    Mockito.verify(harness).detachLifecycle(operation);
                } else {
                    var thrown = org.junit.jupiter.api.Assertions.assertThrows(java.lang.reflect.InvocationTargetException.class,
                            () -> settle.invoke(coordinator, operation,
                                    new java.util.concurrent.atomic.AtomicBoolean()));
                    assertThat(thrown.getCause()).isSameAs(failure);
                    Mockito.verify(lifecycle, Mockito.never()).verifyResources(operation);
                }
                Mockito.verify(warmer, Mockito.times(recovery ? 1 : 0)).recoverStoppedWorkspaceResources("tenant", "session", authority);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({"0,true", "0,false", "1,true", "1,false"})
    void settlesOnlyWhenTheSelectedBindingSupportsClose(int protocol, boolean supported) throws Exception {
        var store = Mockito.mock(com.alibaba.qwen.code.managedagent.store.AgentStateStore.class);
        var session = Mockito.mock(StoreModels.SessionRecord.class);
        var workspace = new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                "tenant", "workspace", 1, "storage", ".", "config", 1);
        Mockito.when(session.workspace()).thenReturn(workspace);
        Mockito.when(session.toolProfile()).thenReturn(WorkspaceExecutionProfile.PROFILE);
        Mockito.when(store.requireSession("tenant", "session")).thenReturn(session);
        var warmer = Mockito.mock(RuntimeWarmer.class);
        Mockito.when(warmer.supportsWorkspaceClose()).thenReturn(!supported);
        Mockito.when(warmer.supportsWorkspaceClose(workspace)).thenReturn(supported);
        Mockito.when(warmer.closeWorkspace("tenant", "session")).thenReturn(CompletableFuture.completedFuture(null));
        var operation = new StoreModels.OperationRecord("tenant", "session", "operation", OperationKind.CLOSE,
                "digest", "DELIVERING", "ACCEPTED", "DRAINING", "ACTIVE", "receipt", "server", 1, 1, null, protocol);
        var lifecycle = Mockito.mock(com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.class);
        Mockito.when(lifecycle.recoverEffects(operation)).thenReturn(new ObjectMapper().createObjectNode().put("neverInitialized", true));
        var relay = Mockito.mock(ChildResultRelayStore.class);
        Mockito.when(relay.findLiveScopes("tenant", "session")).thenReturn(List.of());
        var harness = Mockito.mock(HarnessConnector.class);
        Mockito.when(harness.supportsLifecycle(WorkspaceExecutionProfile.PROFILE)).thenReturn(true);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(store, Mockito.mock(ManagedSessionStore.class), harness,
                    warmer, relay, new ObjectMapper(), admissions(store, warmer), noTurnCancels(), brokerProvider(null), executor,
                    Clock.systemUTC(), new ManagedAgentProperties());
            coordinator.setWorkspaceLifecycleStore(lifecycle);
            try {
                assertThat(coordinator.supportsWorkspaceLifecycle(session)).isEqualTo(supported);
                Mockito.when(harness.supportsLifecycle(WorkspaceExecutionProfile.PROFILE)).thenReturn(false);
                assertThat(coordinator.supportsWorkspaceLifecycle(session)).isFalse();
                Mockito.when(harness.supportsLifecycle(WorkspaceExecutionProfile.PROFILE)).thenReturn(true);
                var settle = SessionLifecycleCoordinator.class.getDeclaredMethod("settle", StoreModels.OperationRecord.class,
                        java.util.concurrent.atomic.AtomicBoolean.class);
                settle.setAccessible(true);
                if (supported) {
                    assertThat(settle.invoke(coordinator, operation,
                            new java.util.concurrent.atomic.AtomicBoolean())).isEqualTo(protocol != 0);
                    Mockito.verify(warmer).closeWorkspace("tenant", "session");
                } else {
                    var error = org.junit.jupiter.api.Assertions.assertThrows(java.lang.reflect.InvocationTargetException.class,
                            () -> settle.invoke(coordinator, operation,
                                    new java.util.concurrent.atomic.AtomicBoolean()));
                    if (protocol == 0) {
                        assertThat(error.getCause()).isInstanceOfSatisfying(
                                com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class,
                                failure -> assertThat(failure.getCode()).isEqualTo("workspace_close_identity_unverified"));
                    } else {
                        assertThat(error.getCause()).isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.api.ApiException.class,
                                failure -> assertThat(failure.getCode()).isEqualTo("workspace_close_identity_unverified"));
                    }
                    Mockito.verify(warmer, Mockito.never()).closeWorkspace(Mockito.anyString(), Mockito.anyString());
                }
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    private static ChildLifecycleAdmissions admissions(
            com.alibaba.qwen.code.managedagent.store.AgentStateStore store,
            RuntimeWarmer warmer) {
        return new ChildLifecycleAdmissions(store, new RequestDigests(),
                warmer);
    }

    /** The cascade's child-Turn cancel hook (#13875): these tests never
     * give a child a live Turn, so the hook is never expected to fire. */
    private static ManagedAgentService noTurnCancels() {
        return Mockito.mock(ManagedAgentService.class);
    }

    @Test
    void unsupportedTakeoverKeepsAcceptedCloseBlockedWithAStableFailure() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:close-takeover-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", "owner".getBytes(StandardCharsets.UTF_8));
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        String session = transactions.execute(ignored -> store.insertWorkspaceSessionCommand("tenant", "owner", "create", "digest", "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("workspace", ".")).sessionId());
        String operation = transactions.execute(ignored -> store.beginWorkspaceClose("tenant", session, "owner", "a".repeat(64),
                "close", "digest", true).operation().operationId());
        RuntimeWarmer unsupported = new RuntimeWarmer() {
            public boolean isEnabled() { return false; }
            public CompletionStage<Void> warm(String id) { return CompletableFuture.completedFuture(null); }
            public CompletionStage<Void> drain(String id) { throw new AssertionError("Accepted bound close must keep its original scope"); }
        };
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(store, new ManagedSessionStore(jdbc),
                    new UnavailableHarnessConnector(), unsupported, new ChildResultRelayStore(jdbc),
                    new ObjectMapper(), admissions(store, unsupported), noTurnCancels(), brokerProvider(null), executor,
                    Clock.systemUTC(), properties);
            try {
                coordinator.dispatch("tenant", session, operation);
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(store.findOperation("tenant", session, operation).orElseThrow().state())
                                .isEqualTo("RECOVERY_BLOCKED"));
                assertThat(store.findOperation("tenant", session, operation).orElseThrow().failureCode())
                        .isEqualTo("workspace_close_identity_unverified");
                assertThat(store.requireSession("tenant", session).status()).isEqualTo("CLOSING");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    private static final class World {
        final JdbcTemplate jdbc;
        final ManagedAgentStore store;
        final ChildResultRelayStore relayStore;
        final ManagedAgentProperties properties;
        final String session;
        final String child;
        final String operation;

        World(JdbcTemplate jdbc, ManagedAgentStore store,
                ChildResultRelayStore relayStore,
                ManagedAgentProperties properties, String session,
                String child, String operation) {
            this.jdbc = jdbc;
            this.store = store;
            this.relayStore = relayStore;
            this.properties = properties;
            this.session = session;
            this.child = child;
            this.operation = operation;
        }
    }

    /** A workspace-bound parent with one child Session, close admitted. */
    private static World closingWorld(String suffix) {
        return closingWorldOp(suffix, false);
    }

    /** The same world, but closing under the lifecycle protocol (P1). */
    private static World closingWorldLifecycle(String suffix) {
        return closingWorldOp(suffix, true);
    }

    private static World closingWorldOp(String suffix, boolean protocolOne) {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:close-cascade-" + suffix + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getDispatch().setLeaseDuration(Duration.ofMillis(200));
        properties.getDispatch().setRetryInitialDelay(Duration.ofMillis(50));
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES ('tenant', 'workspace', 1, 'storage',"
                        + " 'Workspace', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')",
                "owner".getBytes(StandardCharsets.UTF_8));
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        String session = transactions.execute(ignored -> store
                .insertWorkspaceSessionCommand("tenant", "owner", "create",
                        "digest", "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("workspace", "."))
                .sessionId());
        // The child lands while the parent is still ACTIVE: the close
        // cascade's lifecycle admission answers from this exact shape.
        String child = transactions.execute(ignored -> store
                .insertChildSessionCommand("tenant", session,
                        "create-run-1", "digest-run-1", "audit", List.of(),
                        null,
                        new StoreModels.SessionLineage(session, session,
                                "run-1", 1))
                .sessionId());
        String operation = transactions.execute(ignored -> protocolOne
                ? store.beginWorkspaceLifecycle("tenant", session,
                        OperationKind.DELETE, "owner", "a".repeat(64),
                        "delete", "digest", true, 1)
                        .operation().operationId()
                : store.beginWorkspaceClose("tenant", session, "owner",
                        "a".repeat(64), "close", "digest", true)
                        .operation().operationId());
        return new World(jdbc, store, new ChildResultRelayStore(jdbc),
                properties, session, child, operation);
    }

    @Test
    void durableChildCloseSurvivesRevocationWithoutGrantingSyntheticHeadersAuthority() {
        World world = closingWorld("revoked-close-");
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(world.jdbc.getDataSource()));
        assertThatThrownBy(() -> transactions.execute(ignored -> world.store.beginWorkspaceLifecycle(
                "tenant", world.child, OperationKind.CLOSE, "child:" + world.session, "actor", "spoof", "digest", true)))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.api.ApiException.class);
        world.jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ?", "tenant");
        var admitted = transactions.execute(ignored -> world.store.beginChildClose("tenant", world.session,
                world.child, "run-1", "actor", "child-close-run-1", "digest", true));
        assertThat(admitted.operation().sessionId()).isEqualTo(world.child);
        assertThat(admitted.operation().state()).isEqualTo("PENDING");
        assertThat(transactions.execute(ignored -> world.store.beginChildClose("tenant", world.session,
                world.child, "run-1", "actor", "child-close-run-1", "digest", true)).replayed()).isTrue();
        assertThatThrownBy(() -> transactions.execute(ignored -> world.store.beginChildClose("tenant", world.session,
                world.child, "wrong-run", "actor", "spoof", "digest", true)))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.api.ApiException.class);
    }

    // #14387: a Turn parked by the recovery-blocked mark is evidence, not
    // live work — the child's close admission must not refuse the Session
    // for it, or the relay's blocked settlement could never land (P1
    // review finding on #14461).
    @Test
    void childCloseAdmitsASessionWhoseOnlyTurnIsRecoveryBlocked() {
        World world = closingWorld("blocked-close-");
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(world.jdbc.getDataSource()));
        var turn = transactions.execute(ignored -> world.store
                .insertTurnCommand("tenant", "SUBMIT_TURN", "blocked-turn",
                        "digest-turn", world.child,
                        List.of(Map.of("type", "text", "text", "work")),
                        "digest-payload"));
        transactions.execute(ignored -> world.store.claimTurn("tenant",
                world.child, turn.turnId(), "owner", Duration.ofMinutes(1)));
        Boolean marked = transactions.execute(ignored -> world.store
                .markTurnRecoveryBlocked("tenant", world.child, turn.turnId(),
                        "owner", AgentStateStore.WORKFLOW_RECOVERY_BLOCKED,
                        "lost generation"));
        assertThat(marked).isTrue();

        var admitted = transactions.execute(ignored -> world.store
                .beginChildClose("tenant", world.session, world.child,
                        "run-1", "actor", "blocked-child-close", "digest",
                        true));

        assertThat(admitted.operation().sessionId()).isEqualTo(world.child);
        assertThat(admitted.operation().state()).isEqualTo("PENDING");
        // The mark still stands — the close exempts the parked Turn from
        // its gate, it never rewrites it.
        assertThat(world.store
                .findTurn("tenant", world.child, turn.turnId()).get()
                .errorCode())
                .isEqualTo(AgentStateStore.WORKFLOW_RECOVERY_BLOCKED);
    }

    private static void liveScope(World world, String resourceBody) {
        jdbcLiveScope(world.jdbc, world.session, resourceBody, "child_agent");
    }

    private static void liveScopeKind(World world, String resourceBody,
            String taskKind) {
        jdbcLiveScope(world.jdbc, world.session, resourceBody, taskKind);
    }

    private static void jdbcLiveScope(JdbcTemplate jdbc, String session,
            String resourceBody, String taskKind) {
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, gmt_create)"
                        + " VALUES (?, ?, 'tenant',"
                        + " 'workspace', ?, 'child_run', 'run-1', 'h', 1,"
                        + " 'res-run-1', '" + taskKind + "', 'running', 'session',"
                        + " 'planned', 1)",
                com.alibaba.qwen.code.managedagent.store.ManagedSessionStore.sessionScopeKey("tenant", session),
                com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.recordKey(session, "child_run", "run-1"), session);
        byte[] bytes = resourceBody.getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource"
                        + " (resource_key, session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, gmt_create)"
                        + " VALUES (?, ?, 'tenant', 'workspace', ?,"
                        + " 'res-run-1', 'managed-input', 1, ?,"
                        + " '" + "b".repeat(64) + "', 'MYSQL_INLINE', ?, 'command', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.managedagent.store.ManagedSessionStore.resourceKey(
                        com.alibaba.qwen.code.managedagent.store.ManagedSessionStore.sessionScopeKey("tenant", session), "res-run-1"),
                com.alibaba.qwen.code.managedagent.store.ManagedSessionStore.sessionScopeKey("tenant", session), session, bytes.length, bytes);
    }

    private String childCloseOperation(World world) {
        return world.jdbc.query("SELECT operation_id FROM"
                        + " ma_operation WHERE tenant_id = X'74656e616e74'"
                        + " AND session_id = ? AND operation_kind = 'CLOSE'",
                (result, row) -> result.getString("operation_id"),
                world.child).stream().findFirst().orElse(null);
    }

    private static final class CascadingHarness implements HarnessConnector {
        final List<Map<String, Object>> operations = new CopyOnWriteArrayList<>();
        final List<String> closed = new CopyOnWriteArrayList<>();
        final AtomicBoolean flap;
        /** What a committed child operation does to the parent's records. */
        volatile java.util.function.Consumer<Map<String, Object>> applied =
                ignored -> {};
        /** Every message operation (H4d-b) on arrival, and a failure to
         * throw after it, for the cascade's message-stop ordering tests. */
        volatile java.util.function.Consumer<Map<String, Object>> messageApplied =
                ignored -> {};
        volatile RuntimeException messageFailure;
        private final boolean available;

        CascadingHarness(boolean available, boolean flap) {
            this.available = available;
            this.flap = new AtomicBoolean(flap);
        }

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public Attachment createOrLoad(String tenantId, String sessionId,
                boolean loadExisting) {
            return new Attachment("boot");
        }

        @Override
        public HarnessConnector.Admission submit(String tenantId,
                String sessionId, String promptId,
                List<Map<String, Object>> input, String payloadDigest) {
            throw new UnsupportedOperationException();
        }

        @Override
        public SourceStream stream(String tenantId, String sessionId,
                long lastEventId, String eventEpoch) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void cancel(String tenantId, String sessionId) {
        }

        @Override
        public void rename(String tenantId, String sessionId, String title) {
        }

        @Override
        public String closeSession(String tenantId, String sessionId) {
            closed.add(sessionId);
            return "boot";
        }

        @Override
        public void runChildOperation(String tenantId, String sessionId,
                Map<String, Object> body) {
            operations.add(Map.copyOf(body));
            if (flap.getAndSet(false)) {
                throw new RuntimeException("journal write flap");
            }
            applied.accept(body);
        }

        @Override
        public Map<String, Object> runMessageOperation(String tenantId,
                String sessionId, Map<String, Object> body) {
            messageApplied.accept(body);
            if (messageFailure != null) {
                throw messageFailure;
            }
            return Map.of();
        }
    }

    @SuppressWarnings("unchecked")
    private static ObjectProvider<RuntimeBrokerService> brokerProvider(
            RuntimeBindingRecord binding) {
        RuntimeBrokerService broker = Mockito.mock(RuntimeBrokerService.class);
        if (binding != null) {
            Mockito.when(broker.findLatestBindingByHarnessSession(
                    Mockito.anyString(), Mockito.anyString()))
                    .thenReturn(binding);
            Mockito.when(broker.findLatestBindingByHarnessSessionAnyState(
                    Mockito.anyString(), Mockito.anyString()))
                    .thenReturn(binding);
        }
        ObjectProvider<RuntimeBrokerService> provider =
                Mockito.mock(ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenAnswer(ignored -> broker);
        return provider;
    }

    private static RuntimeBindingRecord bindingOf(String bindingId,
            long generation) {
        RuntimeBindingRecord binding = Mockito.mock(RuntimeBindingRecord.class);
        Mockito.when(binding.getBindingId()).thenReturn(bindingId);
        Mockito.when(binding.getGeneration()).thenReturn(generation);
        return binding;
    }

    private static RuntimeWarmer warmer(boolean supported,
            boolean closeFails) {
        return new RuntimeWarmer() {
            public boolean isEnabled() { return false; }
            public CompletionStage<Void> warm(String id) {
                return CompletableFuture.completedFuture(null);
            }
            public CompletionStage<Void> drain(String id) {
                return CompletableFuture.completedFuture(null);
            }
            public boolean supportsWorkspaceClose() { return supported; }
            public void requestWorkspaceClose(String tenantId,
                    String sessionId) {
            }
            public CompletionStage<Void> closeWorkspace(String tenantId,
                    String sessionId) {
                return closeFails
                        ? CompletableFuture.failedFuture(
                                new UnsupportedOperationException(
                                        "Workspace close is unavailable"))
                        : CompletableFuture.completedFuture(null);
            }
        };
    }

    private void redispatchUntil(SessionLifecycleCoordinator coordinator,
            World world, String checked) {
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            coordinator.dispatch("tenant", world.session, world.operation);
            return world.store.findOperation("tenant", world.session,
                            world.operation).orElseThrow().state()
                    .equals(checked);
        });
    }

    // A host that cannot close Workspace Sessions answers the child
    // close admission as an ordinary debt, which the delivery taxonomy
    // cannot name: one unclassifiable keep-retrying forever. The relay's
    // split applies at the gate too — no admission is owed there, so
    // the parent close settles into the existing typed blocked code it
    // already uses when there's nothing to cascade.
    @Test
    void aCloseIncapableHostBlocksTheParentCloseWithTheTypedCode() {
        World world = closingWorld("incapable-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(false, false), world.relayStore,
                    new ObjectMapper(), admissions(world.store,
                            warmer(false, false)),
                    noTurnCancels(),
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                // The blocked code is stable even though the state line
                // keeps re-arming — a blocked parent's close is owed and
                // re-delivered by design once `available_at` passes, so
                // `failure_code` is what identifies the typed truth and
                // confirms the gate exists at all.
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(world.store.findOperation("tenant",
                                world.session, world.operation)
                                .orElseThrow().failureCode())
                                .isEqualTo(
                                        "workspace_close_identity_unverified"));
                assertThat(harness.closed).doesNotContain(world.child);
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .doesNotContain("close_scope");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    @Test
    void aFalteringJournalStillClosesTheChildAndReArmsTheClose() {
        World world = closingWorld("debt-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        var harness = new CascadingHarness(true, true);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(null), executor,
                    Clock.systemUTC(), world.properties);
            try {
                // First attempt: the stop write falters, yet the child's own
                // lifecycle close is admitted and delivered; the parent's
                // close is owed, not settled.
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(harness.closed).contains(world.child));
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .contains("cancel");
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .doesNotContain("close_scope");
                assertThat(childCloseOperation(world)).isNotNull();
                assertThat(harness.closed).doesNotContain(world.session);
                assertThat(world.store.findOperation("tenant", world.session,
                        world.operation).orElseThrow().state())
                        .isNotEqualTo("COMPLETED");
                // The re-armed attempt sees the child CLOSED and records
                // the settling revision.
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .containsSequence("cancel", "close_scope");
                assertThat(harness.closed).contains(world.session);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // H4e-b1 (#13745 E3): a team's members are the lead's child_agent runs,
    // so the lead's close cascades over them exactly as over any child; the
    // team's row in the same table is never taken for a child to cascade.
    @Test
    void aLeadCloseCancelsItsMembersAndNotItsTeamRecord() {
        World world = closingWorld("team-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        world.jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " gmt_create)"
                        + " VALUES (?, ?, 'tenant',"
                        + " 'workspace', ?, 'team_state', 'team-1', 'h', 2,"
                        + " 'res-team-1', 1)",
                com.alibaba.qwen.code.managedagent.store.ManagedSessionStore.sessionScopeKey("tenant", world.session),
                com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.recordKey(world.session, "team_state", "team-1"), world.session);
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(null), executor,
                    Clock.systemUTC(), world.properties);
            try {
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .containsSequence("cancel", "close_scope");
                assertThat(harness.operations)
                        .extracting(op -> op.get("childRunId"))
                        .containsOnly("run-1");
                assertThat(harness.closed).contains(world.child, world.session);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // #13753 I2: the cascade asks a worktree child's Workspace to discard
    // and never waits for the discard to run: the row keeps its own
    // retries. A row that already settled, or whose merge already runs,
    // owes nothing; a request that falters re-arms the parent's close.
    @Test
    void theCascadeDiscardsAWorktreeChildsWorkspaceWithoutWaiting() {
        for (String start : List.of("shared", "ready", "merging",
                "faltering", "faltering-closed")) {
            World world = closingWorld("worktree-" + start + "-");
            liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
            if ("faltering-closed".equals(start)) {
                // Nothing else is owed: only the discard holds the close.
                world.jdbc.update("UPDATE ma_session SET status ="
                        + " 'CLOSED' WHERE session_id = ?", world.child);
            }
            var workspaces = new com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore(
                    world.jdbc, new DataSourceTransactionManager(
                            world.jdbc.getDataSource()));
            if (!"shared".equals(start)) {
                workspaces.admit("tenant", world.session, "run-1", world.store
                        .requireSession("tenant", world.session).workspace(), 1L);
            }
            world.jdbc.update("UPDATE ma_workspace SET child_state = ?,"
                    + " finish_request = ? WHERE child_run_id = X'72756e2d31'",
                    start.startsWith("faltering") ? "ready" : start,
                    "merging".equals(start) ? "merge" : null);
            var faltered = new AtomicBoolean(start.startsWith("faltering"));
            var cascadeWorkspaces = Mockito.spy(workspaces);
            Mockito.doAnswer(call -> {
                if (faltered.get()) {
                    throw new IllegalStateException("store down");
                }
                return call.callRealMethod();
            }).when(cascadeWorkspaces).requestFinish(Mockito.anyString(),
                    Mockito.anyString(), Mockito.anyString(), Mockito.anyString(),
                    Mockito.anyLong());
            var harness = new CascadingHarness(true, false);
            // A committed close_scope settles the run, as the parent's
            // record funnel would: the re-armed close no longer finds it.
            harness.applied = body -> {
                if ("close_scope".equals(body.get("kind"))) {
                    world.jdbc.update("UPDATE ma_session_record"
                            + " SET task_state = 'cancelled' WHERE record_id = ?",
                            body.get("childRunId"));
                }
            };
            try (var executor = Executors.newSingleThreadExecutor()) {
                var coordinator = new SessionLifecycleCoordinator(world.store,
                        new ManagedSessionStore(world.jdbc), harness,
                        warmer(true, false), world.relayStore, new ObjectMapper(),
                        admissions(world.store, warmer(true, false)),
                        noTurnCancels(),
                        brokerProvider(null), executor,
                        Clock.systemUTC(), world.properties, cascadeWorkspaces);
                try {
                    if (faltered.get()) {
                        // While the request falters the close stays owed,
                        // even once everything else has settled.
                        await().atMost(Duration.ofSeconds(5)).until(() -> {
                            coordinator.dispatch("tenant", world.session,
                                    world.operation);
                            return "CLOSED".equals(world.store.requireSession(
                                    "tenant", world.child).status());
                        });
                        await().during(Duration.ofSeconds(1))
                                .atMost(Duration.ofSeconds(4)).until(() -> {
                                    coordinator.dispatch("tenant", world.session,
                                            world.operation);
                                    return !"COMPLETED".equals(world.store
                                            .findOperation("tenant", world.session,
                                                    world.operation)
                                            .orElseThrow().state());
                                });
                        assertThat(harness.closed).doesNotContain(world.session);
                        faltered.set(false);
                    }
                    redispatchUntil(coordinator, world, "COMPLETED");
                    if ("shared".equals(start)) {
                        // A run without a row is only looked up.
                        Mockito.verify(cascadeWorkspaces, Mockito.never())
                                .requestFinish(Mockito.anyString(),
                                        Mockito.anyString(), Mockito.anyString(),
                                        Mockito.anyString(), Mockito.anyLong());
                        assertThat(harness.closed).contains(world.session);
                        continue;
                    }
                    var row = workspaces.find("tenant", world.session, "run-1");
                    assertThat(row.finishRequest()).as(start).isEqualTo(
                            "merging".equals(start) ? "merge" : "discard");
                    // Nothing ran here: the child Workspace scan owns it.
                    assertThat(row.state()).as(start).isEqualTo(
                            "merging".equals(start) ? "merging" : "ready");
                    assertThat(harness.closed).as(start).contains(world.session);
                    if (start.startsWith("faltering")) {
                        Mockito.verify(cascadeWorkspaces, Mockito.atLeast(2))
                                .requestFinish(Mockito.anyString(),
                                        Mockito.anyString(), Mockito.anyString(),
                                        Mockito.anyString(), Mockito.anyLong());
                    }
                } finally {
                    coordinator.stopRenewals();
                }
            }
        }
    }

    @Test
    void aChildThatCannotCloseLeavesTheParentCloseReArmed() {
        World world = closingWorld("stuck-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        var harness = new CascadingHarness(false, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, true), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, true)),
                    noTurnCancels(),
                    brokerProvider(null), executor,
                    Clock.systemUTC(), world.properties);
            try {
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                // The child's lifecycle op exists but cannot settle: the
                // parent keeps its debt and no close_scope ever commits.
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(childCloseOperation(world)).isNotNull());
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(world.store.findOperation("tenant",
                                world.child, childCloseOperation(world))
                                .orElseThrow().state())
                                .isNotEqualTo("COMPLETED"));
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(harness.operations)
                                .extracting(op -> op.get("kind"))
                                .contains("cancel"));
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .doesNotContain("close_scope");
                assertThat(harness.closed).isEmpty();
                assertThat(world.store.findOperation("tenant", world.session,
                        world.operation).orElseThrow().state())
                        .isNotEqualTo("COMPLETED");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // The same lineage-only shape with nothing LEFT to replay: no body
    // facts, no ledger key, no physical binding. The only honest verdict
    // of the window is that creation never attached — so the scope
    // settles started: false once, and the parent close completes,
    // never re-armed forever on behalf of empty proof.
    @Test
    void anUnprovableLineageChildSettlesStartedFalseAndLetsTheParentClose() {
        World world = closingWorld("unstart-");
        liveScope(world, "{\"inputRef\":{\"resourceId\":\"res-input\"}}");
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(null), executor,
                    Clock.systemUTC(), world.properties);
            try {
                redispatchUntil(coordinator, world, "COMPLETED");
                var terminals = harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .toList();
                assertThat(terminals).hasSize(1);
                assertThat(terminals.get(0)).containsEntry("started", false);
                // A minted, never-started child dies named: the verdict
                // carries the Session its lineage minted.
                assertThat(terminals.get(0)).containsEntry("childSessionId",
                        world.child);
                assertThat(harness.closed).contains(world.child);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    @Test
    void aChildKnownOnlyToTheRelayLedgerStillCloses() {
        World world = closingWorld("ledger-");
        // The attach revision never landed: the run's own body carries no
        // child Session reference, and only the relay ledger names it.
        liveScope(world, "{\"inputRef\":{\"resourceId\":\"res-input\"}}");
        ChildResultRelayStore.RelayRow claimed = world.relayStore.claim(
                "tenant", world.session, "run-1", "key-run-1", "owner",
                30_000, 100);
        assertThat(claimed).isNotNull();
        world.relayStore.advance(claimed, "owner", "watching", world.child,
                0, null, 30_000, 100);
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(bindingOf("binding-1", 7L)), executor,
                    Clock.systemUTC(), world.properties);
            try {
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Map<String, Object> closeScope = harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .findFirst().orElseThrow();
                assertThat(closeScope).containsEntry("started", true);
                // The settling revision rode a rebuilt record chain:
                // dispatch and attach replayed before cancel and scope.
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .containsSequence("dispatch_started", "attach",
                                "cancel", "close_scope");
                assertThat(harness.operations.stream()
                        .filter(op -> "dispatch_started".equals(
                                op.get("kind"))).findFirst().orElseThrow())
                        .containsEntry("dispatchId", "key-run-1")
                        .containsEntry("runtimeBindingId", "binding-1")
                        .containsEntry("generation", "7");
                assertThat(harness.closed).contains(world.child,
                        world.session);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // The retired-binding window R22 measured: the ledger knows the
    // child (creation key and all), the READY read is empty because the
    // binding has retired, and the child itself has closed. The started
    // call must bind the retired row's own dispatch identity — never
    // wedge the parent behind a repair that reports warmth missing.
    @Test
    void aRetiredBindingStillSettlesTheLedgerKnownChild() {
        World world = closingWorld("retired-");
        liveScope(world, "{\"inputRef\":{\"resourceId\":\"res-input\"}}");
        ChildResultRelayStore.RelayRow claimed = world.relayStore.claim(
                "tenant", world.session, "run-1", "key-run-1", "owner",
                30_000, 100);
        assertThat(claimed).isNotNull();
        world.relayStore.advance(claimed, "owner", "watching", world.child,
                0, null, 30_000, 100);
        world.jdbc.update("UPDATE ma_session SET status ="
                        + " 'CLOSED' WHERE tenant_id = X'74656e616e74'"
                        + " AND session_id = ?",
                world.child);
        RuntimeBrokerService broker = Mockito.mock(
                RuntimeBrokerService.class);
        RuntimeBindingRecord retired = bindingOf("binding-1", 7L);
        Mockito.when(broker.findLatestBindingByHarnessSessionAnyState(
                Mockito.anyString(), Mockito.anyString()))
                .thenReturn(retired);
        ObjectProvider<RuntimeBrokerService> provider =
                Mockito.mock(ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenAnswer(
                ignored -> broker);
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    provider, executor, Clock.systemUTC(),
                    world.properties);
            try {
                redispatchUntil(coordinator, world, "COMPLETED");
                Map<String, Object> closeScope = harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .findFirst().orElseThrow();
                assertThat(closeScope).containsEntry("started", true);
                assertThat(harness.operations.stream()
                        .filter(op -> "dispatch_started".equals(
                                op.get("kind"))).findFirst().orElseThrow())
                        .containsEntry("dispatchId", "key-run-1")
                        .containsEntry("runtimeBindingId", "binding-1")
                        .containsEntry("generation", "7");
                // The child had already closed: no duplicate admission.
                assertThat(harness.closed).doesNotContain(world.child);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // R23: a Turn failed before warm-up or submission is a pre-admission
    // failure — no dispatch ever happened, so no binding is owed. The
    // named never-started settle must not hunt one.
    @Test
    void aPreAdmissionFailureSettlesTheNamedNeverStartedChild() {
        World world = closingWorld("preadmit-");
        liveScope(world, "{\"inputRef\":{\"resourceId\":\"res-input\"}}");
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, completed_at, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', 'FAILED', FALSE, 1, 2, 2, 1)",
                world.child);
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Map<String, Object> closeScope = harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .findFirst().orElseThrow();
                assertThat(closeScope).containsEntry("started", false)
                        .containsEntry("childSessionId", world.child);
                // No repair chain is ever attempted for a binding that
                // never existed.
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .doesNotContain("dispatch_started");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // R22's false-verdict repro in isolation: lineage alone names the
    // child, the binding has retired, and the child's own durable Turn
    // completed. The settling revision must read started: true — the
    // never-started pairing over proven execution would certify a lie.
    @Test
    void aCompletedTurnNeverSettlesTheNeverStartedPairing() {
        World world = closingWorld("turnproof-");
        liveScope(world, "{\"inputRef\":{\"resourceId\":\"res-input\"}}");
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, completed_at, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', 'COMPLETED', TRUE, 1, 2, 2, 1)",
                world.child);
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(bindingOf("binding-1", 7L)), executor,
                    Clock.systemUTC(), world.properties);
            try {
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Map<String, Object> closeScope = harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .findFirst().orElseThrow();
                assertThat(closeScope).containsEntry("started", true);
                assertThat(harness.operations.stream().filter(
                        op -> "close_scope".equals(op.get("kind")))
                        .filter(op -> Boolean.FALSE.equals(
                                op.get("started")))).isEmpty();
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    @Test
    void aRepairJournalRefusalStillClosesTheChildAndSettlesOnRedrive() {
        World world = closingWorld("repair-");
        // The ledger names the child but the first dispatch_started call
        // fails with a plain RuntimeException — the SDK's refusal and
        // transport-ambiguous throws are plain RuntimeExceptions, not
        // IllegalStateException. The physical close must still run, and
        // the unpaid reconstruction must not block the next drive.
        liveScope(world, "{\"inputRef\":{\"resourceId\":\"res-input\"}}");
        ChildResultRelayStore.RelayRow claimed = world.relayStore.claim(
                "tenant", world.session, "run-1", "key-run-1", "owner",
                30_000, 100);
        assertThat(claimed).isNotNull();
        world.relayStore.advance(claimed, "owner", "watching", world.child,
                0, null, 30_000, 100);
        var harness = new CascadingHarness(true, true);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(bindingOf("binding-1", 7L)), executor,
                    Clock.systemUTC(), world.properties);
            try {
                // First attempt: the reconstruction owes, yet the child is
                // admitted and physically closed — the refusal never skips
                // the child's own close.
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(harness.closed).contains(world.child));
                assertThat(childCloseOperation(world)).isNotNull();
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .contains("dispatch_started");
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .doesNotContain("close_scope");
                assertThat(world.store.findOperation("tenant", world.session,
                        world.operation).orElseThrow().state())
                        .isNotEqualTo("COMPLETED");
                // The replayed reconstruction repairs the chain and the
                // settling revision lands on re-drive.
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Map<String, Object> closeScope = harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .findFirst().orElseThrow();
                assertThat(closeScope).containsEntry("started", true);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    @Test
    void aChildKnownOnlyToTheCommittedLineageStillCloses() {
        World world = closingWorld("lineage-");
        // Neither the body nor any ledger row remembers the child: the
        // create answer was lost before the first advance — but the
        // creation pipeline stamped the lineage row at insert time.
        assertThat(world.relayStore.find("tenant", world.session, "run-1"))
                .isNull();
        assertThat(world.relayStore.findLineageChild("tenant", world.session,
                "run-1")).isEqualTo(world.child);
        liveScope(world, "{\"inputRef\":{\"resourceId\":\"res-input\"}}");
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(bindingOf("binding-1", 7L)), executor,
                    Clock.systemUTC(), world.properties);
            try {
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Map<String, Object> closeScope = harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .findFirst().orElseThrow();
                assertThat(closeScope).containsEntry("started", true);
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .containsSequence("dispatch_started", "attach",
                                "cancel", "close_scope");
                assertThat(harness.operations.stream()
                        .filter(op -> "dispatch_started".equals(
                                op.get("kind"))).findFirst().orElseThrow())
                        .containsEntry("dispatchId",
                                ManagedAgentService.childCreationKey(
                                        world.session, "run-1"));
                assertThat(harness.closed).contains(world.child,
                        world.session);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // P1: the cascade's child updates ride the parent's own lifecycle
    // claim — the fence's matching key. An ordinary parent's updates
    // stay exactly plain.
    @Test
    void lifecycleProtocolClaimTagsEveryCascadeOperation() {
        World plainWorld = closingWorld("claim-plain-");
        World lifecycleWorld = closingWorldLifecycle("claim-life-");
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(
                    lifecycleWorld.store,
                    new ManagedSessionStore(lifecycleWorld.jdbc), harness,
                    warmer(true, false), lifecycleWorld.relayStore,
                    new ObjectMapper(), admissions(lifecycleWorld.store,
                            warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(null), executor,
                    Clock.systemUTC(), lifecycleWorld.properties);
            try {
                var ordinaryRecord = plainWorld.store.findOperation(
                        "tenant", plainWorld.session,
                        plainWorld.operation).orElseThrow();
                var plain = new java.util.LinkedHashMap<String, Object>();
                coordinator.runLifecycleChildOperation(ordinaryRecord,
                        plain);
                assertThat(plain).doesNotContainKey("authority");
                var tagged = new java.util.LinkedHashMap<String, Object>();
                var lifecycleRecord = lifecycleWorld.store.findOperation(
                        "tenant", lifecycleWorld.session,
                        lifecycleWorld.operation).orElseThrow();
                coordinator.runLifecycleChildOperation(lifecycleRecord,
                        tagged);
                assertThat(tagged).containsEntry("authority", Map.of(
                        "operationId", lifecycleWorld.operation,
                        "claimGeneration", lifecycleRecord.claimGeneration(),
                        "kind", "delete"));
                assertThat(harness.operations)
                        .extracting(op -> op.get("authority"))
                        .containsExactly(null, Map.of("operationId",
                                lifecycleWorld.operation, "claimGeneration",
                                lifecycleRecord.claimGeneration(), "kind",
                                "delete"));
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // #13803 (K2): the live-scope page returns workflow rows too, and the
    // cascade cancels a workflow child through the same kind-blind funnel
    // verbs — a row is neither invisible to the page nor cancelled through
    // a funnel that cannot reach it.
    @Test
    void theCascadeCancelsAWorkflowChildThroughTheSameFunnel() {
        World world = closingWorld("workflow-");
        liveScopeKind(world, "{\"kind\":\"workflow\",\"childSessionId\":\""
                + world.child + "\"}", "workflow");
        var harness = new CascadingHarness(true, false);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    noTurnCancels(),
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                assertThat(harness.operations)
                        .extracting(op -> op.get("kind"))
                        .containsSequence("cancel", "close_scope");
                assertThat(harness.operations.stream()
                        .filter(op -> "close_scope".equals(op.get("kind")))
                        .findFirst().orElseThrow())
                        .containsEntry("started", true);
                assertThat(harness.closed).contains(world.child,
                        world.session);
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // #13875: the close cascade records each child's stop request but
    // never cancels the child's active Turn, so the child close refuses
    // ("The Session has an active Turn.") and the parent close re-arms
    // until the Turn ends on its own — up to the 30-minute Harness Turn
    // deadline. The cascade must key the child Turn's cancel itself, the
    // same keyed cancel the relay's stop arm uses, so the child close can
    // be admitted and the parent close completes without the wait.
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"ACCEPTED",
            "RUNNING"})
    void theCascadeCancelsTheChildsActiveTurnInsteadOfWaitingForIt(
            String initialTurnStatus) {
        World world = closingWorld("active-turn-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        // The child's live Turn never ends on its own in this world:
        // nothing but a keyed cancel can move it.
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', '" + initialTurnStatus + "', TRUE, 1, 2, 1)",
                world.child);
        var harness = new CascadingHarness(true, false);
        // The keyed cancel's command effect, stood in by the mock: the
        // Turn leaves its live state (ManagedAgentService's own tests
        // cover the real command path).
        ManagedAgentService sessions = Mockito.mock(ManagedAgentService.class);
        Mockito.doAnswer(invocation -> {
            world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLING',"
                            + " version = version + 1"
                            + " WHERE tenant_id = X'74656e616e74'"
                            + " AND session_id = ? AND turn_id = ?",
                    world.child, "turn-1");
            return null;
        }).when(sessions).cancelChildTurn("tenant", world.session,
                world.child, "run-1", "turn-1");
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    sessions,
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                coordinator.dispatch("tenant", world.session,
                        world.operation);
                // The bug: the Turn stays in its live state — the cascade
                // only records the stop request and re-arms the close,
                // waiting for the Turn's natural end. The keyed cancel
                // must move the Turn out of it within the retry cadence.
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return !initialTurnStatus.equals(world.jdbc.queryForObject(
                            "SELECT status FROM ma_turn WHERE tenant_id ="
                                    + " X'74656e616e74' AND session_id = ?"
                                    + " AND turn_id = ?",
                            String.class, world.child, "turn-1"));
                });
                // One more pass with the Turn CANCELLING: the stop request
                // is re-recorded, but the keyed cancel is never re-driven.
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return harness.operations.stream()
                            .filter(op -> "cancel".equals(op.get("kind")))
                            .count() >= 2;
                });
                Mockito.verify(sessions, Mockito.times(1))
                        .cancelChildTurn("tenant", world.session,
                                world.child, "run-1", "turn-1");
                // The Harness settles a cancelled Turn CANCELLED; with the
                // Turn terminal the child close is admitted and the parent
                // close completes without ever waiting the Turn out.
                world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLED',"
                                + " completed_at = 3, version = version + 1"
                                + " WHERE tenant_id = X'74656e616e74'"
                                + " AND session_id = ? AND turn_id = ?",
                        world.child, "turn-1");
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                // One keyed cancel, replayed never: later passes see the
                // Turn CANCELLING/CANCELLED and do not re-drive it.
                Mockito.verify(sessions, Mockito.times(1))
                        .cancelChildTurn("tenant", world.session,
                                world.child, "run-1", "turn-1");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // #13875: a faltered Turn cancel is close debt like any other
    // faltered child verb — the close stays owed and the next pass
    // re-drives the keyed cancel, never settling on suspicion.
    @Test
    void theCascadeRetriesAFalteredChildTurnCancel() {
        World world = closingWorld("cancel-flap-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', 'RUNNING', TRUE, 1, 2, 1)",
                world.child);
        var harness = new CascadingHarness(true, false);
        java.util.concurrent.atomic.AtomicInteger cancels =
                new java.util.concurrent.atomic.AtomicInteger();
        ManagedAgentService sessions = Mockito.mock(ManagedAgentService.class);
        Mockito.doAnswer(invocation -> {
            if (cancels.getAndIncrement() == 0) {
                throw new RuntimeException("cancel flap");
            }
            world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLING',"
                            + " version = version + 1"
                            + " WHERE tenant_id = X'74656e616e74'"
                            + " AND session_id = ? AND turn_id = ?",
                    world.child, "turn-1");
            return null;
        }).when(sessions).cancelChildTurn("tenant", world.session,
                world.child, "run-1", "turn-1");
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    sessions,
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                // The first cancel falters: nothing settles on suspicion —
                // no child close, no parent completion — and the next pass
                // re-drives the keyed cancel.
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return cancels.get() >= 1;
                });
                assertThat(world.store.findOperation("tenant", world.session,
                        world.operation).orElseThrow().state())
                        .isNotEqualTo("COMPLETED");
                assertThat(harness.closed).isEmpty();
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return cancels.get() >= 2;
                });
                world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLED',"
                                + " completed_at = 3, version = version + 1"
                                + " WHERE tenant_id = X'74656e616e74'"
                                + " AND session_id = ? AND turn_id = ?",
                        world.child, "turn-1");
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Mockito.verify(sessions, Mockito.times(2))
                        .cancelChildTurn("tenant", world.session,
                                world.child, "run-1", "turn-1");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // #13875: the Turn cancel's own load can start the child's wake pump
    // on a queued session message, so the message route stops first —
    // the same ordering the relay's stop arm keeps.
    @Test
    void theCascadeStopsTheMessageRouteBeforeCancellingTheTurn() {
        World world = closingWorld("msg-stop-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', 'RUNNING', TRUE, 1, 2, 1)",
                world.child);
        pendingSessionMessage(world);
        var harness = new CascadingHarness(true, false);
        List<String> calls = new CopyOnWriteArrayList<>();
        harness.messageApplied = body -> calls.add("message-stop");
        ManagedAgentService sessions = Mockito.mock(ManagedAgentService.class);
        Mockito.doAnswer(invocation -> {
            calls.add("turn-cancel");
            world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLING',"
                            + " version = version + 1"
                            + " WHERE tenant_id = X'74656e616e74'"
                            + " AND session_id = ? AND turn_id = ?",
                    world.child, "turn-1");
            return null;
        }).when(sessions).cancelChildTurn("tenant", world.session,
                world.child, "run-1", "turn-1");
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    sessions,
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return calls.contains("turn-cancel");
                });
                assertThat(calls).contains("message-stop");
                assertThat(calls.indexOf("turn-cancel"))
                        .isGreaterThan(calls.indexOf("message-stop"));
                world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLED',"
                                + " completed_at = 3, version = version + 1"
                                + " WHERE tenant_id = X'74656e616e74'"
                                + " AND session_id = ? AND turn_id = ?",
                        world.child, "turn-1");
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Mockito.verify(sessions, Mockito.times(1))
                        .cancelChildTurn("tenant", world.session,
                                world.child, "run-1", "turn-1");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // A message stop that falters drives no Turn cancel: the cancel's
    // load must never start the pump with the queued inputs unstopped.
    @Test
    void aFalteredMessageStopDefersTheTurnCancel() {
        World world = closingWorld("msg-flap-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', 'RUNNING', TRUE, 1, 2, 1)",
                world.child);
        pendingSessionMessage(world);
        var harness = new CascadingHarness(true, false);
        harness.messageFailure = new RuntimeException("stop flap");
        List<String> calls = new CopyOnWriteArrayList<>();
        harness.messageApplied = body -> calls.add("message-stop");
        ManagedAgentService sessions = Mockito.mock(ManagedAgentService.class);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    sessions,
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return calls.contains("message-stop");
                });
                Mockito.verify(sessions, Mockito.never())
                        .cancelChildTurn(Mockito.anyString(),
                                Mockito.anyString(), Mockito.anyString(),
                                Mockito.anyString(), Mockito.anyString());
                assertThat(world.store.findOperation("tenant", world.session,
                        world.operation).orElseThrow().state())
                        .isNotEqualTo("COMPLETED");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // The relay's stop arm tolerates a child that waits on its recovery or
    // is already closing; the cascade mirrors exactly those two refusal
    // codes — any other failure defers the Turn cancel, these two do not.
    @Test
    void aToleratedMessageStopRefusalStillCancelsTheTurn() {
        World world = closingWorld("msg-tolerated-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', 'RUNNING', TRUE, 1, 2, 1)",
                world.child);
        pendingSessionMessage(world);
        var harness = new CascadingHarness(true, false);
        var refusal = Mockito.mock(
                com.alibaba.qwen.code.daemon.DaemonHttpException.class);
        Mockito.when(refusal.getErrorCode())
                .thenReturn("hosted_session_closing");
        harness.messageFailure = refusal;
        List<String> calls = new CopyOnWriteArrayList<>();
        harness.messageApplied = body -> calls.add("message-stop");
        ManagedAgentService sessions = Mockito.mock(ManagedAgentService.class);
        Mockito.doAnswer(invocation -> {
            calls.add("turn-cancel");
            world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLING',"
                            + " version = version + 1"
                            + " WHERE tenant_id = X'74656e616e74'"
                            + " AND session_id = ? AND turn_id = ?",
                    world.child, "turn-1");
            return null;
        }).when(sessions).cancelChildTurn("tenant", world.session,
                world.child, "run-1", "turn-1");
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    sessions,
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                // The tolerated refusal is not a stop failure: the stop is
                // re-asked each pass, and the Turn cancel drives on.
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return calls.contains("turn-cancel");
                });
                assertThat(calls).contains("message-stop");
                world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLED',"
                                + " completed_at = 3, version = version + 1"
                                + " WHERE tenant_id = X'74656e616e74'"
                                + " AND session_id = ? AND turn_id = ?",
                        world.child, "turn-1");
                redispatchUntil(coordinator, world, "COMPLETED");
                assertThat(world.store.requireSession("tenant", world.child)
                        .status()).isEqualTo("CLOSED");
                Mockito.verify(sessions, Mockito.times(1))
                        .cancelChildTurn("tenant", world.session,
                                world.child, "run-1", "turn-1");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    // #13875: no durable stop request, no physical cancel — a relay that
    // captured the parent ACTIVE could otherwise read the cancelled Turn
    // as child_failed. The child close attempt itself is never deferred.
    @Test
    void aFalteredStopRequestDefersTheTurnCancelUntilItIsDurable() {
        World world = closingWorld("stop-flap-");
        liveScope(world, "{\"childSessionId\":\"" + world.child + "\"}");
        world.jdbc.update("INSERT INTO ma_turn (tenant_id,"
                        + " session_id, turn_id, prompt_id, input_json,"
                        + " payload_digest, status, submission_attempted,"
                        + " gmt_create, gmt_modified, version)"
                        + " VALUES ('tenant', ?, 'turn-1', 'prompt-1', '[]',"
                        + " 'd', 'RUNNING', TRUE, 1, 2, 1)",
                world.child);
        var harness = new CascadingHarness(true, true);
        List<String> calls = new CopyOnWriteArrayList<>();
        harness.applied = body -> {
            if ("cancel".equals(body.get("kind"))) {
                calls.add("stop-ok");
            }
        };
        ManagedAgentService sessions = Mockito.mock(ManagedAgentService.class);
        Mockito.doAnswer(invocation -> {
            calls.add("turn-cancel");
            world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLING',"
                            + " version = version + 1"
                            + " WHERE tenant_id = X'74656e616e74'"
                            + " AND session_id = ? AND turn_id = ?",
                    world.child, "turn-1");
            return null;
        }).when(sessions).cancelChildTurn("tenant", world.session,
                world.child, "run-1", "turn-1");
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(world.store,
                    new ManagedSessionStore(world.jdbc), harness,
                    warmer(true, false), world.relayStore, new ObjectMapper(),
                    admissions(world.store, warmer(true, false)),
                    sessions,
                    brokerProvider(null), executor, Clock.systemUTC(),
                    world.properties);
            try {
                await().atMost(Duration.ofSeconds(5)).until(() -> {
                    coordinator.dispatch("tenant", world.session,
                            world.operation);
                    return calls.contains("turn-cancel");
                });
                // The harness flap faltered the first stop request: the
                // Turn cancel only followed the first durable one.
                assertThat(calls).contains("stop-ok");
                assertThat(calls.indexOf("turn-cancel"))
                        .isGreaterThan(calls.indexOf("stop-ok"));
                world.jdbc.update("UPDATE ma_turn SET status = 'CANCELLED',"
                                + " completed_at = 3, version = version + 1"
                                + " WHERE tenant_id = X'74656e616e74'"
                                + " AND session_id = ? AND turn_id = ?",
                        world.child, "turn-1");
                redispatchUntil(coordinator, world, "COMPLETED");
                Mockito.verify(sessions, Mockito.times(1))
                        .cancelChildTurn("tenant", world.session,
                                world.child, "run-1", "turn-1");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }

    /** One session_message record (hasSessionMessages) and one accepted,
     * never-settled message input on the child's own journal
     * (journalTurns), for the cascade's message-stop tests (#13875). */
    private static void pendingSessionMessage(World world) {
        world.jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " gmt_create)"
                        + " VALUES (?, ?, 'tenant', 'workspace', ?,"
                        + " 'session_message', 'msg_1:message', 'h', 1,"
                        + " 'res-msg-1', 1)",
                com.alibaba.qwen.code.managedagent.store.ManagedSessionStore.sessionScopeKey("tenant", world.child),
                com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.recordKey(world.child, "session_message", "msg_1:message"),
                world.child);
        byte[] journal = ("{\"subtype\":\"managed_session_event_v1\","
                + "\"managedSession\":{\"kind\":\"input.accepted\","
                + "\"occurredAt\":1,\"payload\":{"
                + "\"turnId\":\"msg_1:message\","
                + "\"source\":\"session_message\"}}}\n")
                .getBytes(StandardCharsets.UTF_8);
        world.jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id,"
                        + " workspace_id, session_id, journal_revision,"
                        + " command_key_hash, transaction_id, operation,"
                        + " command_id, content_digest, first_sequence,"
                        + " last_sequence, event_count, writer_generation,"
                        + " writer_id, writer_token_hash, activation_epoch,"
                        + " record_encoding, record_bytes, byte_length,"
                        + " record_digest, gmt_create) VALUES ('tenant',"
                        + " 'workspace', ?, 1, ?, 'tx', 'op', 'command', ?,"
                        + " 1, 1, 1, 1, 'writer', ?, 1, 'jsonl', ?, ?, ?,"
                        + " 1)",
                world.child, "e".repeat(64), "c".repeat(64), "t".repeat(64),
                journal, journal.length, "d".repeat(64));
    }
}
