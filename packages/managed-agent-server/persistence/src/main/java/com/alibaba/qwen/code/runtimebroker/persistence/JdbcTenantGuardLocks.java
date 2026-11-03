package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.GuardDomain;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/** 按整数主键锁定已有 guard；首次创建在原连接的事务边界内串行化。 */
public final class JdbcTenantGuardLocks {
    private static final Object SPRING_RESOURCE = new Object();
    private static final ThreadLocal<Scope> LOCAL_SCOPE = new ThreadLocal<>();

    private JdbcTenantGuardLocks() {}

    public static Scope openTransactionScope(Connection connection) throws SQLException {
        if (connection.getAutoCommit()) {
            throw new SQLException("Tenant guard scope requires an explicit transaction");
        }
        Scope scope = new Scope(DataSourceUtils.getTargetConnection(connection), LOCAL_SCOPE.get());
        LOCAL_SCOPE.set(scope);
        return scope;
    }

    public static void lock(Connection connection, String tenant, GuardDomain domain, int timeoutSeconds)
            throws SQLException {
        acquire(connection, tenant, domain, timeoutSeconds, true);
    }

    /** 只锁定可证明已存在的根行，缺失时不创建。 */
    public static boolean lockExisting(
            Connection connection, String tenant, GuardDomain domain, int timeoutSeconds) throws SQLException {
        return acquire(connection, tenant, domain, timeoutSeconds, false);
    }

