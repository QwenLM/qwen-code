package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.host.WorkspaceFileProcess;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.spy;

class WorkspaceReadScopeMySqlIT extends WorkspaceFileStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource source() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }

    @ParameterizedTest
    @CsvSource({"query, workspace", "query, grant", "read, workspace", "read, grant",
        "directory, workspace", "directory, grant", "worktree, workspace", "worktree, grant"})
    @Timeout(30)
    void readPreflightDoesNotWaitForMetadataWriter(String route, String metadata) throws Exception {
        try (var writer = database.source().getConnection(); var pool = Executors.newSingleThreadExecutor()) {
            writer.setAutoCommit(false);
            String table = "workspace".equals(metadata) ? "ma_workspace" : "ma_workspace_access";
            String change = "workspace".equals(metadata) ? "display_name = 'pending'" : "role = 'READER'";
            try (var statement = writer.prepareStatement("UPDATE " + table + " SET " + change
                    + " WHERE tenant_id = ? AND workspace_id = ?")) {
                statement.setBytes(1, "tenant".getBytes(StandardCharsets.UTF_8));
                statement.setBytes(2, workspace.getBytes(StandardCharsets.UTF_8));
                assertThat(statement.executeUpdate()).isEqualTo(1);
            }
            var reader = pool.submit(() -> readRoute(route));
            try {
                await().atMost(Duration.ofSeconds(5)).until(() -> reader.isDone() || metadataWaits() > 0);
                boolean blocked = metadataWaits() > 0;
                System.out.println("WORKSPACE_READ_PROBE route=" + route + " metadata=" + metadata + " blocked=" + blocked);
                writer.rollback();
                reader.get(5, TimeUnit.SECONDS);
                assertThat(blocked).as("%s reads committed metadata while %s update is open", route, metadata).isFalse();
            } finally {
                writer.rollback();
            }
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"query", "read", "scope", "directory", "worktree"})
    void readEntryPointsRejectAnAmbientOldSnapshotBeforeIo(String route) {
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        transaction.setIsolationLevel(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            transaction.executeWithoutResult(status -> {
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isOne();
                assertThatThrownBy(() -> {
                    switch (route) {
                        case "query" -> query();
                        case "read" -> files.read("tenant", "actor", workspace, ".", "a.txt", null);
                        case "scope" -> files.readScope("tenant", "actor", new WorkspaceFileStore.Locator(null, workspace, "."));
                        case "directory" -> creation().directories("tenant", "actor", workspace, ".");
                        case "worktree" -> new JdbcSessionWorktreeStore(jdbc, registry, guard)
                                .source("tenant", "actor", new WorkspaceSelection(workspace, "."));
                        default -> throw new AssertionError(route);
                    }
                }).isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
            });
            process.verifyNoInteractions();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"revoke", "operator", "generation", "config", "kind", "fence"})
    void directoryPostcheckRejectsChangesAcrossEnumeration(String change) {
        var observedGuard = spy(guard);
        var changed = new AtomicBoolean();
        doAnswer(call -> {
            var root = call.callRealMethod();
            if (!TransactionSynchronizationManager.isActualTransactionActive() && changed.compareAndSet(false, true)) {
                switch (change) {
                    case "revoke" -> jdbc.update("DELETE FROM ma_workspace_access");
                    case "operator" -> jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'");
                    case "generation" -> jdbc.update("UPDATE ma_workspace SET workspace_generation = workspace_generation + 1");
                    case "config" -> jdbc.update("UPDATE ma_workspace SET config_ref = 'changed'");
                    case "kind" -> jdbc.update("UPDATE ma_workspace SET is_default = 0, workspace_kind = 'CHILD_GIT', parent_workspace_id = ?", workspace);
                    case "fence" -> jdbc.update("UPDATE ma_storage SET fence_operation_id = 'migration'");
                    default -> throw new AssertionError(change);
                }
            }
            return root;
        }).when(observedGuard).verifiedRoot(any());
        var directories = new WorkspaceCreationStore(jdbc, new DataSourceTransactionManager(database.source()),
                observedGuard, registry, properties, new ObjectMapper(), Clock.systemUTC());
        var failure = assertThatThrownBy(() -> directories.directories("tenant", "actor", workspace, "."));
        if ("revoke".equals(change) || "operator".equals(change) || "kind".equals(change)) {
            failure.isInstanceOfSatisfying(ManagedAgentException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_not_found"));
        } else {
            failure.isInstanceOfSatisfying(RuntimeBrokerException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        }
        assertThat(changed).isTrue();
    }

    @ParameterizedTest
    @CsvSource({"OWNER, OPERATOR, false", "OPERATOR, OWNER, true"})
    void ownerAdmissionUsesTheLockedGrantAfterAnOlderOrdinaryView(String before, String after, boolean allowed) {
        jdbc.update("UPDATE ma_workspace_access SET role = ?", before);
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        transaction.setIsolationLevel(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
        try (var pool = Executors.newSingleThreadExecutor()) {
            transaction.executeWithoutResult(status -> {
                assertThat(jdbc.queryForObject("SELECT role FROM ma_workspace_access", String.class)).isEqualTo(before);
                CompletableFuture.runAsync(() -> jdbc.update("UPDATE ma_workspace_access SET role = ?", after), pool).join();
                if (allowed) {
                    assertThat(registry.resolveOwnedDirectory("tenant", "actor", workspace, ".").binding().getWorkspaceId())
                            .isEqualTo(workspace);
                } else {
                    assertThatThrownBy(() -> registry.resolveOwnedDirectory("tenant", "actor", workspace, "."))
                            .isInstanceOfSatisfying(ManagedAgentException.class,
                                    error -> assertThat(error.getCode()).isEqualTo("workspace_not_found"));
                }
            });
        }
    }

    @Test
    void ownerAdmissionUsesTheLockedKindAfterAnOlderOrdinaryView() {
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        transaction.setIsolationLevel(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
        try (var pool = Executors.newSingleThreadExecutor()) {
            transaction.executeWithoutResult(status -> {
                assertThat(jdbc.queryForObject("SELECT workspace_kind FROM ma_workspace", String.class)).isEqualTo("ROOT");
                CompletableFuture.runAsync(() -> jdbc.update("UPDATE ma_workspace SET is_default = 0,"
                        + " workspace_kind = 'CHILD_GIT', parent_workspace_id = ?", workspace), pool).join();
                assertThatThrownBy(() -> registry.resolveOwnedDirectory("tenant", "actor", workspace, "."))
                        .isInstanceOfSatisfying(ManagedAgentException.class,
                                error -> assertThat(error.getCode()).isEqualTo("workspace_not_found"));
            });
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"workspace", "grant"})
    @Timeout(30)
    void uploadPreflightReadsTheBodyButFinalAdmissionWaitsForMetadata(String metadata) throws Exception {
        var uploads = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new WorkspaceFileUploadStore(
                files, registry, guard, ssh, properties, jdbc, new DataSourceTransactionManager(database.source()),
                new ObjectMapper(), Runnable::run));
        String revision = files.readScope("tenant", "actor", new WorkspaceFileStore.Locator(null, workspace, ".")).revision();
        var bodyRead = new CountDownLatch(1);
        var input = new ByteArrayInputStream(new byte[] {1}) {
            @Override
            public byte[] readNBytes(int length) {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                bodyRead.countDown();
                return new byte[] {1};
            }
        };
        try (var writer = database.source().getConnection(); var pool = Executors.newSingleThreadExecutor()) {
            writer.setAutoCommit(false);
            String sql = "workspace".equals(metadata)
                    ? "UPDATE ma_workspace SET workspace_generation = workspace_generation + 1 WHERE tenant_id = ? AND workspace_id = ?"
                    : "UPDATE ma_workspace_access SET role = 'READER' WHERE tenant_id = ? AND workspace_id = ?";
            try (var statement = writer.prepareStatement(sql)) {
                statement.setBytes(1, "tenant".getBytes(StandardCharsets.UTF_8));
                statement.setBytes(2, workspace.getBytes(StandardCharsets.UTF_8));
                assertThat(statement.executeUpdate()).isOne();
            }
            var upload = pool.submit(() -> {
                try (var process = mockStatic(WorkspaceFileProcess.class)) {
                    process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                            .thenThrow(new AssertionError("Final admission must reject before file I/O"));
                    return uploads.upload("tenant", "actor", workspace, ".", "a.txt", revision,
                            UUID.randomUUID().toString(), input, 1);
                }
            });
            try {
                assertThat(bodyRead.await(5, TimeUnit.SECONDS)).isTrue();
                await().atMost(Duration.ofSeconds(5)).until(() -> metadataWaits() > 0);
                assertThat(upload).isNotDone();
                writer.commit();
                assertThatThrownBy(() -> upload.get(5, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class).hasCauseInstanceOf(ManagedAgentException.class)
                        .satisfies(error -> assertThat(((ManagedAgentException) error.getCause()).getCode())
                                .isEqualTo("workspace".equals(metadata) ? "workspace_file_scope_changed" : "workspace_forbidden"));
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", Integer.class)).isZero();
            } finally {
                writer.rollback();
            }
        }
    }

    @Test
    @Timeout(30)
    void worktreeSourceDoesNotWaitForThePlacementGuard() throws Exception {
        try (var writer = database.source().getConnection(); var pool = Executors.newSingleThreadExecutor()) {
            writer.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(writer, "tenant");
            try {
                var source = pool.submit(() -> new JdbcSessionWorktreeStore(jdbc, registry, guard)
                        .source("tenant", "actor", new WorkspaceSelection(workspace, ".")));
                assertThat(source.get(5, TimeUnit.SECONDS).resolved().binding().getWorkspaceId()).isEqualTo(workspace);
            } finally {
                writer.rollback();
            }
        }
    }

    private void readRoute(String route) {
        if ("directory".equals(route)) {
            assertThat(creation().directories("tenant", "actor", workspace, ".").directories())
                    .extracting(WorkspaceCreationStore.Directory::name).containsExactly("src");
        } else if ("worktree".equals(route)) {
            var source = new JdbcSessionWorktreeStore(jdbc, registry, guard)
                    .source("tenant", "actor", new WorkspaceSelection(workspace, "."));
            assertThat(source.resolved().binding().getWorkspaceId()).isEqualTo(workspace);
        } else {
            try (var process = mockStatic(WorkspaceFileProcess.class)) {
                process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                    assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                    return "query".equals(route) ? result() : Map.of("files", Map.of("protocolVersion", 1,
                            "path", "a.txt", "name", "a.txt", "text", "fresh", "sha256", DigestUtils.sha256Hex("fresh")));
                });
                if ("query".equals(route)) {
                    assertThat(query().entries()).extracting(WorkspaceFileStore.Entry::path).containsExactly("a.txt");
                } else {
                    assertThat(files.read("tenant", "actor", workspace, ".", "a.txt", null).text()).isEqualTo("fresh");
                }
            }
        }
    }

    private WorkspaceCreationStore creation() {
        return new WorkspaceCreationStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()),
                guard, registry, properties, new ObjectMapper(), Clock.systemUTC());
    }

    private long metadataWaits() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM sys.innodb_lock_waits"
                + " WHERE locked_table LIKE CONCAT('%', DATABASE(), '%') AND locked_table LIKE '%ma_workspace%'", Long.class);
    }
}
