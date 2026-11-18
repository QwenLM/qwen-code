package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.MySqlLockProbe;
import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChildWorkspaceStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceOperatorRecoveryStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRecoveryContract.Fixture;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeRequestKeys;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;

import javax.sql.DataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Timeout(30)
class WorkspaceExecutionMembershipMySqlIT {
    private IsolatedManagedSchemaMySqlTestDatabase database;
    private DataSource source;
    private ManagedSchemaJdbcTemplate jdbc;
    private ManagedAgentStore store;
    private JdbcWorkspaceExecutionStore authority;
    private String schema;
    @TempDir
    private Path temp;

    @BeforeEach
    void setUp() throws Exception {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        source = database.source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        store = VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new JdbcManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties(), new SdkHarnessRules());
        authority = authority(new DataSourceTransactionManager(source));
        schema = jdbc.queryForObject("SELECT DATABASE()", String.class);
    }

    @AfterEach
    void close() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    void heldTenantGuardDoesNotBlockMembershipOrRewind() throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var runtime = fixture.runtime("held-guard");
        try (var pool = Executors.newSingleThreadExecutor(); var blocker = lock(
                "SELECT tenant_id FROM ma_tenant_guard WHERE tenant_key = ?"
                        + " AND guard_domain = 'runtime_placement' FOR UPDATE",
                RuntimeRequestKeys.valueKey(fixture.tenant))) {
            try {
                pool.submit(() -> {
                    authority.claim(fixture.session.workspace(), runtime.session());
                    checkMembers(fixture);
                    authority.claim(fixture.session.workspace(), runtime.session());
                    checkMembers(fixture);
                    authority.beginRewind(fixture.session.workspace(), runtime.session());
                    checkMembers(fixture);
                    authority.endRewind(fixture.session.workspace(), runtime.session());
                    checkMembers(fixture);
                    authority.release(fixture.session.workspace(), runtime.session());
                    authority.release(fixture.session.workspace(), runtime.session());
                    checkMembers(fixture);
                }).get(5, TimeUnit.SECONDS);
            } finally {
                blocker.rollback();
            }
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void distinctDirectoriesDoNotTakeMembershipRangeLocks(boolean sameTenant) throws Exception {
        var first = new Fixture(source, jdbc, store);
        var second = new Fixture(source, jdbc, store, sameTenant ? first.tenant : UUID.randomUUID().toString(),
                "other-workspace", "other-storage");
        var a = first.runtime("a");
        var b = second.runtime("b");
        var pause = new CommitPause(2);
        var paused = authority(pause);
        try (var pool = Executors.newFixedThreadPool(2)) {
            try {
                var left = pool.submit(() -> paused.claim(first.session.workspace(), a.session()));
                var right = pool.submit(() -> paused.claim(second.session.workspace(), b.session()));
                assertThat(pause.reached.await(5, TimeUnit.SECONDS)).isTrue();
                var locks = jdbc.queryForList("SELECT OBJECT_NAME, INDEX_NAME, LOCK_MODE, LOCK_DATA"
                        + " FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = ? AND LOCK_TYPE = 'RECORD'", schema);
                assertThat(locks.stream().filter(row -> "ma_storage_owner".equals(row.get("object_name"))))
                        .hasSizeGreaterThanOrEqualTo(2);
                assertThat(locks.stream().filter(row -> "idx_ma_runtime_execution_storage".equals(row.get("index_name"))))
                        .allSatisfy(row -> assertThat(row.get("lock_mode").toString()).contains("REC_NOT_GAP"));
                assertThat(MySqlLockProbe.lockWaits(jdbc, schema)).isZero();
                org.slf4j.LoggerFactory.getLogger(getClass()).info("Active membership locks: {}", locks);
                pause.resume.countDown();
                left.get(5, TimeUnit.SECONDS);
                right.get(5, TimeUnit.SECONDS);
            } finally {
                pause.resume.countDown();
            }
        }
        checkMembers(first);
        checkMembers(second);
        authority.release(first.session.workspace(), a.session());
        authority.release(second.session.workspace(), b.session());
        checkMembers(first);
        checkMembers(second);
    }

    @Test
    void operatorPreparationLocksTheDirectoryBeforeTheBinding() throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var runtime = fixture.runtime("operator");
        authority.claim(fixture.session.workspace(), runtime.session());
        var prepared = fixture.executions.findOrCreate(ToolExecutionRecord.prepared(UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), runtime.binding().getBindingId(), runtime.binding().getGeneration(),
                fixture.session.sessionId(), runtime.session().getRuntimeSessionId(), "turn", "call", "digest",
                Map.of("sessionId", runtime.session().getRuntimeSessionId(), "promptId", "turn", "callId", "call",
                        "argsDigest", "digest", "runtimeProtocol", 3, "inputDigest", "digest", "dispatchMode", "deferred")));
        var dispatch = fixture.executions.claimDispatch(prepared.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
        assertThat(fixture.executions.compareAndSet(dispatch,
                dispatch.withResult(Map.of("executionStatus", "success", "responseParts", List.of(),
                        "capture", Map.of("captureStatus", "partial", "captureReason", "producer_lost")), 1, Instant.now()),
                "dispatcher", dispatch.getDispatchGeneration())).isNotNull();
        var recovery = new WorkspaceOperatorRecoveryStore(jdbc, new DataSourceTransactionManager(source),
                fixture.bindings, new ObjectMapper());
        var inspection = recovery.inspect(runtime.binding().getBindingId(), runtime.binding().getGeneration());
        long deadlocks = MySqlLockProbe.innodbDeadlocks(jdbc);
        try (var pool = Executors.newFixedThreadPool(2); var blocker = lock(
                "SELECT binding_id FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE", runtime.binding().getBindingId())) {
            try {
                var prepare = pool.submit(() -> recovery.prepare(runtime.binding().getBindingId(), runtime.binding().getGeneration(),
                        inspection.holderKey(), "operator", "membership-test"));
                MySqlLockProbe.awaitLockWaits(jdbc, schema, 1, "prepare waiting on binding");
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM performance_schema.data_locks held"
                        + " JOIN performance_schema.data_lock_waits waits ON held.ENGINE = waits.ENGINE"
                        + " AND held.ENGINE_TRANSACTION_ID = waits.REQUESTING_ENGINE_TRANSACTION_ID"
                        + " WHERE held.OBJECT_SCHEMA = ? AND held.OBJECT_NAME = 'ma_storage_owner'"
                        + " AND held.LOCK_TYPE = 'RECORD' AND held.LOCK_STATUS = 'GRANTED'", Long.class, schema)).isPositive();
                var claim = pool.submit(() -> authority.claim(fixture.session.workspace(), runtime.session()));
                MySqlLockProbe.awaitLockWaits(jdbc, schema, 2, "claim waiting behind prepare");
                org.slf4j.LoggerFactory.getLogger(getClass()).info("{}", MySqlLockProbe.describeLockWaits(jdbc, schema));
                blocker.rollback();
                assertThat(prepare.get(5, TimeUnit.SECONDS)).isNotBlank();
                assertRefused(claim);
            } finally {
                blocker.rollback();
            }
        }
        assertThat(fixture.bindings.findById(runtime.binding().getBindingId()).getState())
                .isEqualTo(RuntimeBindingRecord.State.OPERATOR_RECOVERY);
        assertThat(MySqlLockProbe.innodbDeadlocks(jdbc) - deadlocks).isZero();
        checkMembers(fixture);
    }

    @ParameterizedTest
    @ValueSource(strings = {"fence", "maintenance"})
    void committedMembershipRefusesACompetingPhysicalStep(String kind) throws Exception {
        String tenant = UUID.randomUUID().toString();
        Path root = Files.createDirectory(temp.resolve("root")).toRealPath();
        var settings = new ManagedAgentProperties();
        settings.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        settings.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount(tenant, "storage", root.toString())));
        var guard = new WorkspaceStorageGuard(jdbc, new DataSourceTransactionManager(source), settings, path -> {
            var attributes = Files.readAttributes(path, BasicFileAttributes.class);
            return new StorageIdentityReader.Identity(path.toString(), "test-host", "test-device",
                    attributes.fileKey().toString(), attributes.creationTime().toInstant().toString());
        });
        guard.register(tenant, "storage", UUID.randomUUID().toString());
        var fixture = new Fixture(source, jdbc, store, tenant, "workspace", "storage");
        var runtime = fixture.runtime("physical");
        var children = new JdbcChildWorkspaceStore(jdbc, new DataSourceTransactionManager(source));
        var child = children.claim(children.admit(tenant, fixture.session.sessionId(), UUID.randomUUID().toString(),
                fixture.session.workspace(), System.currentTimeMillis()), "maintenance", System.currentTimeMillis(), 60_000);
        java.util.concurrent.Callable<String> physical = () -> {
            if (kind.equals("fence")) {
                guard.fence(tenant, "storage", 1, UUID.randomUUID().toString());
                return "fenced";
            }
            return authority.holdForMaintenance(fixture.session.workspace(), child.childWorkspaceId(), 1);
        };
        var pause = new CommitPause(1);
        var paused = authority(pause);
        try (var pool = Executors.newFixedThreadPool(2)) {
            try {
                var claim = pool.submit(() -> paused.claim(fixture.session.workspace(), runtime.session()));
                assertThat(pause.reached.await(5, TimeUnit.SECONDS)).isTrue();
                var competing = pool.submit(physical);
                MySqlLockProbe.awaitLockWaits(jdbc, schema, 1, kind + " waiting for membership");
                pause.resume.countDown();
                claim.get(5, TimeUnit.SECONDS);
                assertRefused(competing);
            } finally {
                pause.resume.countDown();
            }
        }
        checkMembers(fixture);
        authority.beginRewind(fixture.session.workspace(), runtime.session());
        assertThatThrownBy(physical::call).isInstanceOf(RuntimeBrokerException.class);
        authority.release(fixture.session.workspace(), runtime.session());
        checkMembers(fixture);
        assertThat(physical.call()).isNotBlank();
        checkMembers(fixture);
    }

    @Test
    void pendingRewindAllowsANeighborAfterItsShortAdmissionTransaction() throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var owner = fixture.runtime("owner");
        var neighbor = fixture.runtime("neighbor", neighbor(fixture));
        authority.claim(fixture.session.workspace(), owner.session());
        checkMembers(fixture);
        var pause = new CommitPause(1);
        var paused = authority(pause);
        try (var pool = Executors.newFixedThreadPool(2)) {
            try {
                var rewind = pool.submit(() -> paused.beginRewind(fixture.session.workspace(), owner.session()));
                assertThat(pause.reached.await(5, TimeUnit.SECONDS)).isTrue();
                var claim = pool.submit(() -> authority.claim(fixture.session.workspace(), neighbor.session()));
                MySqlLockProbe.awaitLockWaits(jdbc, schema, 1, "claim waiting for rewind");
                pause.resume.countDown();
                rewind.get(5, TimeUnit.SECONDS);
                claim.get(5, TimeUnit.SECONDS);
            } finally {
                pause.resume.countDown();
            }
        }
        checkMembers(fixture);
        authority.assertHeld(fixture.session.workspace(), neighbor.session());
        assertThat(authority.hasPendingRewind(owner.session())).isTrue();
        authority.beginRewind(fixture.session.workspace(), neighbor.session());
        checkMembers(fixture);
        authority.endRewind(fixture.session.workspace(), owner.session());
        assertThat(authority.hasPendingRewind(owner.session())).isFalse();
        assertThat(authority.hasPendingRewind(neighbor.session())).isTrue();
        checkMembers(fixture);
        authority.release(fixture.session.workspace(), owner.session());
        assertThat(authority.hasPendingRewind(neighbor.session())).isTrue();
        authority.release(fixture.session.workspace(), neighbor.session());
        checkMembers(fixture);
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void rewindAdmissionAndMountHandbackHaveOneAtomicWinner(boolean rewindFirst) throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var runtime = fixture.runtime("rewind-handback");
        authority.claim(fixture.session.workspace(), runtime.session());
        var pause = new CommitPause(1);
        var paused = authority(pause);
        try (var pool = Executors.newFixedThreadPool(2)) {
            try {
                var first = pool.submit(() -> {
                    if (rewindFirst) {
                        paused.beginRewind(fixture.session.workspace(), runtime.session());
                    } else {
                        paused.releaseMount(fixture.session.workspace(), runtime.session());
                    }
                });
                assertThat(pause.reached.await(5, TimeUnit.SECONDS)).isTrue();
                var second = pool.submit(() -> {
                    if (rewindFirst) {
                        authority.releaseMount(fixture.session.workspace(), runtime.session());
                    } else {
                        authority.beginRewind(fixture.session.workspace(), runtime.session());
                    }
                });
                MySqlLockProbe.awaitLockWaits(jdbc, schema, 1, "rewind and handback arbitration");
                pause.resume.countDown();
                first.get(5, TimeUnit.SECONDS);
                assertThatThrownBy(() -> second.get(5, TimeUnit.SECONDS))
                        .hasCauseInstanceOf(RuntimeBrokerException.class)
                        .satisfies(error -> assertThat(((RuntimeBrokerException) error.getCause()).getCode())
                                .isEqualTo(rewindFirst ? "workspace_writer_unproven" : "workspace_unavailable"));
            } finally {
                pause.resume.countDown();
            }
        }
        assertThat(authority.hasPendingRewind(runtime.session())).isEqualTo(rewindFirst);
        assertThat(authority.isHeld(fixture.session.workspace(), runtime.session())).isEqualTo(rewindFirst);
        checkMembers(fixture);
        authority.release(fixture.session.workspace(), runtime.session());
        checkMembers(fixture);
    }

    @Test
    void lostRecoveryClearsAllItsPendingMembersAndPreservesANeighbor() throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var original = fixture.runtime("original");
        var acquiring = fixture.bindings.admitSession(fixture.sessions, new RuntimeSessionRecord(
                new RuntimeSession(fixture.session.sessionId(), "second-original", "bootstrap", original.session().getSession().getScope()),
                original.binding().getBindingId(), original.binding().getGeneration(), RuntimeSessionRecord.State.ACQUIRING,
                0, Instant.now()));
        var second = fixture.sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        var neighbor = fixture.runtime("neighbor", neighbor(fixture));
        for (var member : List.of(original.session(), second, neighbor.session())) {
            authority.claim(fixture.session.workspace(), member);
            authority.beginRewind(fixture.session.workspace(), member);
        }
        checkMembers(fixture);
        var lost = fixture.lose(original.binding());
        var recovered = fixture.bindings.recoverLost(fixture.sessions, fixture.executions, lost);
        authority.releaseLost(recovered);
        for (var member : List.of(original.session(), second)) {
            assertThat(authority.hasPendingRewind(member)).isFalse();
            assertThat(authority.isHeld(fixture.session.workspace(), member)).isFalse();
        }
        assertThat(authority.hasPendingRewind(neighbor.session())).isTrue();
        assertThat(authority.isHeld(fixture.session.workspace(), neighbor.session())).isTrue();
        checkMembers(fixture);
        authority.release(fixture.session.workspace(), neighbor.session());
        checkMembers(fixture);
    }

    private String neighbor(Fixture fixture) {
        return new org.springframework.transaction.support.TransactionTemplate(new DataSourceTransactionManager(source))
                .execute(status -> store.insertWorkspaceSessionCommand(SessionCreationCommand.builder()
                        .tenantId(fixture.tenant).actorId("actor").idempotencyKey(UUID.randomUUID().toString())
                        .requestDigest("sha256:" + "b".repeat(64)).agentId("qwen-code")
                        .selection(new WorkspaceSelection("workspace", ".")).build()).sessionId());
    }

    private JdbcWorkspaceExecutionStore authority(DataSourceTransactionManager manager) {
        return VerificationFixtures.configure(new JdbcWorkspaceExecutionStore(jdbc, manager));
    }

    private Connection lock(String sql, String value) throws Exception {
        var connection = source.getConnection();
        try {
            connection.setAutoCommit(false);
            try (var statement = connection.prepareStatement(sql)) {
                statement.setString(1, value);
                try (var rows = statement.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                }
            }
            return connection;
        } catch (Exception | AssertionError error) {
            connection.close();
            throw error;
        }
    }

    private void checkMembers(Fixture fixture) {
        String key = jdbc.queryForObject("SELECT physical_key FROM ma_storage WHERE alias_key = ?", String.class,
                RuntimeAdmissionFences.storageAliasKey(fixture.tenant, fixture.session.workspace().getStorageId()));
        long members = jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE execution_storage_key = ?", Long.class, key);
        assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner WHERE storage_key = ?", Long.class, key))
                .isEqualTo(members);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE execution_storage_key IS NULL"
                + " AND is_rewind_pending = TRUE", Long.class)).isZero();
    }

    private static void assertRefused(Future<?> result) {
        assertThatThrownBy(() -> result.get(5, TimeUnit.SECONDS)).hasCauseInstanceOf(RuntimeBrokerException.class);
    }

    private final class CommitPause extends DataSourceTransactionManager {
        private final CountDownLatch reached;
        private final CountDownLatch resume = new CountDownLatch(1);

        private CommitPause(int writers) {
            super(WorkspaceExecutionMembershipMySqlIT.this.source);
            reached = new CountDownLatch(writers);
        }

        @Override
        protected void doCommit(DefaultTransactionStatus status) {
            reached.countDown();
            try {
                assertThat(resume.await(5, TimeUnit.SECONDS)).isTrue();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
            }
            super.doCommit(status);
        }
    }
}
