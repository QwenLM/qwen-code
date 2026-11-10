package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.repository.SshWorkspaceStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class SshWorkspaceMySqlIT extends SshWorkspaceStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    DataSource source() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        var source = database.source();
        Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load().migrate();
        assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(1);
        return source;
    }

    @ParameterizedTest
    @ValueSource(strings = {"complete", "completeParked", "releaseParked"})
    void settlementDoesNotWaitForTenantOrUnrelatedOwner(String settlement) throws Exception {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "owner");
        store.reserve(intent, "owner", registration(intent));
        if (!"complete".equals(settlement)) {
            store.fail(intent, "owner", "ssh_runtime_identity_mismatch", false);
        }
        var other = store.begin("tenant", "actor", "other", "mac", "/work/other", "Other");
        var otherIntent = store.claim("tenant", "actor", other.operationId(), "other");
        store.reserve(otherIntent, "other", registration(otherIntent, "/work/other", "9"));
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var locked = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var blocker = executor.submit(() -> transaction.executeWithoutResult(status -> {
                WorkspaceStorageKindGuard.lockDomain(jdbc, "tenant");
                jdbc.queryForList("SELECT storage_key FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE",
                        JdbcSshWorkspaceStore.physicalKey(SshWorkspaceStore
                                .object(registration(otherIntent, "/work/other", "9"), "identity")));
                locked.countDown();
                try {
                    assertThat(release.await(15, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    throw new IllegalStateException(error);
                }
            }));
            try {
                assertThat(locked.await(5, TimeUnit.SECONDS)).isTrue();
                executor.submit(() -> {
                    switch (settlement) {
                        case "complete" -> store.complete(intent, "owner");
                        case "completeParked" -> assertThat(store.completeParked("tenant", intent.operationId())).isTrue();
                        default -> assertThat(store.releaseParked("tenant", intent.operationId(), "stopped")).isTrue();
                    }
                }).get(5, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
            blocker.get(5, TimeUnit.SECONDS);
        }
        assertThat(store.get("tenant", "actor", intent.operationId()).status())
                .isEqualTo("releaseParked".equals(settlement) ? "failed" : "completed");
    }

    @Test
    void concurrentSettlementHasOneReservationOutcome() throws Exception {
        var intent = parkedReservation();
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var completed = executor.submit(() -> {
                start.await();
                return store.completeParked("tenant", intent.operationId());
            });
            var released = executor.submit(() -> {
                start.await();
                return store.releaseParked("tenant", intent.operationId(), "stopped");
            });
            start.countDown();
            assertThat(List.of(completed.get(5, TimeUnit.SECONDS), released.get(5, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(true, false);
        }
        int count = "completed".equals(store.get("tenant", "actor", intent.operationId()).status()) ? 1 : 0;
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(count);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isEqualTo(count);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(count);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE mount_state = 'READY'", Integer.class)).isEqualTo(count);
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
