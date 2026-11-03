package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.GuardDomain;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JdbcTenantGuardLocksMySqlIT {
    @Test
    void coldConcurrentRepeatableReadTransactionsShareBothGuardsWithoutExtraConnections() throws Exception {
        inSchema(source -> {
            var ready = new CountDownLatch(2);
            try (var workers = Executors.newFixedThreadPool(2)) {
                var first = workers.submit(() -> coldTransaction(source, ready));
                var second = workers.submit(() -> coldTransaction(source, ready));
                first.get(15, TimeUnit.SECONDS);
                second.get(15, TimeUnit.SECONDS);
            }
            var jdbc = new JdbcTemplate(source);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tenant_guard", Integer.class)).isEqualTo(2);
            assertThat(source.getActiveCount()).isZero();
        });
    }

    @Test
    void missingRootProbeCannotPersistEvidenceEvenWhenTheCallerCommits() throws Exception {
        inSchema(source -> {
            JdbcRepositorySupport.transaction(source, connection -> {
                assertThat(JdbcTenantGuardLocks.lockExisting(connection, "missing", GuardDomain.OUTPUT_PUBLICATION, 5))
                        .isFalse();
                return null;
            });
            var jdbc = new JdbcTemplate(source);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tenant_guard", Integer.class)).isZero();
            try (var connection = source.getConnection()) {
                assertFree(connection, "missing", GuardDomain.OUTPUT_PUBLICATION);
            }
        });
    }

    @Test
    void rawCommitRollbackAndSpringSuspendResumeReleaseOnlyTheirOwnMutexes() throws Exception {
        inSchema(source -> {
            for (boolean rollback : new boolean[] {false, true}) {
                try (var connection = source.getConnection()) {
                    connection.setAutoCommit(false);
                    try (var scope = JdbcTenantGuardLocks.openTransactionScope(connection)) {
                        JdbcTenantGuardLocks.lock(connection, "raw-" + rollback, GuardDomain.RUNTIME_PLACEMENT, 0);
                        assertOwned(connection, "raw-" + rollback, GuardDomain.RUNTIME_PLACEMENT);
                        if (rollback) {
                            connection.rollback();
                        } else {
                            connection.commit();
                        }
                    }
                    assertFree(connection, "raw-" + rollback, GuardDomain.RUNTIME_PLACEMENT);
                }
            }
            var manager = new DataSourceTransactionManager(source);
            var outer = new TransactionTemplate(manager);
            var inner = new TransactionTemplate(manager);
            inner.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            var jdbc = new JdbcTemplate(source);
            outer.execute(status -> jdbc.execute((ConnectionCallback<Void>) connection -> {
                JdbcTenantGuardLocks.lock(connection, "outer", GuardDomain.RUNTIME_PLACEMENT, 5);
                inner.execute(nested -> jdbc.execute((ConnectionCallback<Void>) other -> {
                    JdbcTenantGuardLocks.lock(other, "inner", GuardDomain.OUTPUT_PUBLICATION, 5);
                    nested.setRollbackOnly();
                    return null;
                }));
                assertFree(connection, "inner", GuardDomain.OUTPUT_PUBLICATION);
                assertOwned(connection, "outer", GuardDomain.RUNTIME_PLACEMENT);
                JdbcTenantGuardLocks.lock(connection, "outer", GuardDomain.RUNTIME_PLACEMENT, 5);
                return null;
            }));
            try (var connection = source.getConnection()) {
                assertFree(connection, "outer", GuardDomain.RUNTIME_PLACEMENT);
            }
            assertThat(source.getActiveCount()).isZero();
        });
    }

    @Test
    void failedMutexReleaseAbortsTheConnectionBeforeItCanBeReused() throws Exception {
        inSchema(source -> {
            try (var real = source.getConnection()) {
                real.setAutoCommit(false);
                var aborted = new AtomicBoolean();
                var wrapped = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {Connection.class}, (proxy, method, arguments) -> {
                            if (method.getName().equals("prepareStatement")
                                    && "SELECT RELEASE_LOCK(?)".equals(arguments[0])) {
                                throw new SQLException("Injected release failure");
                            }
                            if (method.getName().equals("abort")) {
                                aborted.set(true);
                            }
                            try {
                                return method.invoke(real, arguments);
                            } catch (InvocationTargetException failure) {
                                throw failure.getCause();
                            }
                        });
                var scope = JdbcTenantGuardLocks.openTransactionScope(wrapped);
                JdbcTenantGuardLocks.lock(wrapped, "abort", GuardDomain.RUNTIME_PLACEMENT, 5);
                real.commit();
                assertThatThrownBy(scope::close).isInstanceOf(SQLException.class);
                assertThat(aborted).isTrue();
                assertThat(real.isClosed()).isTrue();
            }
        });
    }

    private static Void coldTransaction(DruidDataSource source, CountDownLatch ready) {
        return JdbcRepositorySupport.transaction(source, connection -> {
            connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try (var statement = connection.prepareStatement("SELECT COUNT(*) FROM ma_tenant_guard");
                    var row = statement.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getInt(1)).isZero();
            }
            ready.countDown();
            try {
                assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new SQLException("Interrupted", interrupted);
            }
            JdbcTenantGuardLocks.lock(connection, "shared", GuardDomain.RUNTIME_PLACEMENT, 5);
            JdbcTenantGuardLocks.lock(connection, "shared", GuardDomain.OUTPUT_PUBLICATION, 5);
            JdbcTenantGuardLocks.lock(connection, "shared", GuardDomain.RUNTIME_PLACEMENT, 5);
            return null;
        });
    }

    private static void assertOwned(Connection connection, String tenant, GuardDomain domain) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT IS_USED_LOCK(?) = CONNECTION_ID()")) {
            statement.setString(1, mutex(connection, tenant, domain));
            try (var row = statement.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getBoolean(1)).isTrue();
            }
        }
    }

    private static void assertFree(Connection connection, String tenant, GuardDomain domain) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT IS_FREE_LOCK(?)")) {
            statement.setString(1, mutex(connection, tenant, domain));
            try (var row = statement.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getInt(1)).isEqualTo(1);
            }
        }
    }

    private static String mutex(Connection connection, String tenant, GuardDomain domain) throws SQLException {
        return ManagedSchemaKeys.key("managed-tenant-guard-bootstrap", connection.getCatalog(), tenant, domain.value());
    }

    private static void inSchema(Work work) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        String schema = "tenant_guard_" + UUID.randomUUID().toString().replace("-", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        admin.execute("CREATE DATABASE " + schema);
        try (var source = new DruidDataSource()) {
            source.setUrl(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema));
            source.setUsername(user);
            source.setPassword(password);
            source.setInitialSize(0);
            source.setMinIdle(0);
            source.setMaxActive(2);
            source.setMaxWait(5000);
            source.init();
            ManagedSchema.initialize(source);
            work.run(source);
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    @FunctionalInterface
    private interface Work {
        void run(DruidDataSource source) throws Exception;
    }
}
