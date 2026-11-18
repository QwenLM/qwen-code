package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.MySqlLockProbe;
import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/** A probe for a root visible to its snapshot takes no lock; a pinned root is
 * locked by its primary key, and an absent root still leaves the primary-key
 * insertion gap (#13996). */
@Timeout(30)
class ManagedLegacySessionGuardMySqlIT {
    private IsolatedManagedSchemaMySqlTestDatabase database;
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private ManagedAgentStore agents;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        agents = VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                events -> {}, mock(JdbcManagedWorkspaceRegistry.class), new ManagedAgentProperties(),
                new SdkHarnessRules());
    }

    @AfterEach
    void close() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    void ordinaryProbeDoesNotBlockAnotherTenantsFirstSession() throws Exception {
        String ordinary = createSession("guard-tenant-a");
        try (Connection probe = database.source().getConnection();
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            probe.setAutoCommit(false);
            assertThat(ManagedLegacySessionGuard.isPrivate(onto(probe), "guard-tenant-a", ordinary)).isFalse();
            // The only index entry precedes this key, so a gap lock left by the
            // probe would extend to the supremum and cover this insertion.
            Future<String> creation = executor.submit(() -> createSession("guard-tenant-b"));
            String waits = null;
            try {
                creation.get(2, TimeUnit.SECONDS);
            } catch (TimeoutException slow) {
                String schema = jdbc.queryForObject("SELECT DATABASE()", String.class);
                // A slow insert alone is load, not the regression; only an InnoDB wait is.
                if (MySqlLockProbe.lockWaits(jdbc, schema) > 0) {
                    waits = MySqlLockProbe.describeLockWaits(jdbc, schema);
                }
            } finally {
                probe.rollback();
            }
            assertThat(creation.get(5, TimeUnit.SECONDS)).isNotBlank();
            assertThat(waits).as("another tenant's Session insert waited behind the ordinary probe").isNull();
        }
    }

    @Test
    void probeStillLocksAndReportsAPinnedRoot() throws Exception {
        String pinned = createSession("guard-tenant-a");
        jdbc.update("UPDATE ma_session SET runtime_request_key = ? WHERE tenant_id = ? AND session_id = ?",
                "f".repeat(64), "guard-tenant-a", pinned);
        try (Connection probe = database.source().getConnection();
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            probe.setAutoCommit(false);
            assertThat(ManagedLegacySessionGuard.isPrivate(onto(probe), "guard-tenant-a", pinned)).isTrue();
            Future<Integer> writer = executor.submit(() -> jdbc.update(
                    "UPDATE ma_session SET gmt_modified = gmt_modified + 1 WHERE tenant_id = ? AND session_id = ?",
                    "guard-tenant-a", pinned));
            try {
                MySqlLockProbe.awaitLockWaits(jdbc, jdbc.queryForObject("SELECT DATABASE()", String.class), 1,
                        "a root writer behind the pinned probe");
            } finally {
                probe.rollback();
            }
            assertThat(writer.get(5, TimeUnit.SECONDS)).isEqualTo(1);
        }
    }

    @Test
    void absentProbeKeepsTheDocumentedPrimaryKeyGap() throws Exception {
        createSession("guard-tenant-a");
        try (Connection probe = database.source().getConnection();
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            probe.setAutoCommit(false);
            assertThat(ManagedLegacySessionGuard.isPrivate(onto(probe), "guard-tenant-z", "absent")).isFalse();
            // The absent key sorts after every existing root, so the locking
            // read's primary-key insertion gap reaches the supremum and covers
            // this later tenant's first root. The wait is the documented
            // residual of the absent branch; removing the locking read would
            // silence this case, and widening it to the first probe would fail
            // ordinaryProbeDoesNotBlockAnotherTenantsFirstSession.
            Future<String> creation = executor.submit(() -> createSession("guard-tenant-zz"));
            try {
                MySqlLockProbe.awaitLockWaits(jdbc, jdbc.queryForObject("SELECT DATABASE()", String.class), 1,
                        "another tenant's first Session behind the absent probe's primary-key gap");
            } finally {
                probe.rollback();
            }
            assertThat(creation.get(5, TimeUnit.SECONDS)).isNotBlank();
        }
    }

    @Test
    void collectorSeesALeaseCommittedWhileItWaitsOnTheRoot() throws Exception {
        // R2-1: the collector's pin probe must not fix its REPEATABLE READ view
        // before lockSessionHead, or a lease committed while it waits on the head
        // lock is invisible and the body under that live lease is collected.
        String tenant = "guard-collector-tenant";
        String session = createSession(tenant);
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String resourceKey = ManagedSessionStore.resourceKey(scope, "inline-body");
        byte[] body = {1, 2, 3};
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id,"
                        + " resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                        + " inline_bytes, state, gmt_create, retention_until)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', 0, 0)",
                resourceKey, scope, tenant, session, "inline-body", "managed-message-parts",
                body.length, ToolPublicationContract.sha256(body), body);
        var collector = new ManagedProjectionResourceCollector(jdbc,
                new DataSourceTransactionManager(database.source()));
        try (Connection holder = database.source().getConnection();
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            holder.setAutoCommit(false);
            JdbcTemplate holderJdbc = onto(holder);
            // The lease writer holds root and head, as ToolPublicationRetentionStore.read does.
            ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(holderJdbc, tenant, session);
            Future<Boolean> collected = executor.submit(collector::runOnce);
            // The collector blocks on the root: with the consistent fast path its
            // view is already fixed here; with the current read it is not.
            MySqlLockProbe.awaitLockWaits(jdbc, jdbc.queryForObject("SELECT DATABASE()", String.class), 1,
                    "the collector behind the lease writer's root lock");
            long generation = holderJdbc.queryForObject(
                    "SELECT retirement_generation FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    Long.class, tenant, session);
            holderJdbc.update("INSERT INTO ma_read_lease (lease_id, tenant_key, session_key,"
                            + " retirement_generation, expires_at) VALUES (?, ?, ?, ?, ?)",
                    UUID.randomUUID().toString(), ToolPublicationRetentionStore.hash(tenant),
                    ToolPublicationRetentionStore.hash(session), generation,
                    ToolPublicationRetentionStore.now(holderJdbc) + 120_000);
            holder.commit();
            assertThat(collected.get(10, TimeUnit.SECONDS)).isFalse();
            assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?",
                    byte[].class, resourceKey)).as("the body under a live read lease").isNotNull();
            assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?",
                    String.class, resourceKey)).isEqualTo("REFERENCED");
        }
    }

    private String createSession(String tenant) {
        return transactions.execute(status -> agents.insertSessionCommand(tenant, "CREATE_SESSION", "create",
                "digest", "qwen-code", "1", null, List.of(), null).sessionId());
    }

    private static JdbcTemplate onto(Connection connection) {
        return new JdbcTemplate(new SingleConnectionDataSource(connection, true));
    }
}
