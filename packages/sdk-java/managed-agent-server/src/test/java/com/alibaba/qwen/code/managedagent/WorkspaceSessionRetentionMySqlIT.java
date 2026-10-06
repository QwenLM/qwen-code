package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceSessionRetentionMySqlIT {
    private static final String OWNER = "owner";
    private static final String ACTOR_DIGEST = "a".repeat(64);
    private static final String TOKEN = "mysql-retention-writer-token-00000000";
    private DriverManagerDataSource source;
    private JdbcTemplate jdbc;
    private JdbcTemplate admin;
    private String schema;
    private TransactionTemplate transactions;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setup() {
        String url = required("mysql.url");
        if (!url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = required("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "workspace_retention_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        jdbc = new JdbcTemplate(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
    }

    @AfterEach
    void removeTestSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"UPDATE managed_agent_session SET status = 'CLOSED'", "session.unarchived"})
    void unarchiveRollsBackItsCommandStateAndEvents(String failureSql) {
        var store = store(Clock.systemUTC());
        String tenant = "rollback";
        String session = closed(store, tenant, false);
        transaction(() -> store.beginWorkspaceLifecycle(tenant, session, OperationKind.ARCHIVE,
                OWNER, ACTOR_DIGEST, "archive", "archive-digest", false));
        var fault = faultStore(failureSql);
        assertThatThrownBy(() -> transaction(() -> fault.unarchiveWorkspaceSession(tenant, session,
                OWNER, "scoped-key", "digest"))).isInstanceOf(IllegalStateException.class);
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("ARCHIVED");
        assertThat(count("managed_agent_command", "operation = 'UNARCHIVE_WORKSPACE_SESSION'")).isZero();
        assertThat(count("managed_agent_event", "event_type IN ('session.unarchive.requested', 'session.unarchived')")).isZero();
        assertThat(transaction(() -> store.unarchiveWorkspaceSession(tenant, session, OWNER, "scoped-key", "digest")).replayed()).isFalse();
    }

    @Test
    void simultaneousUnarchiveHasOneCommandAndDigestConflictCannotChangeState() throws Exception {
        var first = store(Clock.systemUTC());
        var second = store(Clock.systemUTC());
        String tenant = "concurrent";
        String session = closed(first, tenant, false);
        transaction(() -> first.beginWorkspaceLifecycle(tenant, session, OperationKind.ARCHIVE,
                OWNER, ACTOR_DIGEST, "archive", "archive-digest", false));
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var one = pool.submit(() -> { start.await(); return transaction(() -> first.unarchiveWorkspaceSession(tenant, session, OWNER, "key", "digest")); });
            var two = pool.submit(() -> { start.await(); return transaction(() -> second.unarchiveWorkspaceSession(tenant, session, OWNER, "key", "digest")); });
            start.countDown();
            assertThat(List.of(one.get(5, TimeUnit.SECONDS).replayed(), two.get(5, TimeUnit.SECONDS).replayed()))
                    .containsExactlyInAnyOrder(false, true);
        }
        assertThat(count("managed_agent_command", "operation = 'UNARCHIVE_WORKSPACE_SESSION'")).isEqualTo(1);
        assertThat(count("managed_agent_event", "event_type = 'session.unarchived'")).isEqualTo(1);
        assertThatThrownBy(() -> transaction(() -> first.unarchiveWorkspaceSession(tenant, session, OWNER, "key", "changed")))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        assertThat(first.requireSession(tenant, session).status()).isEqualTo("CLOSED");
    }

    @ParameterizedTest
    @ValueSource(strings = {"UPDATE qwen_tool_publication SET retention_state", "UPDATE managed_agent_session SET status = 'DELETED'",
            "UPDATE managed_agent_operation SET error_code = NULL, state = 'COMPLETED'", "INSERT INTO managed_agent_event"})
    void deletionRollsBackRetirementTombstoneReceiptAndEvent(String failureSql) {
        var store = store(Clock.systemUTC());
        String tenant = "rollback";
        String session = closed(store, tenant, true);
        publication(tenant, session);
        var claimed = deleteClaim(store, tenant, session);
        var fault = faultStore(failureSql);
        assertThatThrownBy(() -> transaction(() -> fault.completeOperation(tenant, session, claimed.operationId(),
                "delete-worker", claimed.claimGeneration(), false))).isInstanceOf(IllegalStateException.class);
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("DELETING");
        assertThat(store.findOperation(tenant, session, claimed.operationId()).orElseThrow().receiptId()).isNull();
        assertThat(count("qwen_output_session_retirement", "1=1")).isZero();
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_managed_session_journal_head", String.class)).isEqualTo("SEALED");
        assertThat(jdbc.queryForObject("SELECT retention_state FROM qwen_tool_publication", String.class)).isEqualTo("PINNED");
        assertThat(count("managed_agent_event", "event_type = 'session.deleted'")).isZero();
        assertThat(transaction(() -> store.completeOperation(tenant, session, claimed.operationId(),
                "delete-worker", claimed.claimGeneration(), false))).isTrue();
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("DELETED");
        assertThat(count("qwen_output_session_retirement", "1=1")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_managed_session_journal_head", String.class)).isEqualTo("DELETED");
        assertThat(jdbc.queryForObject("SELECT retention_state FROM qwen_tool_publication", String.class)).isEqualTo("RETIRING");
    }

    @Test
    void expiredDeleteClaimAfterLockWaitCannotRetireAndAnotherInstanceCompletes() throws Exception {
        var first = store(Clock.systemUTC());
        var second = store(Clock.systemUTC());
        String tenant = "expired";
        String session = closed(first, tenant, true);
        var claimed = deleteClaim(first, tenant, session);
        var reachedPublicLock = new CountDownLatch(1);
        var completingStore = observingCompletion(reachedPublicLock);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var queued = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<Boolean>>();
            transaction(() -> {
                lock(tenant, session);
                queued.set(pool.submit(() -> {
                    return transaction(() -> completingStore.completeOperation(tenant, session, claimed.operationId(),
                            "delete-worker", claimed.claimGeneration(), false));
                }));
                awaitLatch(reachedPublicLock);
                assertThrows(TimeoutException.class, () -> queued.get().get(100, TimeUnit.MILLISECONDS));
                jdbc.update("UPDATE managed_agent_operation SET lease_until = 0 WHERE operation_id = ?", claimed.operationId());
                return true;
            });
            assertThat(queued.get().get(5, TimeUnit.SECONDS)).isFalse();
        }
        assertThat(count("qwen_output_session_retirement", "1=1")).isZero();
        var takeover = transaction(() -> second.claimOperation(tenant, session, claimed.operationId(), "replacement", Duration.ofMinutes(1))).orElseThrow();
        assertThat(takeover.claimGeneration()).isGreaterThan(claimed.claimGeneration());
        assertThat(transaction(() -> second.completeOperation(tenant, session, claimed.operationId(), "replacement", takeover.claimGeneration(), false))).isTrue();
        assertThat(count("managed_agent_event", "event_type = 'session.deleted'")).isEqualTo(1);
    }

    @Test
    void deletionProtectsNonReadyRecoveryAndDoesNotDependOnAdmissionAcl() {
        var store = store(Clock.systemUTC());
        String tenant = "recovery";
        String session = closed(store, tenant, true);
        publication(tenant, session);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET recovery_status = 'BLOCKED'");
        var claimed = deleteClaim(store, tenant, session);
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE, can_create = FALSE");
        assertThat(transaction(() -> store.completeOperation(tenant, session, claimed.operationId(), "delete-worker", claimed.claimGeneration(), false))).isTrue();
        assertThat(jdbc.queryForObject("SELECT recovery_protected FROM qwen_output_session_retirement", Boolean.class)).isTrue();
        var retention = new ToolPublicationRetentionStore(jdbc, new DataSourceTransactionManager(source));
        assertThat(retention.observe(Duration.ZERO)).singleElement().extracting(ToolPublicationRetentionStore.Candidate::blocker).isEqualTo("recovery_protected");
        assertThatThrownBy(() -> transaction(() -> new ManagedSessionStore(jdbc).acquireWriter(tenant, session, TOKEN,
                new AcquireWriterRequest("workspace", "new-writer", 60_000L))))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("tool_output_session_retired"));
    }

    @Test
    void completedCloseAllowsMetadataAfterFilesConfigurationIsRemoved() {
        var original = store(Clock.systemUTC());
        String tenant = "config-removed";
        String session = closed(original, tenant, false);
        var disabled = new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        assertThat(disabled.workspaceFilesEnabled()).isFalse();
        transaction(() -> disabled.beginWorkspaceLifecycle(tenant, session, OperationKind.ARCHIVE,
                OWNER, ACTOR_DIGEST, "archive", "archive-digest", false));
        assertThat(transaction(() -> disabled.unarchiveWorkspaceSession(tenant, session, OWNER, "unarchive", "digest")).session().status()).isEqualTo("CLOSED");
        var claimed = deleteClaim(disabled, tenant, session);
        assertThat(transaction(() -> disabled.completeOperation(tenant, session, claimed.operationId(), "delete-worker", claimed.claimGeneration(), false))).isTrue();
        assertThat(count("qwen_output_session_retirement", "1=1")).isEqualTo(1);
        assertThat(count("qwen_managed_session_journal_head", "1=1")).isZero();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void retirementSerializesQueuedWriterAndProjectionCompletion(boolean withJournal) throws Exception {
        var store = store(Clock.systemUTC());
        String tenant = "late-write";
        String session = closed(store, tenant, withJournal);
        publication(tenant, session);
        var deletion = deleteClaim(store, tenant, session);
        String digest = "c".repeat(64);
        jdbc.update("INSERT INTO managed_agent_tool_result (result_id, scope_key, execution_key, tenant_id, workspace_id,"
                + " session_id, source_json, source_digest, work_state, claim_generation, claim_until)"
                + " VALUES ('result-1', ?, ?, ?, 'workspace', ?, '{}', ?, 'LEASED', 1, ?)",
                ManagedToolResultStore.identity("s", tenant, session).substring(2), digest, tenant, session,
                digest, System.currentTimeMillis() + 60_000);
        var projection = new ManagedToolResultStore(jdbc, new DataSourceTransactionManager(source), store);
        var claim = new ManagedToolResultStore.Claim(new ManagedToolResultStore.Source("result-1", tenant,
                "workspace", session, "execution", 1, 1, mapper.createObjectNode(), mapper.createObjectNode(),
                mapper.createArrayNode(), digest), 1);
        var result = new ManagedToolResultStore.Projection(mapper.createObjectNode(), "pub-1", mapper.createObjectNode(),
                mapper.createObjectNode(), List.of(), "policy");
        var publicLocked = new CountDownLatch(1);
        var completingPublicLock = new CountDownLatch(1);
        var completingStore = observingCompletion(completingPublicLock);
        var release = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(4)) {
            var holder = pool.submit(() -> transaction(() -> {
                lock(tenant, session);
                publicLocked.countDown();
                awaitLatch(release);
                return true;
            }));
            try {
                awaitLatch(publicLocked);
                var deletionStarted = new CountDownLatch(1);
                var completed = pool.submit(() -> {
                    deletionStarted.countDown();
                    return transaction(() -> completingStore.completeOperation(tenant, session, deletion.operationId(), "delete-worker", deletion.claimGeneration(), false));
                });
                awaitLatch(deletionStarted);
                assertThrows(TimeoutException.class, () -> completed.get(100, TimeUnit.MILLISECONDS));
                awaitLatch(completingPublicLock);
                var writer = pool.submit(() -> {
                    try {
                        return transaction(() -> new ManagedSessionStore(jdbc).acquireWriter(tenant, session, TOKEN,
                                new AcquireWriterRequest("workspace", "late", 60_000L)));
                    } catch (ApiException rejected) { return rejected; }
                });
                var projected = pool.submit(() -> projection.complete(claim, result, "policy"));
                assertThrows(TimeoutException.class, () -> writer.get(100, TimeUnit.MILLISECONDS));
                assertThrows(TimeoutException.class, () -> projected.get(100, TimeUnit.MILLISECONDS));
                release.countDown();
                assertThat(holder.get(5, TimeUnit.SECONDS)).isTrue();
                assertThat(completed.get(5, TimeUnit.SECONDS)).isTrue();
                assertThat(writer.get(5, TimeUnit.SECONDS)).isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("tool_output_session_retired"));
                assertThat(projected.get(5, TimeUnit.SECONDS)).isFalse();
            } finally { release.countDown(); }
        }
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result", String.class)).isEqualTo("SUPPRESSED");
        assertThat(count("managed_agent_event", "event_type = 'tool.result'")).isZero();
        assertThat(count("managed_agent_artifact", "1=1")).isZero();
    }

    @Test
    void retirementWaitsForWriterRenewalAndRefusesAResidualLiveWriter() throws Exception {
        var store = store(Clock.systemUTC());
        String tenant = "renewal";
        String session = closed(store, tenant, true);
        // Restore a residual private writer to exercise the retirement safety check.
        jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'ACTIVE',"
                + " writer_lease_until = TIMESTAMPADD(SECOND, 60, CURRENT_TIMESTAMP(6))");
        var deletion = deleteClaim(store, tenant, session);
        var sessions = new ManagedSessionStore(jdbc);
        var renewed = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var renewal = pool.submit(() -> transaction(() -> {
                sessions.renewWriter(tenant, session, TOKEN, new RenewWriterRequest("workspace", "writer", 1, 60_000L));
                renewed.countDown();
                awaitLatch(release);
                return true;
            }));
            try {
                awaitLatch(renewed);
                var completed = pool.submit(() -> {
                    try {
                        return transaction(() -> store.completeOperation(tenant, session, deletion.operationId(), "delete-worker", deletion.claimGeneration(), false));
                    } catch (ApiException rejected) { return rejected; }
                });
                assertThrows(TimeoutException.class, () -> completed.get(100, TimeUnit.MILLISECONDS));
                release.countDown();
                assertThat(renewal.get(5, TimeUnit.SECONDS)).isTrue();
                assertThat(completed.get(5, TimeUnit.SECONDS)).isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("managed_session_writer_active"));
            } finally { release.countDown(); }
        }
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("DELETING");
        assertThat(count("qwen_output_session_retirement", "1=1")).isZero();
        transaction(() -> sessions.sealWriter(tenant, session, TOKEN, new SealWriterRequest("workspace", "writer", 1)));
        assertThat(transaction(() -> store.completeOperation(tenant, session, deletion.operationId(), "delete-worker", deletion.claimGeneration(), false))).isTrue();
    }

    private static void awaitLatch(CountDownLatch latch) {
        try { assertThat(latch.await(5, TimeUnit.SECONDS)).isTrue(); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
    }

    @Test
    void prerequisiteMigrationsPreserveExistingCloseEvidenceAndAllowRetirement() {
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("31").load().migrate();
        String tenant = "upgrade";
        String session = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        // Seed the historical schema without running current admission code against it.
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                + " VALUES (?, 'workspace', ?, TRUE, TRUE)", tenant, OWNER.getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO managed_agent_session (tenant_id, session_id, agent_id, status, created_at, updated_at,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref, version)"
                + " VALUES (?, ?, 'qwen-code', 'CLOSED', ?, ?, 'workspace', 1, 'storage', '.', ?, 1, ?, ?, 2)",
                tenant, session, now, now, "sha256:" + java.util.HexFormat.of().formatHex(sha256(
                        WorkspaceExecutionProfile.CONFIG_REF + "\u0000" + WorkspaceExecutionProfile.POLICY_REF)),
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_session_create_scope (tenant_id, idempotency_key, workspace_bound)"
                + " VALUES (?, 'create', TRUE)", tenant);
        jdbc.update("INSERT INTO managed_workspace_create_command (tenant_id, actor_id, idempotency_key, request_digest,"
                + " session_id, created_at) VALUES (?, ?, 'create', 'create-digest', ?, ?)",
                tenant, OWNER.getBytes(StandardCharsets.UTF_8), session, now);
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id, session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state, admission_stage, delivery_state, session_status_before, receipt_id,"
                + " claim_generation, available_at, created_at, updated_at, completed_at)"
                + " VALUES (?, ?, 'legacy-close', 'CLOSE', ?, 'close', 'close-digest', 'COMPLETED', 'HARNESS_CONFIRMED',"
                + " 'CONFIRMED', 'ACTIVE', 'legacy-close-receipt', 1, ?, ?, ?, ?)", tenant, session, ACTOR_DIGEST, now, now, now, now);
        var originalSession = jdbc.queryForMap("SELECT * FROM managed_agent_session");
        var originalClose = jdbc.queryForMap("SELECT * FROM managed_agent_operation");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?"
                + " AND table_name = 'qwen_runtime_storage_fence'", Integer.class, schema)).isZero();

        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        assertThat(jdbc.queryForMap("SELECT * FROM managed_agent_session")).containsAllEntriesOf(originalSession);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_agent_operation"))
                .containsAllEntriesOf(originalClose)
                .hasSize(originalClose.size() + 3)
                .containsEntry("target_cwd_relative", null)
                .containsEntry("expected_context_revision", null)
                .containsEntry("result_context_revision", null);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
        assertThat(store.hasCompletedWorkspaceClose(tenant, session)).isTrue();
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED");
        assertThat(store.requireSession(tenant, session).toolProfile()).isEqualTo("hosted-workspace-files/1");
        assertThat(store.findOperation(tenant, session, "legacy-close").orElseThrow().receiptId()).isEqualTo("legacy-close-receipt");
        var deletion = deleteClaim(store, tenant, session);
        assertThat(transaction(() -> store.completeOperation(tenant, session, deletion.operationId(), "delete-worker", deletion.claimGeneration(), false))).isTrue();
        assertThat(count("qwen_output_session_retirement", "1=1")).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void recoversBlockedClosedDeletionAfterItsBackoff(boolean archived) {
        var store = store(Clock.systemUTC());
        String tenant = "blocked-delete";
        String session = closed(store, tenant, true);
        if (archived) {
            transaction(() -> store.beginWorkspaceLifecycle(tenant, session, OperationKind.ARCHIVE,
                    OWNER, ACTOR_DIGEST, "archive", "archive-digest", false));
        }
        var old = deleteClaim(store, tenant, session);
        transaction(() -> {
            store.blockLifecycleOperation(tenant, session, old.operationId(), "delete-worker", old.claimGeneration(),
                    "workspace_close_identity_unverified", System.currentTimeMillis() + Duration.ofDays(1).toMillis());
            return null;
        });
        assertThat(store.findDeliverableOperations(Long.MAX_VALUE, 100)).isEmpty();
        assertThat(transaction(() -> store.claimOperation(tenant, session, old.operationId(), "replacement", Duration.ofMinutes(1)))).isEmpty();
        jdbc.update("UPDATE managed_agent_operation SET available_at = 0 WHERE operation_id = ?", old.operationId());
        assertThat(store.findDeliverableOperations(0, 100)).extracting(target -> target.operationId()).containsExactly(old.operationId());
        var replacement = transaction(() -> store.claimOperation(tenant, session, old.operationId(), "replacement", Duration.ofMinutes(1))).orElseThrow();
        assertThat(replacement.claimGeneration()).isEqualTo(old.claimGeneration() + 1);
        assertThat(transaction(() -> store.completeOperation(tenant, session, old.operationId(), "delete-worker", old.claimGeneration(), false))).isFalse();
        assertThat(transaction(() -> store.completeOperation(tenant, session, old.operationId(), "replacement", replacement.claimGeneration(), false))).isTrue();
        var completed = store.findOperation(tenant, session, old.operationId()).orElseThrow();
        assertThat(completed.state()).isEqualTo("COMPLETED");
        assertThat(completed.failureCode()).isNull();
        assertThat(completed.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("DELETED");
        assertThat(count("qwen_output_session_retirement", "1=1")).isEqualTo(1);
        assertThat(count("managed_agent_event", "event_type = 'session.deleted'")).isEqualTo(1);
    }

    private String closed(ManagedAgentStore store, String tenant, boolean journal) {
        String session = create(store, tenant);
        if (journal) {
            var sessions = new ManagedSessionStore(jdbc);
            var grant = transaction(() -> sessions.acquireWriter(tenant, session, TOKEN,
                    new AcquireWriterRequest("workspace", "writer", 60_000L)));
            transaction(() -> sessions.sealWriter(tenant, session, TOKEN,
                    new SealWriterRequest("workspace", "writer", grant.writerGeneration())));
        }
        var close = transaction(() -> store.beginWorkspaceClose(tenant, session, OWNER, ACTOR_DIGEST, "close-" + session, "close-digest", true));
        var claim = transaction(() -> store.claimOperation(tenant, session, close.operation().operationId(), "close-worker", Duration.ofMinutes(1))).orElseThrow();
        transaction(() -> store.completeOperation(tenant, session, claim.operationId(), "close-worker", claim.claimGeneration(), true));
        return session;
    }

    private OperationRecord deleteClaim(ManagedAgentStore store, String tenant, String session) {
        var admitted = transaction(() -> store.beginWorkspaceLifecycle(tenant, session, OperationKind.DELETE, OWNER, ACTOR_DIGEST, "delete", "delete-digest", false));
        return transaction(() -> store.claimOperation(tenant, session, admitted.operation().operationId(), "delete-worker", Duration.ofMinutes(1))).orElseThrow();
    }

    private int count(String table, String condition) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE " + condition, Integer.class);
    }

    private ManagedAgentStore observingCompletion(CountDownLatch reachedPublicLock) {
        var observedJdbc = new JdbcTemplate(source) {
            @Override
            public <T> T queryForObject(String sql, org.springframework.jdbc.core.RowMapper<T> mapper, Object... arguments) {
                if (sql.contains("managed_agent_session") && sql.endsWith("FOR UPDATE")) reachedPublicLock.countDown();
                return super.queryForObject(sql, mapper, arguments);
            }
        };
        return new ManagedAgentStore(observedJdbc, mapper, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
    }

    private ManagedAgentStore faultStore(String sqlPrefix) {
        var fault = new JdbcTemplate(source) {
            @Override
            public int update(String sql, Object... arguments) {
                if (sql.startsWith(sqlPrefix) || sqlPrefix.equals("session.unarchived")
                        && sql.startsWith("INSERT INTO managed_agent_event") && sqlPrefix.equals(arguments[5])) {
                    throw new IllegalStateException("Injected transaction failure");
                }
                return super.update(sql, arguments);
            }
        };
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        return new ManagedAgentStore(fault, mapper, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
    }

    private void publication(String tenant, String session) {
        String key = "b".repeat(64);
        jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                + " capture_bytes, producer_bytes, admission_bytes, producer_phase, write_evidence, accepted_complete,"
                + " capture_held_bytes, producer_held_bytes, admission_held_bytes, capture_used_bytes)"
                + " VALUES (?, ?, ?, 'workspace', ?, 'pub-1', ?, 'capture-1', '{}', ?, ?, 'FENCED',"
                + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE, 1000, 1000, 1000, 123)",
                key, java.util.HexFormat.of().formatHex(sha256(tenant)), tenant, session, key, key, key);
    }

    private static byte[] sha256(String value) {
        try { return java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    private ManagedAgentStore store(Clock clock) {
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        return new ManagedAgentStore(jdbc, mapper, clock, ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
    }

    private String create(ManagedAgentStore store, String tenant) {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_registry WHERE tenant_id = ?", Integer.class, tenant) == 0) {
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                    tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES (?, 'workspace', ?, TRUE, TRUE)", tenant, OWNER.getBytes(StandardCharsets.UTF_8));
        }
        return transaction(() -> store.insertWorkspaceSessionCommand(tenant, OWNER, UUID.randomUUID().toString(),
                "create", "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", "."))).sessionId();
    }

    private void lock(String tenant, String session) {
        jdbc.queryForObject("SELECT session_id FROM managed_agent_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                String.class, tenant, session);
    }

    private <T> T transaction(Supplier<T> work) {
        return transactions.execute(ignored -> work.get());
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) throw new IllegalStateException(name + " is required");
        return value;
    }
}
