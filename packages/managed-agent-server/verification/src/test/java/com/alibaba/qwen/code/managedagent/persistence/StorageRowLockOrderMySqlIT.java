package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.MySqlLockProbe;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * A storage row has a primary record and an alias record, and a locking read
 * through the alias record locks both, alias first. A transaction that locked
 * the primary record first, through another index, and then asked for the
 * alias record closed a cycle with any transaction that already held the
 * alias record and waited for the primary one: Runtime binding creation,
 * execution membership and journal commits on one side, storage admission and
 * physical recovery on the other (#16320). Physical recovery locks every alias
 * of its storage, so two recoveries also have to take them in one order.
 */
@Timeout(60)
class StorageRowLockOrderMySqlIT {
    private static final String TENANT = "lock-order-tenant";
    private static final String STORAGE = "lock-order-storage";
    private static final String PHYSICAL = "p".repeat(64);

    private IsolatedManagedSchemaMySqlTestDatabase database;
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private String schema;
    private ExecutorService threads;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        schema = jdbc.queryForObject("SELECT DATABASE()", String.class);
        threads = Executors.newFixedThreadPool(2);
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id)"
                + " VALUES (?, ?, ?, ?, ?)", JdbcRuntimeBindingRepository.storageAliasKey(TENANT, STORAGE),
                JdbcRuntimeBindingRepository.storageFenceKey(TENANT),
                JdbcRuntimeBindingRepository.storageFenceKey(STORAGE), TENANT, STORAGE);
    }

    @AfterEach
    void close() throws InterruptedException {
        if (threads != null) {
            threads.shutdownNow();
            // A transaction still open would hold the schema's metadata lock.
            threads.awaitTermination(30, TimeUnit.SECONDS);
        }
        if (database != null) {
            database.close();
        }
    }

    @ParameterizedTest(name = "shared admission = {0}")
    @ValueSource(booleans = {false, true})
    void storageAdmissionAndAnAliasLockerQueueInsteadOfDeadlocking(boolean shared) throws Exception {
        // The alias locker starts once admission has read the row for its
        // fence, and admission goes on only after the locker is waiting.
        var admissionJdbc = new PausingJdbc(database.source(), " FROM ma_storage ",
                () -> transactions.executeWithoutResult(status -> SshWorkspaceStore.physicalKey(jdbc, TENANT, STORAGE)));
        Future<?> admission = threads.submit(() -> transactions.executeWithoutResult(status -> admit(admissionJdbc, shared)));

        admission.get(30, TimeUnit.SECONDS);
        assertThat(admissionJdbc.paused).as("admission read the storage row").isNotNull();
        admissionJdbc.paused.get(30, TimeUnit.SECONDS);
    }

    @ParameterizedTest(name = "shared admission = {0}")
    @ValueSource(booleans = {false, true})
    void physicalRecoveryAndStorageAdmissionQueueInsteadOfDeadlocking(boolean shared) throws Exception {
        registerLocal();
        // Admission starts once recovery has locked the aliases of the
        // physical storage and scanned it, and recovery goes on only after
        // admission waits.
        var recoveryJdbc = new PausingJdbc(database.source(), "LIMIT 129 FOR UPDATE",
                () -> transactions.executeWithoutResult(status -> admit(jdbc, shared)));
        Future<?> recovery = threads.submit(() -> transactions.executeWithoutResult(status ->
                assertThat(LocalStorageOwners.lockCovered(recoveryJdbc, TENANT, STORAGE)).isEqualTo(PHYSICAL)));

        recovery.get(30, TimeUnit.SECONDS);
        assertThat(recoveryJdbc.paused).as("recovery scanned the physical storage").isNotNull();
        recoveryJdbc.paused.get(30, TimeUnit.SECONDS);
    }

    @Test
    void recoveriesOfTwoAliasesOfOneStorageQueueInsteadOfDeadlocking() throws Exception {
        String other = "lock-order-other-tenant";
        registerLocal();
        insertLocal(other, PHYSICAL);
        // Two tenants recover their own alias of one shared storage; neither
        // tenant's guard orders them. The second starts once the first holds
        // the aliases it locks before its scan. Recoveries that locked only
        // their own alias would close a cycle: their scans cross, one holding
        // a physical_key record the other needs while it waits for a primary
        // record the other holds.
        String first = other;
        String second = TENANT;
        var recoveryJdbc = new PausingJdbc(database.source(), "alias_key IN (",
                () -> transactions.executeWithoutResult(status ->
                        assertThat(LocalStorageOwners.lockCovered(jdbc, second, STORAGE)).isEqualTo(PHYSICAL)));
        Future<?> recovery = threads.submit(() -> transactions.executeWithoutResult(status ->
                assertThat(LocalStorageOwners.lockCovered(recoveryJdbc, first, STORAGE)).isEqualTo(PHYSICAL)));

        recovery.get(30, TimeUnit.SECONDS);
        assertThat(recoveryJdbc.paused).as("recovery locked the storage").isNotNull();
        recoveryJdbc.paused.get(30, TimeUnit.SECONDS);
    }

    @Test
    void physicalRecoveryScansOnlyItsOwnStorageWhenItHoldsMostRows() {
        registerLocal();
        for (int index = 1; index < 20; index++) {
            insertLocal("lock-order-tenant-" + index, PHYSICAL);
        }
        insertLocal("lock-order-elsewhere-1", "q".repeat(64));
        insertLocal("lock-order-elsewhere-2", "r".repeat(64));
        jdbc.execute("ANALYZE TABLE ma_storage");
        var capturing = new CapturingJdbc(database.source(), "LIMIT 129 FOR UPDATE");
        transactions.executeWithoutResult(status ->
                assertThat(LocalStorageOwners.lockCovered(capturing, TENANT, STORAGE)).isEqualTo(PHYSICAL));

        // A table scan would lock the other storages' rows, in id order.
        assertThat(capturing.sql).as("recovery scanned the physical storage").isNotNull();
        var plan = ExecutedQueryPlan.explain(jdbc, capturing.sql, capturing.arguments);
        assertThat(plan.tableScan()).as(plan.text()).isFalse();
        assertThat(plan.usesIndex("idx_ma_storage_physical")).as(plan.text()).isTrue();
    }

    private void insertLocal(String tenant, String physical) {
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                + " registration_state, storage_kind, registration_revision, registration_json)"
                + " VALUES (?, ?, ?, ?, ?, ?, 'REGISTERED', 'LOCAL', 1, '{}')",
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, STORAGE), JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                JdbcRuntimeBindingRepository.storageFenceKey(STORAGE), tenant, STORAGE, physical);
    }

    private void registerLocal() {
        jdbc.update("UPDATE ma_storage SET physical_key = ?, registration_state = 'REGISTERED', storage_kind = 'LOCAL',"
                + " registration_revision = 1, registration_json = '{}' WHERE alias_key = ?", PHYSICAL,
                JdbcRuntimeBindingRepository.storageAliasKey(TENANT, STORAGE));
        jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind, mount_state)"
                + " VALUES (?, ?, 'LOCAL', 'READY')", PHYSICAL, PHYSICAL);
    }

    private static void admit(ManagedSchemaJdbcTemplate jdbc, boolean shared) {
        if (shared) {
            WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE);
        } else {
            WorkspaceMigrationAdmission.requireOpen(jdbc, TENANT, STORAGE);
        }
    }

    /** Records the first query containing {@code marker}. */
    private static final class CapturingJdbc extends ManagedSchemaJdbcTemplate {
        private final String marker;
        private volatile String sql;
        private volatile Object[] arguments;

        private CapturingJdbc(DataSource source, String marker) {
            super(source);
            this.marker = marker;
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            if (this.sql == null && sql.contains(marker)) {
                this.sql = sql;
                this.arguments = args.clone();
            }
            return super.query(sql, mapper, args);
        }
    }

    /**
     * Right after the first query containing {@code marker}, through either
     * entry point the code under test uses, starts {@code other} on another
     * thread and waits until it queues on a lock.
     */
    private final class PausingJdbc extends ManagedSchemaJdbcTemplate {
        private final String marker;
        private final Runnable other;
        private volatile Future<?> paused;

        private PausingJdbc(DataSource source, String marker, Runnable other) {
            super(source);
            this.marker = marker;
            this.other = other;
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            return after(sql, super.query(sql, mapper, args));
        }

        @Override
        public <T> List<T> queryForList(String sql, Class<T> type, Object... args) {
            return after(sql, super.queryForList(sql, type, args));
        }

        private <T> List<T> after(String sql, List<T> rows) {
            if (paused == null && sql.contains(marker)) {
                paused = threads.submit(other);
                awaitQueued(paused::isDone);
            }
            return rows;
        }

        private void awaitQueued(BooleanSupplier finished) {
            try {
                MySqlLockProbe.awaitLockWaits(jdbc, schema, 1, "the second transaction");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
            }
            assertThat(finished.getAsBoolean()).as("the second transaction waits").isFalse();
        }
    }
}
