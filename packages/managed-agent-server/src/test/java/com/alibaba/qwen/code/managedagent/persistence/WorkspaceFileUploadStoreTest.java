package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
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

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
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
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setWorkspaceCreationRoot(Files.createDirectory(temp.resolve("created")).toRealPath().toString());
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setNodeExecutable("node");
        properties.getRuntimeBroker().setWorkerEntry("/original/cli.js");
        manager = new DataSourceTransactionManager(source);
        registry = new ManagedWorkspaceRegistry(jdbc);
        guard = new WorkspaceStorageGuard(jdbc, manager, properties,
                path -> new WorkspaceStorageGuard.Identity(path.toString(), "test-host", "1", "2", "2026-10-15T00:00:00.123456789Z"));
        mapper = new ObjectMapper();
        workspace = new WorkspaceCreationStore(jdbc, manager, guard, registry, properties, mapper, Clock.systemUTC())
                .create("tenant", "actor", "Uploads", "create").workspaceId();
        ssh = mock(SshWorkspaceService.class);
        files = new WorkspaceFileStore(registry, guard, ssh, properties, jdbc, manager, mapper);
        Files.createDirectory(Path.of(guard.fileRoot(files.scope("tenant", "actor", workspace, ".").binding()).get("root")).resolve("src"));
        uploads = store();
    }

    WorkspaceFileUploadStore store() {
        return new WorkspaceFileUploadStore(files, registry, guard, ssh, properties, jdbc, manager, mapper, Runnable::run);
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
                ManagedWorkspaceRegistry.actorKey("tenant", "other"), "tenant", workspace);
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
    void persistsOnlyMetadataHoldsStorageOutsideTransactionsAndReplaysCompletedResult() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        byte[] bytes = new byte[] {0, (byte) 0xff, 1, 2};
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isEqualTo(1);
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
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isZero();
        }
    }

    @Test
    void unknownOutcomeKeepsHoldAndRestartQueriesOnlyTheOriginalTargetThroughFencing() {
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
                        assertThat(error.getStatus().value()).isEqualTo(503);
                        assertThat(error.getCode()).isEqualTo("workspace_upload_pending");
                    });
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isEqualTo(1);
            jdbc.update("UPDATE ma_storage SET fence_operation_id = 'retirement'");
            jdbc.update("UPDATE ma_workspace SET workspace_generation = workspace_generation + 1");
            properties.getRuntimeBroker().setWorkerEntry("/replacement/cli.js");
            uploads = store();
            var result = uploads.query("tenant", "actor", id);
            assertThat(result.state()).isEqualTo("completed");
            assertThat(result.scopeRevision()).isEqualTo(revision);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isZero();
        }
    }

    @Test
    void rejectsChangedRequestsAndNeverReplaysMutationWhilePending() {
        String id = UUID.randomUUID().toString();
        String revision = revision();
        AtomicInteger calls = new AtomicInteger();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenAnswer(call -> {
                Map<String, Object> request = call.getArgument(2);
                assertThat(((Map<?, ?>) request.get("files")).get("operation"))
                        .isEqualTo(calls.getAndIncrement() == 0 ? "upload" : "upload-status");
                return response(request, "pending", null);
            });
            assertThatThrownBy(() -> upload(id, "same.bin", revision, new byte[] {1})).isInstanceOf(ManagedAgentException.class);
            assertThatThrownBy(() -> upload(id, "same.bin", revision, new byte[] {2}))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_upload_conflict"));
            assertThatThrownBy(() -> upload(id, "same.bin", revision, new byte[] {1})).isInstanceOf(ManagedAgentException.class);
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "other.bin", revision, new byte[] {1}))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_busy"));
            assertThat(calls).hasValue(2);
        }
    }

    @Test
    void oldCliAndDefiniteFailureReleaseOnlyTheirOwnHold() {
        String revision = revision();
        try (var process = mockStatic(WorkspaceFileProcess.class)) {
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any())).thenThrow(
                    new RuntimeBrokerException(409, "workspace_files_unsupported", "updated CLI required", false));
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "old.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isZero();
            process.when(() -> WorkspaceFileProcess.upload(anyString(), anyString(), any()))
                    .thenAnswer(call -> response(call.getArgument(2), "failed", "ssh_runtime_file_exists"));
            assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "exists.bin", revision, new byte[0]))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("ssh_runtime_file_exists"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isZero();
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
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getStatus().value()).isEqualTo(413));
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
    void malformedResponseRetainsHoldAndBackgroundReconciliationSettlesWithoutMutation() {
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
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isZero();
            assertThatThrownBy(() -> uploads.query("other-tenant", "actor", id)).isInstanceOf(ManagedAgentException.class);
            assertThatThrownBy(() -> uploads.query("tenant", "stranger", id)).isInstanceOf(ManagedAgentException.class);
            jdbc.update("DELETE FROM ma_workspace_access");
            assertThatThrownBy(() -> uploads.query("tenant", "actor", id)).isInstanceOf(ManagedAgentException.class);
        }
    }

    @Test
    void anotherUploadAndPhysicalFencingCannotEnterWhileTheOriginalProcessOwnsStorage() throws Exception {
        Path entry = temp.resolve("gated-upload.mjs");
        Files.writeString(entry, """
                import fs from 'node:fs/promises';
                if(process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFileUpload:1}}));
                else {
                  let input=''; for await (const bytes of process.stdin) input+=bytes;
                  const request=JSON.parse(input);
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
            try {
                await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isEqualTo(1));
                assertThatThrownBy(() -> upload(UUID.randomUUID().toString(), "second.bin", revision, new byte[0]))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_busy"));
                assertThatThrownBy(() -> guard.fence("tenant", storage(), 1, UUID.randomUUID().toString()))
                        .isInstanceOf(RuntimeException.class);
            } finally {
                Files.writeString(temp.resolve("release-upload"), "release");
            }
            assertThat(original.get(10, TimeUnit.SECONDS).sizeBytes()).isZero();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class)).isZero();
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

    private String storage() {
        return jdbc.queryForObject("SELECT storage_id FROM ma_workspace WHERE workspace_id = ?", String.class, workspace);
    }
}
