package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class SessionLifecycleCoordinatorTest {
    private static ChildLifecycleAdmissions admissions(
            com.alibaba.qwen.code.managedagent.store.AgentStateStore store,
            RuntimeWarmer warmer) {
        return new ChildLifecycleAdmissions(store, new RequestDigests(),
                warmer);
    }

    @Test
    void unsupportedTakeoverKeepsAcceptedCloseBlockedWithAStableFailure() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:close-takeover-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        var jdbc = new JdbcTemplate(source);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                + " VALUES ('tenant', 'workspace', ?, TRUE, TRUE)", "owner".getBytes(StandardCharsets.UTF_8));
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
                    new ObjectMapper(), admissions(store, unsupported), brokerProvider(null), executor,
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
        Flyway.configure().dataSource(source)
                .locations("classpath:db/migration").load().migrate();
        var jdbc = new JdbcTemplate(source);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getDispatch().setLeaseDuration(Duration.ofMillis(200));
        properties.getDispatch().setRetryInitialDelay(Duration.ofMillis(50));
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc), properties);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES ('tenant', 'workspace', 1, 'storage',"
                        + " 'Workspace', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES ('tenant', 'workspace', ?, TRUE, TRUE)",
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

    private static void liveScope(World world, String resourceBody) {
        jdbcLiveScope(world.jdbc, world.session, resourceBody);
    }

    private static void jdbcLiveScope(JdbcTemplate jdbc, String session,
            String resourceBody) {
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, created_at)"
                        + " VALUES ('scope-parent', 'run-1-key', 'tenant',"
                        + " 'workspace', ?, 'child_run', 'run-1', 'h', 1,"
                        + " 'res-run-1', 'child_agent', 'running', 'session',"
                        + " 'planned', 1)",
                session);
        byte[] bytes = resourceBody.getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, created_at)"
                        + " VALUES ('scope-parent', 'tenant', 'workspace', ?,"
                        + " 'res-run-1', 'managed-input', 1, ?,"
                        + " '" + "b".repeat(64) + "', 'MYSQL_INLINE', ?,"
                        + " 'command', 'REFERENCED', CURRENT_TIMESTAMP)",
                session, bytes.length, bytes);
    }

    private String childCloseOperation(World world) {
        return world.jdbc.query("SELECT operation_id FROM"
                        + " managed_agent_operation WHERE tenant_id = 'tenant'"
                        + " AND session_id = ? AND operation_kind = 'CLOSE'",
                (result, row) -> result.getString("operation_id"),
                world.child).stream().findFirst().orElse(null);
    }

    private static final class CascadingHarness implements HarnessConnector {
        final List<Map<String, Object>> operations = new CopyOnWriteArrayList<>();
        final List<String> closed = new CopyOnWriteArrayList<>();
        final AtomicBoolean flap;
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
}

