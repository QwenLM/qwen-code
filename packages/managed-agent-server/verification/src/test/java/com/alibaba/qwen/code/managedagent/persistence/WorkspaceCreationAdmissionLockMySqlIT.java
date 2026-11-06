package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import javax.sql.DataSource;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

class WorkspaceCreationAdmissionLockMySqlIT extends WorkspaceCreationAdmissionLockTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    @Timeout(30)
    void explicitResolutionAllowsUpdatingAnUnselectedWorkspace() throws Exception {
        var resolved = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var observer = new JdbcTemplate(source);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var admission = pool.submit(() -> transactions.execute(status -> {
                WorkspaceLifecycleStore.lockPlacement(jdbc, "tenant");
                var selected = registry.resolveForCreation("tenant", "actor", new WorkspaceSelection("chosen", "."));
                assertThat(selected.binding().getWorkspaceId()).isEqualTo("chosen");
                resolved.countDown();
                try {
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
                return selected;
            }));
            try {
                assertThat(resolved.await(5, TimeUnit.SECONDS)).isTrue();
                var update = pool.submit(() -> observer.update("UPDATE ma_workspace SET display_name = 'changed'"
                        + " WHERE tenant_id = 'tenant' AND workspace_id = 'unselected'"));
                await().atMost(Duration.ofSeconds(5)).until(() -> update.isDone() || workspaceWaits(observer) > 0);
                boolean blocked = workspaceWaits(observer) > 0;
                System.out.println("WORKSPACE_ADMISSION_PROBE unselected_workspace_update_blocked=" + blocked
                        + " locks=" + observer.queryForList("SELECT OBJECT_NAME, INDEX_NAME, LOCK_TYPE, LOCK_MODE, LOCK_DATA"
                        + " FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = DATABASE()"
                        + " AND OBJECT_NAME IN ('ma_workspace', 'ma_workspace_access')"));
                release.countDown();
                assertThat(update.get(5, TimeUnit.SECONDS)).isEqualTo(1);
                admission.get(5, TimeUnit.SECONDS);
                assertThat(blocked).as("explicit admission locks only its selected Workspace").isFalse();
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    @Timeout(30)
    void defaultSwitchAfterMetadataUpdateDoesNotDeadlockAdmission() throws Exception {
        var observer = new JdbcTemplate(source);
        try (var connection = source.getConnection(); var pool = Executors.newSingleThreadExecutor()) {
            connection.setAutoCommit(false);
            var administrator = new JdbcTemplate(new SingleConnectionDataSource(connection, true));
            assertThat(administrator.update("UPDATE ma_workspace SET display_name = 'changed'"
                    + " WHERE tenant_id = 'tenant' AND workspace_id = 'chosen'")).isEqualTo(1);
            var admission = pool.submit(() -> transactions.execute(status -> registry.resolveForCreation("tenant", "actor", null)));
            try {
                await().atMost(Duration.ofSeconds(5)).until(() -> admission.isDone() || workspaceWaits(observer) > 0);
                assertThat(admission.isDone()).as("admission waits for the administrator's Workspace row lock").isFalse();
                assertThat(workspaceWaits(observer)).isPositive();
                assertThat(administrator.update("UPDATE ma_workspace SET is_default = FALSE"
                        + " WHERE tenant_id = 'tenant' AND workspace_id = 'chosen'")).isEqualTo(1);
                assertThat(administrator.update("UPDATE ma_workspace SET is_default = TRUE"
                        + " WHERE tenant_id = 'tenant' AND workspace_id = 'unselected'")).isEqualTo(1);
                connection.commit();
                assertThat(admission.get(5, TimeUnit.SECONDS).binding().getWorkspaceId()).isEqualTo("unselected");
            } finally {
                connection.rollback();
            }
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"default", "grant", "inactive", "registration"})
    @Timeout(30)
    void selectedWorkspaceAndGrantChangesWaitForAdmissionToCommit(String mutation) throws Exception {
        var resolved = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var observer = new JdbcTemplate(source);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var admission = pool.submit(() -> transactions.executeWithoutResult(status -> {
                WorkspaceLifecycleStore.lockPlacement(jdbc, "tenant");
                var selected = registry.resolveForCreation("tenant", "actor", null).binding();
                assertThat(selected.getWorkspaceId()).isEqualTo("chosen");
                assertThat(selected.getWorkspaceGeneration()).isEqualTo(1);
                resolved.countDown();
                try {
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            }));
            try {
                assertThat(resolved.await(5, TimeUnit.SECONDS)).isTrue();
                var update = pool.submit(() -> mutateOutsideAdmission(mutation));
                await().atMost(Duration.ofSeconds(5)).until(() -> workspaceWaits(observer) > 0);
                assertThat(update.isDone()).as("selected state remains stable until admission commits: %s", mutation).isFalse();
                release.countDown();
                admission.get(5, TimeUnit.SECONDS);
                update.get(5, TimeUnit.SECONDS);
                transactions.executeWithoutResult(status -> assertCurrentResolution(mutation));
            } finally {
                release.countDown();
            }
        }
    }

    private static long workspaceWaits(JdbcTemplate observer) {
        return observer.queryForObject("SELECT COUNT(*) FROM sys.innodb_lock_waits"
                + " WHERE locked_table LIKE '%ma_workspace%'", Long.class);
    }
}