    private static boolean acquire(Connection connection, String tenant, GuardDomain domain,
            int timeoutSeconds, boolean create) throws SQLException {
        if (timeoutSeconds < 0 || tenant == null || domain == null) {
            throw new IllegalArgumentException("Invalid tenant guard request");
        }
        if (!"MySQL".equals(connection.getMetaData().getDatabaseProductName())) {
            return portable(connection, tenant, domain, timeoutSeconds, create);
        }
        if (connection.getAutoCommit()) {
            throw new SQLException("Tenant guard requires an explicit transaction");
        }
        Scope scope = scope(connection);
        GuardKey key = new GuardKey(tenant, domain);
        Long id = scope == null ? null : scope.identities.get(key);
        if (id == null) {
            id = findId(connection, tenant, domain, timeoutSeconds, false);
        }
        if (id != null) {
            lockId(connection, tenant, domain, id, timeoutSeconds);
            if (scope != null) {
                scope.identities.put(key, id);
            }
            return true;
        }
        if (scope == null) {
            throw new SQLException("Missing tenant guard requires a managed transaction scope");
        }
        String mutex = ManagedSchemaKeys.key("managed-tenant-guard-bootstrap", connection.getCatalog(),
                tenant, domain.value());
        if (!scope.mutexes.contains(mutex)) {
            acquireMutex(connection, mutex, timeoutSeconds);
            scope.mutexes.add(mutex);
        }
        if (!create) {
            // 旧 RR 快照无法证明根行存在时保守返回缺失；不得通过探测创建安全证据。
            // 同一事务后续显式初始化仍持有该键互斥锁，不会与其它初始化竞争。
            return false;
        }
        // 不先做缺键的锁定读，避免不同租户在复合副索引上持有重叠 gap 锁。
        // 同一业务键的首次 INSERT 由原连接互斥锁串行化；RR 旧快照只会走重复键分支。
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES (?, ?, ?)")) {
            insert.setQueryTimeout(timeoutSeconds);
            insert.setString(1, ManagedSchemaKeys.key(tenant));
            JdbcRepositorySupport.setIdentity(insert, 2, tenant);
            insert.setString(3, domain.value());
            insert.executeUpdate();
            id = findId(connection, tenant, domain, timeoutSeconds, false);
            if (id == null) {
                throw new SQLException("Created tenant guard is missing");
            }
            lockId(connection, tenant, domain, id, timeoutSeconds);
            scope.identities.put(key, id);
            return false;
        } catch (SQLException failure) {
            if (failure.getErrorCode() != 1062) {
                throw failure;
            }
        }
        // 重复键错误不会中止 MySQL 事务；当前读越过旧快照，并继续校验原租户身份。
        id = findId(connection, tenant, domain, timeoutSeconds, true);
        if (id == null) {
            throw new SQLException("Tenant guard disappeared while acquiring its row");
        }
        lockId(connection, tenant, domain, id, timeoutSeconds);
        scope.identities.put(key, id);
        return true;
    }

    private static Long findId(Connection connection, String tenant, GuardDomain domain,
            int timeoutSeconds, boolean locking) throws SQLException {
        String sql = switch (domain) {
            case RUNTIME_PLACEMENT -> locking
                    ? "SELECT id, tenant_id FROM ma_tenant_guard WHERE tenant_key = ? AND guard_domain = 'runtime_placement' FOR UPDATE"
                    : "SELECT id, tenant_id FROM ma_tenant_guard WHERE tenant_key = ? AND guard_domain = 'runtime_placement'";
            case OUTPUT_PUBLICATION -> locking
                    ? "SELECT id, tenant_id FROM ma_tenant_guard WHERE tenant_key = ? AND guard_domain = 'output_publication' FOR UPDATE"
                    : "SELECT id, tenant_id FROM ma_tenant_guard WHERE tenant_key = ? AND guard_domain = 'output_publication'";
        };
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(timeoutSeconds);
            statement.setString(1, ManagedSchemaKeys.key(tenant));
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                if (!tenant.equals(ManagedSchemaRows.identity(result, "tenant_id"))) {
                    throw new SQLException("Tenant guard identity hash collision");
                }
                long id = result.getLong("id");
                if (id <= 0 || result.next()) {
                    throw new SQLException("Invalid tenant guard identity");
                }
                return id;
            }
        }
    }

    private static void lockId(Connection connection, String tenant, GuardDomain domain,
            long id, int timeoutSeconds) throws SQLException {
        String sql = switch (domain) {
            case RUNTIME_PLACEMENT -> "SELECT tenant_id FROM ma_tenant_guard WHERE id = ? AND guard_domain = 'runtime_placement' FOR UPDATE";
            case OUTPUT_PUBLICATION -> "SELECT tenant_id FROM ma_tenant_guard WHERE id = ? AND guard_domain = 'output_publication' FOR UPDATE";
        };
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(timeoutSeconds);
            statement.setLong(1, id);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next() || !tenant.equals(ManagedSchemaRows.identity(result, "tenant_id"))
                        || result.next()) {
                    throw new SQLException("Tenant guard identity changed");
                }
            }
        }
    }

    private static boolean portable(Connection connection, String tenant, GuardDomain domain,
            int timeoutSeconds, boolean create) throws SQLException {
        if (create) {
            String sql = switch (domain) {
                case RUNTIME_PLACEMENT -> "INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES (?, ?, 'runtime_placement') ON DUPLICATE KEY UPDATE tenant_key = tenant_key";
                case OUTPUT_PUBLICATION -> "INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES (?, ?, 'output_publication') ON DUPLICATE KEY UPDATE tenant_key = tenant_key";
            };
            try (PreparedStatement insert = connection.prepareStatement(sql)) {
                insert.setQueryTimeout(timeoutSeconds);
                insert.setString(1, ManagedSchemaKeys.key(tenant));
                JdbcRepositorySupport.setIdentity(insert, 2, tenant);
                insert.executeUpdate();
            }
        }
        Long id = findId(connection, tenant, domain, timeoutSeconds, true);
        if (id == null) {
            return false;
        }
        lockId(connection, tenant, domain, id, timeoutSeconds);
        return true;
    }

    private static Scope scope(Connection connection) {
        Connection target = DataSourceUtils.getTargetConnection(connection);
        for (Scope current = LOCAL_SCOPE.get(); current != null; current = current.previous) {
            if (current.connection == target) {
                return current;
            }
        }
        if (TransactionSynchronizationManager.isSynchronizationActive()
                && TransactionSynchronizationManager.isActualTransactionActive()) {
            Holder holder = (Holder) TransactionSynchronizationManager.getResource(SPRING_RESOURCE);
            if (holder == null) {
                holder = new Holder();
                TransactionSynchronizationManager.bindResource(SPRING_RESOURCE, holder);
                TransactionSynchronizationManager.registerSynchronization(holder);
            }
            return holder.scopes.computeIfAbsent(target, key -> new Scope(key, null));
        }
        return null;
    }

    private static void acquireMutex(Connection connection, String mutex, int timeoutSeconds)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT GET_LOCK(?, ?)")) {
            statement.setQueryTimeout(timeoutSeconds);
            statement.setString(1, mutex);
            statement.setInt(2, timeoutSeconds == 0 ? -1 : timeoutSeconds);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next() || result.getObject(1) == null) {
                    throw new SQLException("Tenant guard bootstrap lock is unavailable");
                }
                if (result.getInt(1) != 1) {
                    throw new SQLTimeoutException("Tenant guard bootstrap lock timed out", "HY000", 1205);
                }
            }
        }
    }

    private static void releaseMutex(Connection connection, String mutex) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT RELEASE_LOCK(?)")) {
            statement.setQueryTimeout(10);
            statement.setString(1, mutex);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next() || result.getInt(1) != 1 || result.wasNull()) {
                    throw new SQLException("Tenant guard bootstrap lock was not released");
                }
            }
        } catch (SQLException failure) {
            try {
                connection.abort(Runnable::run);
            } catch (SQLException | RuntimeException abortFailure) {
                failure.addSuppressed(abortFailure);
            }
            throw failure;
        }
    }

    public static final class Scope implements AutoCloseable {
        private final Connection connection;
        private final Scope previous;
        private final Set<String> mutexes = new LinkedHashSet<>();
        private final Map<GuardKey, Long> identities = new HashMap<>();

        private Scope(Connection connection, Scope previous) {
            this.connection = connection;
            this.previous = previous;
        }

        @Override
        public void close() throws SQLException {
            try {
                for (String mutex : mutexes) {
                    releaseMutex(connection, mutex);
                }
            } finally {
                mutexes.clear();
                identities.clear();
                if (LOCAL_SCOPE.get() == this) {
                    if (previous == null) {
                        LOCAL_SCOPE.remove();
                    } else {
                        LOCAL_SCOPE.set(previous);
                    }
                }
            }
        }
    }

    private record GuardKey(String tenant, GuardDomain domain) {}

    private static final class Holder implements TransactionSynchronization {
        private final Map<Connection, Scope> scopes = new IdentityHashMap<>();

        @Override
        public void suspend() {
            TransactionSynchronizationManager.unbindResource(SPRING_RESOURCE);
        }

        @Override
        public void resume() {
            TransactionSynchronizationManager.bindResource(SPRING_RESOURCE, this);
        }

        @Override
        public void afterCompletion(int status) {
            TransactionSynchronizationManager.unbindResourceIfPossible(SPRING_RESOURCE);
            RuntimeException failure = null;
            for (Scope scope : scopes.values()) {
                try {
                    scope.close();
                } catch (SQLException closeFailure) {
                    if (failure == null) {
                        failure = new IllegalStateException("Tenant guard bootstrap cleanup failed", closeFailure);
                    } else {
                        failure.addSuppressed(closeFailure);
                    }
                }
            }
            scopes.clear();
            if (failure != null) {
                throw failure;
            }
        }
    }
}
