package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.host.WorkspaceFileProcess;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import javax.sql.DataSource;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;

class WorkspaceFileUploadStoreTest {
    @TempDir
    Path temp;
    JdbcTemplate jdbc;
    ManagedAgentProperties properties;
    ManagedWorkspaceRegistry registry;
    WorkspaceStorageGuard guard;
    SshWorkspaceService ssh;
    WorkspaceFileStore files;
    WorkspaceFileUploadStore uploads;
    DataSourceTransactionManager manager;
    ObjectMapper mapper;
    String workspace;

    protected DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:uploads-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @BeforeEach
    void setUp() throws Exception {
        DataSource source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setWorkspaceCreationRoot(Files.createDirectory(temp.resolve("created")).toRealPath().toString());
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setNodeExecutable("node");
        properties.getRuntimeBroker().setWorkerEntry("/original/cli.js");
        manager = new DataSourceTransactionManager(source);
        registry = new ManagedWorkspaceRegistry(jdbc);
        guard = new WorkspaceStorageGuard(jdbc, manager, properties,
                path -> new StorageIdentityReader.Identity(path.toString(), "test-host", "1", "2", "2026-10-15T00:00:00.123456789Z"));
        mapper = new ObjectMapper();
        workspace = new WorkspaceCreationStore(jdbc, manager, guard, registry, properties, mapper, Clock.systemUTC())
                .create("tenant", "actor", "Uploads", "create").workspaceId();
        ssh = mock(SshWorkspaceService.class);
        files = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new WorkspaceFileStore(registry, guard, ssh, properties, jdbc, manager, mapper));
        Files.createDirectory(Path.of(guard.fileRoot(files.scope("tenant", "actor", workspace, ".").binding()).get("root")).resolve("src"));
        uploads = store();
    }

    WorkspaceFileUploadStore store() {
        return com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new WorkspaceFileUploadStore(files, registry, guard, ssh, properties, jdbc, manager, mapper, Runnable::run));
    }

    String revision() {
        return files.scope("tenant", "actor", workspace, ".").revision();
    }

    WorkspaceFileUploadStore.UploadResult upload(String id, String path, String revision, byte[] bytes) {
        return uploads.upload("tenant", "actor", workspace, ".", path, revision, id,
                new ByteArrayInputStream(bytes), bytes.length);
    }

    @Test
    void sessionUploadFreezesItsOriginalBindingForReconciliationAndRejectsDeletedSessions() {
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified, workspace_id, workspace_generation,"
                + " workspace_storage_id, cwd_relative, context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref, owner_actor_key)"
                + " SELECT tenant_id, ?, ?, 0, 0, workspace_id, workspace_generation, storage_id, 'src', ?, 7, config_ref, policy_ref, ?"
                + " FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?", "session", "agent", binding.getContextConfigRef(),
                com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "other"), "tenant", workspace);
        var locator = new WorkspaceFileStore.Locator("session", null, null);
        String revision = files.scope("tenant", "actor", locator).revision();
        String id = UUID.randomUUID().toString();
        AtomicInteger calls = new AtomicInteger();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                assertThat(request.get("cwdRelative")).isEqualTo("src");
                if (calls.getAndIncrement() == 0) {
                    throw new RuntimeBrokerException(503, "ssh_runtime_unavailable", "unknown", true);
                }
                Map<?, ?> file = (Map<?, ?>) request.get("files");
                assertThat(file.get("operation")).isEqualTo("upload-status");
                assertThat(file.containsKey("data")).isFalse();
                return response(request, "completed", null);
            });
            assertThatThrownBy(() -> uploads.upload("tenant", "actor", locator, "file.bin", revision, id, InputStream.nullInputStream(), 0))
                    .isInstanceOf(ManagedAgentException.class);
            assertThat(jdbc.queryForObject("SELECT request_json FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", String.class))
                    .contains("\"session\":\"session\"");
            assertThat(jdbc.queryForObject("SELECT session_id FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", String.class)).isEqualTo("session");
            jdbc.update("UPDATE ma_session SET cwd_relative = 'replacement', context_revision = 8 WHERE session_id = ?", "session");
            jdbc.update("UPDATE ma_operation SET available_at = 0 WHERE operation_kind = 'WORKSPACE_UPLOAD'");
            uploads = store();
            uploads.reconcile();
            assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
            assertThat(calls).hasValue(2);
            jdbc.update("UPDATE ma_session SET status = 'DELETED' WHERE tenant_id = ? AND session_id = ?", "tenant", "session");
            assertThatThrownBy(() -> uploads.query("tenant", "actor", id))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_not_found"));
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> response(Map<String, Object> request, String state, String code) {
        Map<String, Object> file = new LinkedHashMap<>((Map<String, Object>) request.get("files"));
        file.remove("operation");
        file.remove("data");
        file.put("state", state);
        if (code != null) {
            file.put("code", code);
        }
        return Map.of("files", file);
    }

    @Test
    void persistsOnlyMetadataSharesStorageOutsideTransactionsAndReplaysCompletedResult() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        byte[] bytes = new byte[] {0, (byte) 0xff, 1, 2};
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                assertSharedMembers(1);
                assertThat(jdbc.queryForObject("SELECT request_json FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", String.class))
                        .doesNotContain("data\":");
                assertThatThrownBy(() -> guard.fence("tenant", storage(), 1, UUID.randomUUID().toString()))
                        .isInstanceOf(RuntimeException.class);
                return response(call.getArgument(2), "completed", null);
            });
            var result = upload(id, "二进制.bin", revision, bytes);
            assertThat(result.sha256()).isEqualTo(DigestUtils.sha256Hex(bytes));
            assertThat(result.sizeBytes()).isEqualTo(4);
            assertThat(result.scopeRevision()).isEqualTo(revision);
            assertThat(upload(id, "二进制.bin", revision, bytes)).isEqualTo(result);
            assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
            process.verify(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()));
            assertSharedMembers(0);
        }
    }

    @Test
    void unknownOutcomeKeepsMembershipAndRestartQueriesOnlyTheOriginalTargetThroughFencing() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        AtomicInteger calls = new AtomicInteger();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                Map<?, ?> message = (Map<?, ?>) request.get("files");
                if (calls.getAndIncrement() == 0) {
                    assertThat(message.get("operation")).isEqualTo("upload");
                    throw new RuntimeBrokerException(503, "ssh_runtime_unavailable", "unknown", true);
                }
                assertThat(call.<String>getArgument(1)).isEqualTo("/original/cli.js");
                assertThat(message.get("operation")).isEqualTo("upload-status");
                assertThat(message.containsKey("data")).isFalse();
                return response(request, "completed", null);
            });
            assertThatThrownBy(() -> upload(id, "file.bin", revision, new byte[] {1}))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(503);
                        assertThat(error.getCode()).isEqualTo("workspace_upload_pending");
                    });
            assertSharedMembers(1);
            jdbc.update("UPDATE ma_storage SET fence_operation_id = 'retirement'");
            jdbc.update("UPDATE ma_workspace SET workspace_generation = workspace_generation + 1");
            properties.getRuntimeBroker().setWorkerEntry("/replacement/cli.js");
            uploads = store();
            var result = uploads.query("tenant", "actor", id);
            assertThat(result.state()).isEqualTo("completed");
            assertThat(result.scopeRevision()).isEqualTo(revision);
            assertSharedMembers(0);
        }
    }

    @Test
    void sshOnlyRestartDefersOriginalLocalUploadsWithoutLosingTheirMembership() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        String creationRoot = properties.getRuntimeBroker().getWorkspaceCreationRoot();
        AtomicInteger calls = new AtomicInteger();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                if (calls.getAndIncrement() == 0) {
                    throw new RuntimeBrokerException(503, "ssh_runtime_unavailable", "unknown", true);
                }
                assertThat(call.<String>getArgument(1)).isEqualTo("/original/cli.js");
                return response(call.getArgument(2), "completed", null);
            });
            assertThatThrownBy(() -> upload(id, "file.bin", revision, new byte[] {1}))
                    .isInstanceOf(ManagedAgentException.class);
            var broker = properties.getRuntimeBroker();
            broker.setProvisioner("ssh-process");
            broker.setWorkspaceCreationRoot("");
            broker.setVerifiedWorkspaceRecoveryEnabled(false);
            broker.setTrustedLocalRebootRecovery(false);
            broker.setWorkerEntry("");
            broker.setNodeExecutable("");
            broker.getSsh().setNodes(List.of(new com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings.Node(
                    "remote", "Remote", "ssh-host", "/node", "/cli.js", "/state", List.of("/work"), 41270,
                    "0.25.1", List.of(new com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings.Access("tenant", "actor")))));
            uploads = store();
            assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("pending");
            jdbc.update("UPDATE ma_operation SET available_at = 0 WHERE operation_kind = 'WORKSPACE_UPLOAD'");
            uploads.reconcile();
            assertThat(calls).hasValue(1);
            assertSharedMembers(1);
            assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", String.class)).isEqualTo("RUNNING");
            broker.setProvisioner("local-process");
            broker.getSsh().setNodes(List.of());
            broker.setWorkspaceCreationRoot(creationRoot);
            broker.setVerifiedWorkspaceRecoveryEnabled(true);
            broker.setWorkerEntry("/original/cli.js");
            broker.setNodeExecutable("node");
            assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
            assertThat(calls).hasValue(2);
            assertSharedMembers(0);
        }
    }

    @Test
    void pendingUploadsRejectChangedRequestsAndReleaseMembershipIndependentlyAfterRestart() {
        String id = UUID.randomUUID().toString();
        String otherId = UUID.randomUUID().toString();
        String revision = revision();
        AtomicInteger calls = new AtomicInteger();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                assertThat(((Map<?, ?>) request.get("files")).get("operation"))
                        .isEqualTo(calls.getAndIncrement() == 1 ? "upload-status" : "upload");
                return response(request, "pending", null);
            });
            assertThatThrownBy(() -> upload(id, "same.bin", revision, new byte[] {1})).isInstanceOf(ManagedAgentException.class);
            assertThatThrownBy(() -> upload(id, "same.bin", revision, new byte[] {2}))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_conflict"));
            assertThatThrownBy(() -> upload(id, "same.bin", revision, new byte[] {1})).isInstanceOf(ManagedAgentException.class);
            assertThatThrownBy(() -> upload(otherId, "other.bin", revision, new byte[] {1}))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_pending"));
            assertThat(calls).hasValue(3);
            assertSharedMembers(2);
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                    .thenAnswer(call -> response(call.getArgument(2), "completed", null));
            uploads = store();
            assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
            assertSharedMembers(1);
            assertThat(upload(id, "same.bin", revision, new byte[] {1}).uploadId()).isEqualTo(id);
            assertSharedMembers(1);
            assertThat(uploads.query("tenant", "actor", otherId).state()).isEqualTo("completed");
            assertSharedMembers(0);
        }
    }

    @Test
    void oldCliAndDefiniteFailureReleaseOnlyTheirOwnMembership() {
        String revision = revision();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenThrow(
                    new RuntimeBrokerException(409, "workspace_files_unsupported", "updated CLI required", false));
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "old.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
            assertSharedMembers(0);
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                    .thenAnswer(call -> response(call.getArgument(2), "failed", "ssh_runtime_file_exists"));
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "exists.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("ssh_runtime_file_exists"));
            assertSharedMembers(0);
        }
    }

    @Test
    void actorGrantAndScopeChecksPrecedeReadingTheBody() {
        InputStream input = new InputStream() {
            @Override
            public int read() {
                throw new AssertionError("unauthorized body must not be read");
            }
        };
        String revision = revision();
        for (String actor : List.of("stranger", "actor")) {
            jdbc.update("UPDATE ma_workspace_access SET role = 'READER'");
            assertThatThrownBy(() -> uploads.upload("tenant", actor, workspace, ".", "file.bin", revision,
                    UUID.randomUUID().toString(), input, 0)).isInstanceOf(ManagedAgentException.class);
        }
        jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'");
        assertThatThrownBy(() -> uploads.upload("tenant", "actor", workspace, ".", "file.bin", "0".repeat(64),
                UUID.randomUUID().toString(), input, 0)).isInstanceOf(ManagedAgentException.class);
        properties.getHarness().setWorkspaceFilesEnabled(false);
        assertThatThrownBy(() -> uploads.upload("tenant", "actor", workspace, ".", "file.bin", revision,
                UUID.randomUUID().toString(), input, 0)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void rejectsOversizeTraversalAndUnsupportedStorageWithoutSubprocesses() {
        String revision = revision();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            assertThatThrownBy(() -> uploads.upload("tenant", "actor", workspace, ".", "large.bin", revision,
                    UUID.randomUUID().toString(), InputStream.nullInputStream(), WorkspaceFileProcess.MAX_UPLOAD_BYTES + 1L))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getStatus()).isEqualTo(413));
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "../escape", revision, new byte[0]))
                    .isInstanceOf(ManagedAgentException.class);
            for (String reserved : List.of(".git", ".qwen-managed-cache", ".qwen-child-workspaces")) {
                assertThatThrownBy(() -> uploads.upload("tenant", "actor", workspace, reserved, "file.bin", revision,
                        UUID.randomUUID().toString(), InputStream.nullInputStream(), 0)).isInstanceOf(ManagedAgentException.class);
            }
            jdbc.update("UPDATE ma_storage SET storage_kind = 'CSI'");
            String csiRevision = revision();
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "csi.bin", csiRevision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
            process.verifyNoInteractions();
        }
    }

    @Test
    void malformedResponseRetainsMembershipAndBackgroundReconciliationSettlesWithoutMutation() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                Map<?, ?> file = (Map<?, ?>) request.get("files");
                if ("upload".equals(file.get("operation"))) {
                    return Map.of("files", Map.of("state", "completed", "sha256", "wrong"));
                }
                return response(request, "failed", "ssh_runtime_file_unavailable");
            });
            assertThatThrownBy(() -> upload(id, "file.bin", revision, new byte[0])).isInstanceOf(ManagedAgentException.class);
            jdbc.update("UPDATE ma_operation SET available_at = 0 WHERE operation_kind = 'WORKSPACE_UPLOAD'");
            uploads.reconcile();
            assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("failed");
            assertSharedMembers(0);
            assertThatThrownBy(() -> uploads.query("other-tenant", "actor", id)).isInstanceOf(ManagedAgentException.class);
            assertThatThrownBy(() -> uploads.query("tenant", "stranger", id)).isInstanceOf(ManagedAgentException.class);
            jdbc.update("DELETE FROM ma_workspace_access");
            assertThatThrownBy(() -> uploads.query("tenant", "actor", id)).isInstanceOf(ManagedAgentException.class);
        }
    }

    @Test
    void overlappingUploadProcessesShareStorageButExcludePhysicalFencing() throws Exception {
        Path entry = temp.resolve("gated-upload.mjs");
        Files.writeString(entry, """
                import fs from 'node:fs/promises';
                if(process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFileUpload:1}}));
                else {
                  let input=''; for await (const bytes of process.stdin) input+=bytes;
                  const request=JSON.parse(input);
                  await fs.writeFile(new URL('./entered-'+request.files.path, import.meta.url), 'entered');
                  const stop=Date.now()+10000;
                  while(true) {
                    try { await fs.access(new URL('./release-upload', import.meta.url)); break; }
                    catch { if(Date.now()>stop) process.exit(9); await new Promise(resolve=>setTimeout(resolve,10)); }
                  }
                  const {operation,data,...file}=request.files;
                  console.log(JSON.stringify({protocolVersion:1,ok:true,result:{files:{...file,state:'completed'}}}));
                }
                """);
        properties.getRuntimeBroker().setWorkerEntry(entry.toString());
        String revision = revision();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var original = executor.submit(() -> upload(UUID.randomUUID().toString(), "first.bin", revision, new byte[0]));
            var other = executor.submit(() -> upload(UUID.randomUUID().toString(), "second.bin", revision, new byte[0]));
            try {
                await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
                    assertThat(temp.resolve("entered-first.bin")).exists();
                    assertThat(temp.resolve("entered-second.bin")).exists();
                });
                assertSharedMembers(2);
                assertThatThrownBy(() -> guard.fence("tenant", storage(), 1, UUID.randomUUID().toString()))
                        .isInstanceOf(RuntimeException.class);
            } finally {
                Files.writeString(temp.resolve("release-upload"), "release");
            }
            assertThat(original.get(10, TimeUnit.SECONDS).sizeBytes()).isZero();
            assertThat(other.get(10, TimeUnit.SECONDS).sizeBytes()).isZero();
        }
        assertSharedMembers(0);
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void runtimeAndUploadShareInEitherAdmissionOrderAndReleaseIndependently(boolean runtimeFirst) {
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        var authority = new WorkspaceExecutionStore(jdbc, manager, guard);
        var runtime = runtime();
        String revision = revision();
        String id = UUID.randomUUID().toString();
        if (runtimeFirst) {
            authority.claim(binding, runtime);
            authority.beginRewind(binding, runtime);
        }
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                return response(request, "upload".equals(((Map<?, ?>) request.get("files")).get("operation"))
                        ? "pending" : "completed", null);
            });
            assertThatThrownBy(() -> upload(id, "shared.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_pending"));
            assertSharedMembers(runtimeFirst ? 2 : 1);
            if (!runtimeFirst) {
                authority.claim(binding, runtime);
                authority.beginRewind(binding, runtime);
            }
            assertThat(authority.isHeld(binding, runtime)).isTrue();
            assertThat(authority.hasPendingRewind(runtime)).isTrue();
            assertSharedMembers(2);
            if (runtimeFirst) {
                assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
                assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
                assertSharedMembers(1);
                assertThat(authority.hasPendingRewind(runtime)).isTrue();
                authority.endRewind(binding, runtime);
                authority.release(binding, runtime);
            } else {
                authority.release(binding, runtime);
                assertThat(authority.hasPendingRewind(runtime)).isFalse();
                authority.release(binding, runtime);
                assertSharedMembers(1);
                assertThatThrownBy(() -> guard.fence("tenant", storage(), 1, UUID.randomUUID().toString()))
                        .isInstanceOf(RuntimeBrokerException.class);
                assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
            }
            assertSharedMembers(0);
        }
    }

    @Test
    void maintenanceAndFencingWaitForPendingUploadsAndRejectNewUploads() {
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        var authority = new WorkspaceExecutionStore(jdbc, manager, guard);
        var children = new ChildWorkspaceStore(jdbc, manager);
        var child = children.admit("tenant", "parent", UUID.randomUUID().toString(), binding, System.currentTimeMillis());
        var maintenance = children.claim(child, "maintenance", System.currentTimeMillis(), 60_000);
        String id = UUID.randomUUID().toString();
        String revision = revision();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                    .thenAnswer(call -> response(call.getArgument(2), "pending", null));
            assertThatThrownBy(() -> upload(id, "pending.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_pending"));
            assertSharedMembers(1);
            assertThatThrownBy(() -> authority.holdForMaintenance(binding, maintenance.childWorkspaceId(), 1))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_busy"));
            assertThatThrownBy(() -> guard.fence("tenant", storage(), 1, UUID.randomUUID().toString()))
                    .isInstanceOf(RuntimeBrokerException.class);
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                    .thenAnswer(call -> response(call.getArgument(2), "completed", null));
            assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
            assertSharedMembers(0);
            String step = authority.holdForMaintenance(binding, maintenance.childWorkspaceId(), 1);
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "maintenance.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_busy"));
            authority.releaseMaintenance(binding, maintenance.childWorkspaceId(), 1, step);
            guard.fence("tenant", storage(), 1, UUID.randomUUID().toString());
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "fenced.bin", revision, new byte[0]))
                    .isInstanceOf(ManagedAgentException.class);
            assertSharedMembers(0);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void worktreePreparationSharesRuntimeAndPendingUploadsInEitherOrder(boolean prepareFirst) {
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        var authority = new WorkspaceExecutionStore(jdbc, manager, guard);
        var runtime = runtime();
        String maintenance = worktreeOperation(binding, true);
        String step = prepareFirst ? authority.holdForMaintenance(binding, maintenance, 1) : null;
        String revision = revision();
        String upload = UUID.randomUUID().toString();
        authority.claim(binding, runtime);
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                    .thenAnswer(call -> response(call.getArgument(2), "pending", null));
            assertThatThrownBy(() -> upload(upload, "pending.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_pending"));
            if (!prepareFirst) {
                step = authority.holdForMaintenance(binding, maintenance, 1);
            }
            assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner", Long.class)).isEqualTo(2);
            jdbc.update("UPDATE ma_session_worktree SET state = 'BLOCKED'");
            jdbc.update("UPDATE ma_operation SET state = 'BLOCKED', claim_until = 0 WHERE operation_kind = 'SESSION_WORKTREE'");
            authority.claim(binding, runtime);
            authority.assertHeld(binding, runtime);
            authority.beginRewind(binding, runtime);
            authority.endRewind(binding, runtime);
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                    .thenAnswer(call -> response(call.getArgument(2), "completed", null));
            assertThat(upload(UUID.randomUUID().toString(), "new.bin", revision, new byte[0]).sizeBytes()).isZero();
            assertThat(uploads.query("tenant", "actor", upload).state()).isEqualTo("completed");
            assertThat(uploads.query("tenant", "actor", upload).state()).isEqualTo("completed");
            assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner", Long.class)).isEqualTo(1);
            String cleanup = worktreeOperation(binding, false);
            assertThatThrownBy(() -> authority.holdForMaintenance(binding, cleanup, 1)).isInstanceOf(RuntimeBrokerException.class);
            authority.releaseMaintenance(binding, maintenance, 2, step);
            assertThat(jdbc.queryForObject("SELECT maintenance_id FROM ma_storage_owner", String.class)).isEqualTo(maintenance);
            authority.release(binding, runtime);
            assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner", Long.class)).isZero();
            assertThatThrownBy(() -> authority.holdForMaintenance(binding, cleanup, 1)).isInstanceOf(RuntimeBrokerException.class);
            authority.releaseMaintenance(binding, maintenance, 1, step);
            assertSharedMembers(0);
            String cleanupStep = authority.holdForMaintenance(binding, cleanup, 1);
            assertThatThrownBy(() -> authority.claim(binding, runtime)).isInstanceOf(RuntimeBrokerException.class);
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "blocked.bin", revision, new byte[0]))
                    .isInstanceOf(ManagedAgentException.class);
            authority.releaseMaintenance(binding, cleanup, 1, cleanupStep);
            assertSharedMembers(0);
        }
    }

    @Test
    void mismatchedPreparationGenerationNeverAdmitsAMember() {
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        var authority = new WorkspaceExecutionStore(jdbc, manager, guard);
        var runtime = runtime();
        String maintenance = worktreeOperation(binding, true);
        String step = authority.holdForMaintenance(binding, maintenance, 1);
        jdbc.update("UPDATE ma_operation SET claim_generation = 2 WHERE operation_kind = 'SESSION_WORKTREE'");
        assertThatThrownBy(() -> authority.claim(binding, runtime)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner", Long.class)).isZero();
        jdbc.update("UPDATE ma_operation SET claim_generation = 1 WHERE operation_kind = 'SESSION_WORKTREE'");
        authority.releaseMaintenance(binding, maintenance, 1, step);
    }

    private String worktreeOperation(com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding binding, boolean preparing) {
        String worktree = UUID.randomUUID().toString().replace("-", "");
        String operation = preparing ? worktree : UUID.randomUUID().toString().replace("-", "");
        String state = preparing ? "PREPARING" : "REMOVING";
        new org.springframework.transaction.support.TransactionTemplate(manager).executeWithoutResult(status -> {
            jdbc.update("INSERT INTO ma_session_worktree (tenant_id, session_id, workspace_id, storage_id, physical_key,"
                            + " worktree_id, owner_actor_key, state, revision, plan_json, operation_id, gmt_create, gmt_modified)"
                            + " VALUES ('tenant', ?, ?, ?, ?, ?, 'actor', ?, 1, '{}', ?, 1, 1)",
                    worktree, workspace, binding.getStorageId(), WorkspaceExecutionStore.storageKey(jdbc, binding), worktree, state, operation);
            new WorkspaceOperations(jdbc, "tenant").create(WorkspaceOperations.Kind.SESSION_WORKTREE, operation,
                    WorkspaceOperations.values("session_id", worktree, "storage_id", binding.getStorageId(), "state", state));
            jdbc.update("UPDATE ma_operation SET claim_owner = 'maintenance', claim_generation = 1, claim_until = "
                            + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW + " + 60000 WHERE operation_key = ?",
                    WorkspaceOperations.key(WorkspaceOperations.Kind.SESSION_WORKTREE, "tenant", operation));
        });
        return operation;
    }

    @Test
    void terminalEvidenceCannotReleaseADifferentStorageHolder() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                jdbc.update("UPDATE ma_storage_owner SET holder_key = ?", "f".repeat(64));
                return response(call.getArgument(2), "completed", null);
            });
            assertThatThrownBy(() -> upload(id, "file.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_pending"));
            assertThat(jdbc.queryForObject("SELECT holder_key FROM ma_storage_owner", String.class)).isEqualTo("f".repeat(64));
            assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner", Long.class)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", String.class)).isEqualTo("RUNNING");
        }
    }

    @Test
    void normalizesWorkingDirectoryAliasesBeforeFreezingAndComparingRequests() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                assertThat(request.get("cwdRelative")).isEqualTo(".");
                return response(request, "completed", null);
            });
            var first = uploads.upload("tenant", "actor", workspace, "./", "file.bin", revision, id,
                    InputStream.nullInputStream(), 0);
            assertThat(upload(id, "file.bin", revision, new byte[0])).isEqualTo(first);
            process.verify(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()));
        }
    }

    @Test
    void admissionAndSettlementDoNotWaitForTheTenantPlacementGuard() throws Exception {
        String revision = revision();
        try (var holder = jdbc.getDataSource().getConnection(); var process = mockStatic(WorkspaceFileProcess.class)) {
            holder.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(holder, "tenant");
            try {
                process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                        .thenAnswer(call -> response(call.getArgument(2), "completed", null));
                assertThat(upload(UUID.randomUUID().toString(), "guarded.bin", revision, new byte[0]).sizeBytes()).isZero();
                assertSharedMembers(0);
            } finally {
                holder.rollback();
            }
        }
    }

    @Test
    void concurrentReceiptsForOneUploadIdAdmitOnceAndReleaseOnce() throws Exception {
        Path entry = temp.resolve("counting-upload.mjs");
        Files.writeString(entry, """
                import fs from 'node:fs/promises';
                if(process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFileUpload:1}}));
                else {
                  let input=''; for await (const bytes of process.stdin) input+=bytes;
                  const request=JSON.parse(input);
                  const done=new URL('./uploaded', import.meta.url);
                  let state='completed';
                  if(request.files.operation==='upload') await fs.appendFile(done, 'x');
                  else { try { await fs.access(done); } catch { state='pending'; } }
                  const {operation,data,...file}=request.files;
                  console.log(JSON.stringify({protocolVersion:1,ok:true,result:{files:{...file,state}}}));
                }
                """);
        properties.getRuntimeBroker().setWorkerEntry(entry.toString());
        String id = UUID.randomUUID().toString();
        String revision = revision();
        var start = new java.util.concurrent.CountDownLatch(1);
        var completed = new AtomicInteger();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var receipts = new java.util.ArrayList<java.util.concurrent.Future<?>>();
            for (int index = 0; index < 4; index++) {
                receipts.add(executor.submit(() -> {
                    start.await();
                    try {
                        assertThat(upload(id, "same.bin", revision, new byte[] {1}).sizeBytes()).isOne();
                        completed.incrementAndGet();
                    } catch (ManagedAgentException pending) {
                        assertThat(pending.getCode()).isEqualTo("workspace_upload_pending");
                    }
                    return null;
                }));
            }
            start.countDown();
            for (var receipt : receipts) {
                receipt.get(20, TimeUnit.SECONDS);
            }
        }
        assertThat(completed.get()).isPositive();
        assertThat(Files.readString(temp.resolve("uploaded"))).isEqualTo("x");
        assertThat(uploads.query("tenant", "actor", id).state()).isEqualTo("completed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD'", Long.class)).isOne();
        assertSharedMembers(0);
    }

    private RuntimeSessionRecord runtime() {
        var source = jdbc.getDataSource();
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var binding = files.scope("tenant", "actor", workspace, ".").binding();
        var scope = new RuntimeScope("tenant", workspace, "1", guard.fileRoot(binding).get("root"),
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        String id = UUID.randomUUID().toString();
        var created = bindings.findOrCreate(new RuntimeProvisionRequest(scope, id, "local-process", storage()));
        var claimed = bindings.claimOperation(created.getBindingId(), "test", Duration.ofMinutes(1));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var ready = bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                new RuntimeResourceHandle("local-process", 1, Map.of("provider", "local-process")), Instant.now(), Instant.now()));
        var acquiring = bindings.admitSession(sessions, new RuntimeSessionRecord(new RuntimeSession(id, id, "bootstrap", scope),
                ready.getBindingId(), ready.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        return sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
    }

    private void assertSharedMembers(long expected) {
        assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner", Long.class)).isEqualTo(expected);
        long runtimeMembers = jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE execution_storage_key IS NOT NULL", Long.class);
        long uploadMembers = jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_UPLOAD' AND state = 'RUNNING'", Long.class);
        assertThat(runtimeMembers + uploadMembers).isEqualTo(expected);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isZero();
    }

    private String storage() {
        return jdbc.queryForObject("SELECT storage_id FROM ma_workspace WHERE workspace_id = ?", String.class, workspace);
    }
}
