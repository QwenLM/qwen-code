package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit;
import com.alibaba.qwen.code.managedagent.adapters.workspace.SessionWorktreeGit;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.host.WorkspaceFileProcess;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.spy;

class WorkspaceStorageReadScopeMySqlIT extends WorkspaceFileStoreTest {
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
    @CsvSource({"query, alias, SHARE", "query, owner, SHARE", "read, alias, SHARE", "read, owner, SHARE",
        "source, alias, SHARE", "source, owner, SHARE", "query, alias, UPDATE", "query, owner, UPDATE",
        "read, alias, UPDATE", "read, owner, UPDATE", "source, alias, UPDATE", "source, owner, UPDATE"})
    @Timeout(30)
    void readsDoNotWaitForAnotherStorageReader(String route, String storageRow, String lockMode) throws Exception {
        var binding = files.readScope("tenant", "actor", new WorkspaceFileStore.Locator(null, workspace, ".")).binding();
        String alias = JdbcRuntimeBindingRepository.storageAliasKey("tenant", binding.getStorageId());
        String physical = jdbc.queryForObject("SELECT physical_key FROM ma_storage WHERE alias_key = ?", String.class, alias);
        Path root = Path.of(guard.fileRoot(binding).get("root"));
        String cwd = ".qwen-managed-worktrees/owned/src";
        Files.createDirectories(root.resolve(cwd));
        var identity = Files.readAttributes(root.resolve(".qwen-managed-worktrees/owned"), "unix:dev,ino");
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified,"
                        + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref, workspace_policy_ref, owner_actor_key)"
                        + " SELECT tenant_id, 'session', 'agent', 0, 0, workspace_id, workspace_generation, storage_id,"
                        + " ?, ?, 7, config_ref, policy_ref, ? FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                cwd, binding.getContextConfigRef(),
                ManagedWorkspaceRegistry.actorKey("tenant", "actor"),
                "tenant", workspace);
        try (var holder = database.source().getConnection(); var pool = Executors.newSingleThreadExecutor()) {
            holder.setAutoCommit(false);
            String sql = ("alias".equals(storageRow) ? "SELECT alias_key FROM ma_storage WHERE alias_key = ?"
                    : "SELECT storage_key FROM ma_storage_owner WHERE storage_key = ?") + " FOR " + lockMode;
            try (var statement = holder.prepareStatement(sql)) {
                statement.setString(1, "alias".equals(storageRow) ? alias : physical);
                try (var rows = statement.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.next()).isFalse();
                }
            }
            var reader = pool.submit(() -> readRoute(route, root, cwd, identity));
            try {
                await().atMost(Duration.ofSeconds(5)).until(() -> reader.isDone() || !storageWaits().isEmpty());
                var waits = storageWaits();
                System.out.println("WORKSPACE_STORAGE_READ_PROBE route=" + route + " storage=" + storageRow + " holder=" + lockMode + " waits=" + waits);
                holder.rollback();
                reader.get(5, TimeUnit.SECONDS);
                assertThat(waits).as("%s does not request storage locks behind another %s reader holding %s", route, storageRow, lockMode).isEmpty();
            } finally {
                holder.rollback();
            }
        }
    }

    @ParameterizedTest
    @CsvSource({"query, grant, session_not_found", "read, grant, session_not_found",
        "query, session, workspace_file_scope_changed", "read, session, workspace_file_scope_changed",
        "query, worktree, workspace_file_scope_changed", "read, worktree, workspace_file_scope_changed",
        "query, alias, workspace_file_scope_changed", "read, alias, workspace_file_scope_changed",
        "query, fence, workspace_unavailable", "read, fence, workspace_unavailable",
        "query, owner, workspace_file_scope_changed", "read, owner, workspace_file_scope_changed",
        "query, registration, workspace_unavailable", "read, registration, workspace_unavailable",
        "query, state, workspace_unavailable", "read, state, workspace_unavailable",
        "query, directory, worktree_identity_conflict", "read, directory, worktree_identity_conflict"})
    void sessionWorktreePostcheckRejectsChangesDuringIo(String route, String change, String expected) throws Exception {
        var store = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new JdbcSessionWorktreeStore(jdbc, registry, guard));
        var location = store.source("tenant", "actor", new WorkspaceSelection(workspace, "src"));
        Plan plan = plan(location);
        var binding = location.resolved().binding();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified,"
                        + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref, workspace_policy_ref, owner_actor_key)"
                        + " SELECT tenant_id, 'session', 'agent', 0, 0, workspace_id, workspace_generation, storage_id,"
                        + " ?, ?, 7, config_ref, policy_ref, ? FROM ma_workspace WHERE workspace_id = ?",
                plan.cwdRelative(), binding.getContextConfigRef(),
                ManagedWorkspaceRegistry.actorKey("tenant", "actor"), workspace);
        new TransactionTemplate(new DataSourceTransactionManager(database.source())).executeWithoutResult(status ->
                store.admit("tenant", "actor", "session", plan, location.resolved()));
        try (var git = new SessionWorktreeGit(new ChildWorktreeGit("git", Duration.ofSeconds(10)))) {
            var claim = store.claim(store.due().getFirst(), "worker", 120000);
            assertThat(store.complete(claim, "worker", "READY", git.prepare(plan), null)).isTrue();
        }
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                if ("directory".equals(change)) {
                    Path target = location.root().resolve(plan.worktreeRoot());
                    Files.move(target, target.resolveSibling("saved"));
                    Files.createDirectory(target);
                } else {
                    change(change, location.root());
                }
                return fileResult(route);
            });
            var locator = new WorkspaceFileStore.Locator("session", null, null);
            assertThatThrownBy(() -> {
                if ("query".equals(route)) {
                    files.query("tenant", "actor", locator, ".", "", null);
                } else {
                    files.read("tenant", "actor", locator, "a.txt", null);
                }
            }).satisfies(error -> assertThat(code(error)).isEqualTo(expected));
            if ("directory".equals(change)) {
                assertThat(store.describe("tenant", "session").state()).isEqualTo("blocked");
            }
        }
    }

    @ParameterizedTest
    @CsvSource({"grant, workspace_not_found", "generation, worktree_source_changed",
        "alias, worktree_source_changed", "fence, workspace_unavailable", "owner, worktree_source_changed",
        "registration, workspace_unavailable", "state, workspace_unavailable", "root, workspace_unavailable"})
    @Timeout(15)
    void sourcePostcheckUsesANewSnapshotAfterConcurrentChange(String change, String expected) {
        var observed = spy(guard);
        var changed = new AtomicBoolean();
        try (var pool = Executors.newSingleThreadExecutor()) {
            doAnswer(call -> {
                Path root = (Path) call.callRealMethod();
                if (changed.compareAndSet(false, true)) {
                    assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
                    CompletableFuture.runAsync(() -> change(change, root), pool).get(5, TimeUnit.SECONDS);
                }
                return root;
            }).when(observed).verifiedRootForRead(any());
            assertThatThrownBy(() -> new JdbcSessionWorktreeStore(jdbc, registry, observed)
                    .source("tenant", "actor", new WorkspaceSelection(workspace, ".")))
                    .satisfies(error -> assertThat(code(error)).isEqualTo(expected));
            assertThat(changed).isTrue();
        }
    }

    @ParameterizedTest
    @CsvSource({"upload, alias", "upload, owner", "worktree, alias", "worktree, owner"})
    @Timeout(30)
    void durableAdmissionWaitsForStorageMutationAndRejectsItsCommittedState(String route, String storageRow) throws Exception {
        var store = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new JdbcSessionWorktreeStore(jdbc, registry, guard));
        var location = store.source("tenant", "actor", new WorkspaceSelection(workspace, "src"));
        Plan plan = plan(location);
        var uploads = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new WorkspaceFileUploadStore(
                files, registry, guard, ssh, properties, jdbc, new DataSourceTransactionManager(database.source()),
                new ObjectMapper(), Runnable::run));
        String revision = files.readScope("tenant", "actor", new WorkspaceFileStore.Locator(null, workspace, ".")).revision();
        try (var writer = database.source().getConnection(); var pool = Executors.newSingleThreadExecutor()) {
            writer.setAutoCommit(false);
            String sql = "alias".equals(storageRow) ? "UPDATE ma_storage SET registration_revision = registration_revision + 1"
                    : "UPDATE ma_storage_owner SET mount_revision = mount_revision + 1";
            try (var statement = writer.prepareStatement(sql)) {
                assertThat(statement.executeUpdate()).isOne();
            }
            var admission = pool.submit(() -> {
                if ("worktree".equals(route)) {
                    new TransactionTemplate(new DataSourceTransactionManager(database.source())).executeWithoutResult(status -> {
                        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                                + " VALUES ('tenant','admitted','agent',1,1)");
                        store.admit("tenant", "actor", "admitted", plan, location.resolved());
                    });
                } else {
                    try (var process = mockStatic(WorkspaceFileProcess.class)) {
                        process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                                .thenThrow(new AssertionError("Invalid final admission must precede file I/O"));
                        uploads.upload("tenant", "actor", workspace, ".", "a.txt", revision,
                                UUID.randomUUID().toString(), new ByteArrayInputStream(new byte[] {1}), 1);
                    }
                }
            });
            try {
                await().atMost(Duration.ofSeconds(5)).until(() -> !storageWaits().isEmpty());
                System.out.println("WORKSPACE_STORAGE_ADMISSION_PROBE route=" + route + " storage=" + storageRow + " waits=" + storageWaits());
                assertThat(admission).isNotDone();
                writer.commit();
                assertThatThrownBy(() -> admission.get(5, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .satisfies(error -> assertThat(code(error.getCause()))
                                .isEqualTo("worktree".equals(route) ? "worktree_source_changed" : "workspace_file_scope_changed"));
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind IN"
                        + " ('WORKSPACE_UPLOAD','SESSION_WORKTREE')", Integer.class)).isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_worktree", Integer.class)).isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE session_id = 'admitted'", Integer.class)).isZero();
            } finally {
                writer.rollback();
            }
        }
    }

    private Plan plan(JdbcSessionWorktreeStore.SourceLocation location) throws Exception {
        var binding = location.resolved().binding();
        Path repository = location.root().resolve(binding.getCwdRelative());
        git(repository, "init", "-b", "main");
        Files.writeString(repository.resolve("a.txt"), "fresh");
        git(repository, "add", ".");
        git(repository, "commit", "-m", "base");
        try (var git = new SessionWorktreeGit(new ChildWorktreeGit("git", Duration.ofSeconds(10)))) {
            var source = git.source(location.root(), binding.getCwdRelative(), null);
            String cwd = SessionWorktreeGit.CONTAINER + "/owned";
            return new Plan("tenant", workspace, binding.getWorkspaceGeneration(), binding.getStorageId(), binding.getCwdRelative(),
                    binding.getContextConfigRef(), binding.getContextRevision(), location.root().toString(),
                    SessionWorktreeGit.identity(location.root()), source.repositoryRelative(), source.offset(),
                    source.commonDirectory(), source.commonIdentity(), null, source.commit(), "owned", cwd, cwd,
                    "managed-owned", location.storageIdentity());
        }
    }

    private void change(String change, Path root) {
        switch (change) {
            case "grant" -> jdbc.update("DELETE FROM ma_workspace_access");
            case "session" -> jdbc.update("UPDATE ma_session SET context_revision = context_revision + 1");
            case "worktree" -> jdbc.update("UPDATE ma_session_worktree SET revision = revision + 1");
            case "generation" -> jdbc.update("UPDATE ma_workspace SET workspace_generation = workspace_generation + 1");
            case "alias" -> jdbc.update("UPDATE ma_storage SET registration_revision = registration_revision + 1");
            case "fence" -> jdbc.update("UPDATE ma_storage SET fence_operation_id = 'migration'");
            case "owner" -> jdbc.update("UPDATE ma_storage_owner SET mount_revision = mount_revision + 1");
            case "registration" -> jdbc.update("UPDATE ma_storage_owner SET mount_registration_id = 'replacement'");
            case "state" -> jdbc.update("UPDATE ma_storage_owner SET mount_state = 'FENCED', mount_operation_id = 'migration'");
            case "root" -> {
                try {
                    Files.move(root, root.resolveSibling("saved-root"));
                    Files.createDirectory(root);
                } catch (IOException error) {
                    throw new UncheckedIOException(error);
                }
            }
            default -> throw new AssertionError(change);
        }
    }

    private Map<String, Object> fileResult(String route) {
        return "query".equals(route) ? result() : Map.of("files", Map.of("protocolVersion", 1,
                "path", "a.txt", "name", "a.txt", "text", "fresh", "sha256", DigestUtils.sha256Hex("fresh")));
    }

    private static String code(Throwable error) {
        if (error instanceof ManagedAgentException managed) {
            return managed.getCode();
        }
        if (error instanceof RuntimeBrokerException broker) {
            return broker.getCode();
        }
        throw new AssertionError("Expected a scoped domain refusal", error);
    }

    private static void git(Path directory, String... arguments) throws Exception {
        var command = new ArrayList<>(List.of("git", "-C", directory.toString(), "-c", "user.name=Test",
                "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null"));
        command.addAll(List.of(arguments));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as(new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)).isZero();
    }

    private void readRoute(String route, Path root, String cwd, Map<String, Object> identity) {
        if ("source".equals(route)) {
            var source = new JdbcSessionWorktreeStore(jdbc, registry, guard)
                    .source("tenant", "actor", new WorkspaceSelection(workspace, "."));
            assertThat(source.resolved().binding().getWorkspaceId()).isEqualTo(workspace);
            assertThat(source.root()).isEqualTo(root);
            return;
        }
        var locator = new WorkspaceFileStore.Locator("session", null, null);
        try (var worktrees = mockStatic(JdbcSessionWorktreeStore.class); var process = mockStatic(WorkspaceFileProcess.class)) {
            worktrees.when(() -> JdbcSessionWorktreeStore.descriptor(any(WorktreeFiles.class), eq(jdbc), eq("tenant"), eq("session")))
                    .thenReturn(new JdbcSessionWorktreeStore.Descriptor("owned", "session", workspace, "ready", "branch",
                            "a".repeat(40), cwd, "op", 2, null));
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                Map<String, Object> request = call.getArgument(2);
                var proof = (Map<?, ?>) request.get("sessionFileScope");
                assertThat(proof.get("sessionId")).isEqualTo("session");
                assertThat(proof.get("worktreeRevision")).isEqualTo(2L);
                assertThat(proof.get("worktreeRootIdentity")).isEqualTo(Map.of(
                        "device", identity.get("dev").toString(), "inode", identity.get("ino").toString()));
                return "query".equals(route) ? result() : Map.of("files", Map.of("protocolVersion", 1,
                        "path", "a.txt", "name", "a.txt", "text", "fresh", "sha256", DigestUtils.sha256Hex("fresh")));
            });
            if ("query".equals(route)) {
                assertThat(files.query("tenant", "actor", locator, ".", "", null).entries())
                        .extracting(WorkspaceFileStore.Entry::path).containsExactly("a.txt");
            } else {
                assertThat(files.read("tenant", "actor", locator, "a.txt", null).text()).isEqualTo("fresh");
            }
        }
    }

    private List<Map<String, Object>> storageWaits() {
        return jdbc.queryForList("SELECT l.OBJECT_NAME AS object_name, l.INDEX_NAME AS index_name,"
                + " l.LOCK_MODE AS waiting_mode, b.LOCK_MODE AS blocking_mode FROM performance_schema.data_lock_waits w"
                + " JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID"
                + " JOIN performance_schema.data_locks b ON b.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID"
                + " WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME IN ('ma_storage', 'ma_storage_owner')");
    }
}
