package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import javax.sql.DataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.verifyNoInteractions;

class WorkspaceFileStoreTest {
    @TempDir
    Path temp;
    JdbcTemplate jdbc;
    WorkspaceFileStore files;
    WorkspaceStorageGuard guard;
    ManagedWorkspaceRegistry registry;
    SshWorkspaceService ssh;
    ManagedAgentProperties properties;
    String workspace;

    protected DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:files-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @BeforeEach
    void setUp() throws Exception {
        var source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setWorkspaceCreationRoot(Files.createDirectory(temp.resolve("created")).toRealPath().toString());
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        var manager = new DataSourceTransactionManager(source);
        registry = new ManagedWorkspaceRegistry(jdbc);
        guard = new WorkspaceStorageGuard(jdbc, manager, properties,
                path -> new StorageIdentityReader.Identity(path.toString(), "test-host", "1", "2", "2026-10-15T00:00:00.123456789Z"));
        var mapper = new ObjectMapper();
        workspace = new WorkspaceCreationStore(jdbc, manager, guard, registry, properties, mapper, Clock.systemUTC())
                .create("tenant", "actor", "Files", "create").workspaceId();
        ssh = mock(SshWorkspaceService.class);
        files = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new WorkspaceFileStore(registry, guard, ssh, properties, jdbc, manager, mapper));
        Files.createDirectory(Path.of(guard.fileRoot(files.scope("tenant", "actor", workspace, ".").binding()).get("root")).resolve("src"));
    }

    Map<String, Object> result() {
        return Map.of("files", Map.of("protocolVersion", 1, "entries", java.util.List.of(
                Map.of("path", "a.txt", "name", "a.txt", "kind", "file")), "truncated", false));
    }

    WorkspaceFileStore.QueryResult query() {
        return files.query("tenant", "actor", workspace, ".", ".", "", null);
    }

    private WorkspaceFileStore.Locator session(String id) {
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified, workspace_id, workspace_generation,"
                + " workspace_storage_id, cwd_relative, context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref, owner_actor_key)"
                + " SELECT tenant_id, ?, ?, 0, 0, workspace_id, workspace_generation, storage_id, 'src', ?, 7, config_ref, policy_ref, ?"
                + " FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?", id, "agent", binding.getContextConfigRef(),
                com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "actor"), "tenant", workspace);
        return new WorkspaceFileStore.Locator(id, null, null);
    }

    @Test
    void sessionFilesPreservePinnedContextButRequireTheSshNodeActorAllowlist() {
        var locator = session("session");
        var remote = properties.getRuntimeBroker().getSsh();
        remote.setEnabled(true);
        remote.setNodes(List.of(new SshRuntimeSettings.Node("mac", "Mac", "mac", "/node", "/qwen.js", "/state",
                List.of("/work"), 33222, "0.25.1", List.of(new SshRuntimeSettings.Access("tenant", "actor")))));
        registry.configureSsh(properties);
        jdbc.update("UPDATE ma_storage SET storage_kind = 'SSH_LOCAL', registration_json = ?", "{\"nodeId\":\"mac\"}");
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, ?, ?, 'OPERATOR')",
                "tenant", workspace, com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "unlisted"));
        var allowed = files.scope("tenant", "actor", locator);
        assertThat(allowed.binding().getCwdRelative()).isEqualTo("src");
        assertThat(allowed.binding().getContextRevision()).isEqualTo(7);
        assertThatThrownBy(() -> files.scope("tenant", "unlisted", workspace, "."))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_node_forbidden"));
        assertThatThrownBy(() -> files.scope("tenant", "unlisted", locator))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_node_forbidden"));
        assertThatThrownBy(() -> files.query("tenant", "unlisted", locator, ".", "", null))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_node_forbidden"));
        assertThatThrownBy(() -> files.read("tenant", "unlisted", locator, "a.txt", allowed.revision()))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_node_forbidden"));
        var uploads = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new WorkspaceFileUploadStore(files, registry, guard, ssh, properties, jdbc,
                new DataSourceTransactionManager(jdbc.getDataSource()), new ObjectMapper(), Runnable::run));
        assertThatThrownBy(() -> uploads.upload("tenant", "unlisted", locator, "a.txt", allowed.revision(),
                UUID.randomUUID().toString(), new java.io.ByteArrayInputStream(new byte[] {1}), 1))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_node_forbidden"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", Integer.class)).isZero();
        verifyNoInteractions(ssh);
        remote.setEnabled(false);
        assertThatThrownBy(() -> files.scope("tenant", "actor", locator))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_node_forbidden"));
    }

    @Test
    void sessionUsesPersistedContextAndWorkspaceAccessInsteadOfReconstructingScope() {
        var locator = session("session");
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                assertThat(request.get("cwdRelative")).isEqualTo("src");
                assertThat(request).doesNotContainKey("sessionFileScope");
                return result();
            });
            var first = files.query("tenant", "actor", locator, ".", "", null);
            var direct = files.query("tenant", "actor", workspace, "src", ".", "", null);
            assertThat(first.scopeRevision()).isNotEqualTo(direct.scopeRevision());
            jdbc.update("UPDATE ma_session SET context_revision = 8 WHERE session_id = ?", "session");
            assertThatThrownBy(() -> files.query("tenant", "actor", locator, ".", "", first.scopeRevision()))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_file_scope_changed"));
            jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    "tenant", workspace, com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            assertThatThrownBy(() -> files.query("tenant", "actor", locator, ".", "", null))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
        }
    }

    @Test
    void anotherWorkspaceOperatorCanReadSessionFilesUntilTheSessionIsDeleted() {
        var locator = session("session");
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, ?, ?, 'OPERATOR')",
                "tenant", workspace, com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "operator"));
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenReturn(result());
            assertThat(files.query("tenant", "operator", locator, ".", "", null).entries()).isNotEmpty();
            jdbc.update("UPDATE ma_session SET status = 'DELETED' WHERE tenant_id = ? AND session_id = ?", "tenant", "session");
            process.clearInvocations();
            assertThatThrownBy(() -> files.query("tenant", "operator", locator, ".", "", null))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
            process.verifyNoInteractions();
        }
    }

    @Test
    void unreadySessionCannotReachTheFileProcess() {
        var locator = session("session");
        try (var worktrees = mockStatic(SessionWorktreeStore.class); var process = mockStatic(WorkspaceFileProcess.class)) {
            worktrees.when(() -> SessionWorktreeStore.requireReady(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session"))
                    .thenThrow(new ManagedAgentException(409, "worktree_not_ready", "Not ready"));
            assertThatThrownBy(() -> files.query("tenant", "actor", locator, ".", "", null))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("worktree_not_ready"));
            process.verifyNoInteractions();
        }
    }

    @Test
    void worktreeFileScopeIncludesActualContextDigestAndFrozenDirectoryIdentity() throws Exception {
        var locator = session("session");
        String cwd = ".qwen-managed-worktrees/owned/src";
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        Path root = Path.of((String) guard.fileRoot(binding).get("root"));
        Files.createDirectories(root.resolve(cwd));
        var identity = Files.readAttributes(root.resolve(".qwen-managed-worktrees/owned"), "unix:dev,ino");
        jdbc.update("UPDATE ma_session SET cwd_relative = ? WHERE session_id = ?", cwd, "session");
        try (var worktrees = mockStatic(SessionWorktreeStore.class); var process = mockStatic(WorkspaceFileProcess.class)) {
            worktrees.when(() -> SessionWorktreeStore.descriptor(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session"))
                    .thenReturn(new SessionWorktreeStore.Descriptor("owned", "session", workspace, "ready", "branch", "a".repeat(40), cwd, "op", 2, null));
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                Map<?, ?> proof = (Map<?, ?>) request.get("sessionFileScope");
                var actual = new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding("tenant", workspace,
                        binding.getWorkspaceGeneration(), binding.getStorageId(), cwd, binding.getContextConfigRef(), 7);
                assertThat(proof.get("sessionId")).isEqualTo("session");
                assertThat(proof.get("contextDigest")).isEqualTo(actual.getContextDigest());
                assertThat(proof.get("worktreeRevision")).isEqualTo(2L);
                assertThat(proof.get("worktreeRootIdentity")).isEqualTo(Map.of("device", identity.get("dev").toString(), "inode", identity.get("ino").toString()));
                return result();
            });
            String revision = files.query("tenant", "actor", locator, ".", "", null).scopeRevision();
            worktrees.when(() -> SessionWorktreeStore.descriptor(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session"))
                    .thenReturn(new SessionWorktreeStore.Descriptor("owned", "session", workspace, "ready", "branch", "a".repeat(40), cwd, "op", 3, null));
            assertThatThrownBy(() -> files.query("tenant", "actor", locator, ".", "", revision))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_file_scope_changed"));
        }
    }

    @Test
    void disabledDeploymentRefusesQueryAndReadBeforeFileIo() {
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            properties.getHarness().setWorkspaceFilesEnabled(false);
            assertThatThrownBy(this::query).isInstanceOfSatisfying(ManagedAgentException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_files_disabled"));
            assertThatThrownBy(() -> files.read("tenant", "actor", workspace, ".", "a.txt", "old"))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("workspace_files_disabled"));
            process.verifyNoInteractions();
        }
    }

    @Test
    void queriesOutsideTransactionsAndReadsExactBytesAtSameScope() {
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                return result();
            });
            var page = query();
            assertThat(page.entries()).containsExactly(new WorkspaceFileStore.Entry("a.txt", "a.txt", "file"));
            String text = "\uFEFFhello\r\n你好";
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenReturn(Map.of("files",
                    Map.of("protocolVersion", 1, "path", "a.txt", "name", "a.txt", "text", text,
                            "sha256", DigestUtils.sha256Hex(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)))));
            var read = files.read("tenant", "actor", workspace, ".", "a.txt", page.scopeRevision());
            assertThat(read.text()).isEqualTo(text);
            assertThat(read.scopeRevision()).isEqualTo(page.scopeRevision());
        }
    }

    @Test
    void rechecksRevokedGrantAfterIo() {
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                jdbc.update("DELETE FROM ma_workspace_access");
                return result();
            });
            assertThatThrownBy(this::query).isInstanceOfSatisfying(ManagedAgentException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_not_found"));
        }
    }

    @Test
    void hidesStrangersAndRejectsReadersBeforeFileIo() {
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            assertThatThrownBy(() -> files.query("tenant", "stranger", workspace, ".", ".", "", null))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_not_found"));
            assertThatThrownBy(() -> files.query("other-tenant", "actor", workspace, ".", ".", "", null))
                    .isInstanceOf(ManagedAgentException.class);
            jdbc.update("UPDATE ma_workspace_access SET role = 'READER'");
            assertThatThrownBy(this::query).isInstanceOfSatisfying(ManagedAgentException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_forbidden"));
            process.verifyNoInteractions();
        }
    }

    @Test
    void rejectsGenerationChangesDuringIoAndNeverFallsBackForCsiStorage() {
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenAnswer(call -> {
                jdbc.update("UPDATE ma_workspace SET workspace_generation = workspace_generation + 1");
                return result();
            });
            assertThatThrownBy(this::query).isInstanceOfSatisfying(ManagedAgentException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_file_scope_changed"));
            process.clearInvocations();
            jdbc.update("UPDATE ma_storage SET storage_kind = 'CSI'");
            assertThatThrownBy(this::query).isInstanceOfSatisfying(ManagedAgentException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
            process.verifyNoInteractions();
        }
    }

    @Test
    void refusesNewGenerationOrFenceAndDoesNotAcceptOldProbeAsFileProtocol() {
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenReturn(result());
            String revision = query().scopeRevision();
            jdbc.update("UPDATE ma_workspace SET workspace_generation = workspace_generation + 1");
            assertThatThrownBy(() -> files.read("tenant", "actor", workspace, ".", "a.txt", revision))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_file_scope_changed"));
            jdbc.update("UPDATE ma_storage SET fence_operation_id = 'migration'");
            assertThatThrownBy(this::query).isInstanceOf(ManagedAgentException.class);
            jdbc.update("UPDATE ma_storage SET fence_operation_id = NULL");
            process.when(() -> WorkspaceFileProcess.read(anyString(), anyString(), any())).thenReturn(Map.of("qwenVersion", "old"));
            process.when(WorkspaceFileProcess::unsupported).thenCallRealMethod();
            assertThatThrownBy(this::query).hasMessageContaining("updated CLI");
        }
    }
}
