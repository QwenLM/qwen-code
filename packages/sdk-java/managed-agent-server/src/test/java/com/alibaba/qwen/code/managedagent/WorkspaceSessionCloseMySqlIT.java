package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceSessionCloseMySqlIT {
    private static final String OWNER = "owner";
    private static final String ACTOR_DIGEST = "a".repeat(64);
    private static final String TOKEN = "mysql-close-writer-token-00000000";
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
        schema = "workspace_close_" + UUID.randomUUID().toString().replace("-", "");
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

    @Test
    void approvalExpiryUsesDatabaseTimeAndRetainsItsHistory() {
        var store = store(Clock.fixed(Instant.EPOCH, ZoneOffset.UTC));
        var tenant = "mysql-close-expiry-" + UUID.randomUUID();
        var session = create(store, tenant);
        var action = "tool_approval_" + UUID.randomUUID().toString().replace("-", "");
        long now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", java.sql.Timestamp.class).getTime();
        jdbc.update("INSERT INTO managed_agent_action (tenant_id, action_id, session_id, state, options_json, created_at)"
                + " VALUES (?, ?, ?, 'requested', ?, 0)", tenant, action, session,
                "{\"expiresAt\":" + (now + 86_400_000) + "}");
        assertCode(outcome(() -> transaction(() -> store.beginWorkspaceClose(tenant, session, OWNER,
                ACTOR_DIGEST, "close", "digest", true))), "turn_active");
        jdbc.update("UPDATE managed_agent_action SET options_json = ? WHERE tenant_id = ? AND action_id = ?",
                "{\"expiresAt\":1}", tenant, action);
        var admitted = transaction(() -> store.beginWorkspaceClose(tenant, session, OWNER,
                ACTOR_DIGEST, "close", "digest", true));
        assertThat(admitted.operation().state()).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_session WHERE tenant_id = ?"
                + " AND session_id = ?", String.class, tenant, session)).isEqualTo("CLOSING");
        assertThat(jdbc.queryForObject("SELECT state FROM managed_agent_action WHERE tenant_id = ? AND action_id = ?",
                String.class, tenant, action)).isEqualTo("requested");
    }

    @Test
    void closeSerializesNewWriterAndPreservesAnAlreadyAcquiredWriter() throws Exception {
        var first = store(Clock.systemUTC());
        var second = store(Clock.systemUTC());
        var journal = new ManagedSessionStore(jdbc);
        var tenant = "mysql-close-writer-" + UUID.randomUUID();
        var session = create(first, tenant);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var started = new CountDownLatch(1);
            var queued = new java.util.concurrent.atomic.AtomicReference<Future<Object>>();
            transaction(() -> {
                var close = first.beginWorkspaceClose(tenant, session, OWNER, ACTOR_DIGEST, "close", "digest", true);
                queued.set(pool.submit(() -> {
                    started.countDown();
                    return outcome(() -> transaction(() -> journal.acquireWriter(tenant, session, TOKEN,
                            new AcquireWriterRequest("workspace", "late", 60_000L))));
                }));
                awaitBlocked(started, queued.get());
                return close;
            });
            assertCode(queued.get().get(5, TimeUnit.SECONDS), "managed_session_not_writable");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();

        var another = create(first, tenant);
        long generation = transaction(() -> journal.acquireWriter(tenant, another, TOKEN,
                new AcquireWriterRequest("workspace", "original", 60_000L))).writerGeneration();
        transaction(() -> second.beginWorkspaceClose(tenant, another, OWNER, ACTOR_DIGEST, "close", "digest", true));
        assertThat(journal.hasLiveWriter(tenant, another)).isTrue();
        assertThatThrownBy(() -> transaction(() -> journal.acquireWriter(tenant, another, "b".repeat(32),
                new AcquireWriterRequest("workspace", "replacement", 60_000L))))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("managed_session_not_writable"));
        transaction(() -> journal.sealWriter(tenant, another, TOKEN,
                new SealWriterRequest("workspace", "original", generation)));
        assertThat(journal.hasLiveWriter(tenant, another)).isFalse();
    }

    @Test
    void closeCommitsBeforeQueuedTurnAndActionAdmissionsCanInspectTheSession() throws Exception {
        var first = store(Clock.systemUTC());
        var second = store(Clock.systemUTC());
        var actions = new ManagedActionStore(jdbc, second);
        var tenant = "mysql-close-admission-" + UUID.randomUUID();
        var session = create(first, tenant);
        String action = "tool_approval_" + UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state, options_json, created_at)"
                + " VALUES (?, ?, ?, 'cancelled', '{}', 0)", tenant, session, action);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var started = new CountDownLatch(2);
            var turns = new java.util.concurrent.atomic.AtomicReference<Future<Object>>();
            var responses = new java.util.concurrent.atomic.AtomicReference<Future<Object>>();
            transaction(() -> {
                var close = first.beginWorkspaceClose(tenant, session, OWNER, ACTOR_DIGEST, "close", "digest", true);
                turns.set(pool.submit(() -> {
                    started.countDown();
                    return outcome(() -> transaction(() -> second.insertTurnCommand(tenant, "CREATE_TURN", "turn",
                            "turn-digest", session, List.of(), "payload")));
                }));
                responses.set(pool.submit(() -> {
                    started.countDown();
                    return outcome(() -> transaction(() -> actions.admit(tenant, session, OWNER, ACTOR_DIGEST,
                            "answer", "answer-digest", action, mapper.createObjectNode(), System.currentTimeMillis())));
                }));
                awaitBlocked(started, turns.get());
                assertThrows(TimeoutException.class, () -> responses.get().get(100, TimeUnit.MILLISECONDS));
                return close;
            });
            // With Workspace files enabled, a bound Session admits later Turns (#13112), so
            // the queued Turn reaches the Session status and sees the committed close.
            assertCode(turns.get().get(5, TimeUnit.SECONDS), "session_not_active");
            assertCode(responses.get().get(5, TimeUnit.SECONDS), "session_inactive");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_turn WHERE tenant_id = ?", Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_operation WHERE tenant_id = ? AND operation_kind = 'ACTION_RESPONSE'",
                Integer.class, tenant)).isZero();
    }

    @Test
    void expiredCloseClaimCannotRenewOrCompleteAndAnotherInstanceTakesOverUsingDatabaseTime() {
        var first = store(Clock.fixed(Instant.parse("2000-01-01T00:00:00Z"), ZoneOffset.UTC));
        var second = store(Clock.fixed(Instant.parse("2099-01-01T00:00:00Z"), ZoneOffset.UTC));
        var tenant = "mysql-close-claim-" + UUID.randomUUID();
        var session = create(first, tenant);
        OperationAdmission admitted = transaction(() -> first.beginWorkspaceClose(tenant, session, OWNER,
                ACTOR_DIGEST, "close", "digest", true));
        String id = admitted.operation().operationId();
        var claimed = transaction(() -> first.claimOperation(tenant, session, id, "first", Duration.ofMinutes(1))).orElseThrow();
        assertThat(transaction(() -> second.claimOperation(tenant, session, id, "second", Duration.ofMinutes(1)))).isEmpty();
        jdbc.update("UPDATE managed_agent_operation SET lease_until = FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) * 1000) - 1000"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ?", tenant, session, id);
        assertThat(transaction(() -> first.renewLifecycleOperation(tenant, session, id, "first", claimed.claimGeneration(), Duration.ofMinutes(1)))).isFalse();
        assertThat(transaction(() -> first.completeOperation(tenant, session, id, "first", claimed.claimGeneration(), true))).isFalse();
        var takeover = transaction(() -> second.claimOperation(tenant, session, id, "second", Duration.ofMinutes(1))).orElseThrow();
        assertThat(takeover.claimGeneration()).isGreaterThan(claimed.claimGeneration());
        assertThat(transaction(() -> first.completeOperation(tenant, session, id, "first", claimed.claimGeneration(), true))).isFalse();
        assertThat(transaction(() -> second.renewLifecycleOperation(tenant, session, id, "second", takeover.claimGeneration(), Duration.ofMinutes(1)))).isTrue();
        assertThat(transaction(() -> second.completeOperation(tenant, session, id, "second", takeover.claimGeneration(), true))).isTrue();
        assertThat(first.requireSession(tenant, session).status()).isEqualTo("CLOSED");
        assertThat(first.findOperation(tenant, session, id).orElseThrow().receiptId()).startsWith("rcpt_");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event WHERE tenant_id = ? AND event_type = 'session.closed'",
                Integer.class, tenant)).isEqualTo(1);
    }

    @Test
    void closeWriterCheckWaitsForAnUncommittedRenewalBeforeEvaluatingExpiry() throws Exception {
        var first = store(Clock.systemUTC());
        var journal = new ManagedSessionStore(jdbc);
        var otherJournal = new ManagedSessionStore(new JdbcTemplate(source));
        var tenant = "mysql-close-renew-" + UUID.randomUUID();
        var session = create(first, tenant);
        long generation = transaction(() -> journal.acquireWriter(tenant, session, TOKEN,
                new AcquireWriterRequest("workspace", "original", 60_000L))).writerGeneration();
        transaction(() -> first.beginWorkspaceClose(tenant, session, OWNER, ACTOR_DIGEST, "close", "digest", true));
        assertThat(first.requireSession(tenant, session).status()).isEqualTo("CLOSING");
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until ="
                + " TIMESTAMPADD(MICROSECOND, 750000, CURRENT_TIMESTAMP(6)) WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        var renewed = new CountDownLatch(1);
        var commit = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var renewal = pool.submit(() -> transaction(() -> {
                journal.renewWriter(tenant, session, TOKEN,
                        new RenewWriterRequest("workspace", "original", generation, 60_000L));
                renewed.countDown();
                try {
                    assertThat(commit.await(5, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError(interrupted);
                }
                return true;
            }));
            try {
                assertThat(renewed.await(5, TimeUnit.SECONDS)).isTrue();
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
                while (Boolean.TRUE.equals(jdbc.queryForObject("SELECT writer_lease_until > CURRENT_TIMESTAMP(6)"
                        + " FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?",
                        Boolean.class, tenant, session)) && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                }
                assertThat(jdbc.queryForObject("SELECT writer_lease_until > CURRENT_TIMESTAMP(6)"
                        + " FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?",
                        Boolean.class, tenant, session)).isFalse();
                var checked = new CountDownLatch(1);
                var live = pool.submit(() -> {
                    checked.countDown();
                    return transaction(() -> otherJournal.hasLiveWriter(tenant, session));
                });
                assertThat(checked.await(5, TimeUnit.SECONDS)).isTrue();
                Boolean premature = null;
                try {
                    premature = live.get(100, TimeUnit.MILLISECONDS);
                } catch (TimeoutException expected) {
                    // The locking read must wait for the writer's pending renewal.
                }
                assertThat(premature).as("Close must wait for renewal commit; premature live-writer observation").isNull();
                commit.countDown();
                assertThat(renewal.get(5, TimeUnit.SECONDS)).isTrue();
                assertThat(live.get(5, TimeUnit.SECONDS)).isTrue();
            } finally {
                commit.countDown();
            }
        }
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

    private static void awaitBlocked(CountDownLatch started, Future<Object> queued) {
        try {
            assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
            assertThrows(TimeoutException.class, () -> queued.get(100, TimeUnit.MILLISECONDS));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }

    private static Object outcome(Supplier<Object> operation) {
        try { return operation.get(); } catch (ApiException rejected) { return rejected; }
    }

    private static void assertCode(Object result, String code) {
        assertThat(result).isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo(code));
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
