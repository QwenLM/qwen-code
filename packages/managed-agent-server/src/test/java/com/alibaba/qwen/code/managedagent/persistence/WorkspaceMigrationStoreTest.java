package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.*;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;

class WorkspaceMigrationStoreTest {
    @TempDir Path temp;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private WorkspaceStorageGuard guard;
    private ObjectNode request;
    private Path source;
    private Path target;
    private Path unreadableIdentity;

    @BeforeEach
    void setup() throws Exception {
        temp = temp.toRealPath();
        var data = new DriverManagerDataSource("jdbc:h2:mem:migration-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(data);
        jdbc = new ManagedSchemaJdbcTemplate(data);
        manager = new DataSourceTransactionManager(data);
        source = Files.createDirectory(temp.resolve("source")).toRealPath();
        target = Files.createDirectory(temp.resolve("target")).toRealPath();
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount("tenant", "storage", source.toString())));
        guard = new WorkspaceStorageGuard(jdbc, manager, properties, path -> {
            if (path.equals(unreadableIdentity)) {
                throw new IOException("Unverified directory birth time");
            }
            return new WorkspaceStorageGuard.Identity(path.toRealPath().toString(), "test-host", "device",
                    path.getFileName().toString(), "2026-10-02T00:00:00Z");
        });
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        Files.createDirectory(temp.resolve("history"));
        Files.createDirectory(temp.resolve("runtime"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        request = WorkspaceRecoveryStore.JSON.createObjectNode().put("version", 1)
                .put("migrationOperationId", UUID.randomUUID().toString()).put("tenantId", "tenant").put("storageId", "storage")
                .put("fenceOperationId", UUID.randomUUID().toString()).put("captureOperationId", UUID.randomUUID().toString())
                .put("mountRevision", 1).put("sourceRoot", source.toString()).put("targetRoot", target.toString())
                .put("bundleRoot", temp.resolve("bundle").toString()).put("fileHistoryRoot", temp.resolve("history").toString())
                .put("stateDirectory", temp.resolve("runtime").toString()).put("nodeExecutable", "/test/node")
                .put("cliEntry", "/test/cli.js");
    }

    private WorkspaceMigrationStore store(boolean create) {
        return new WorkspaceMigrationStore(jdbc, manager, guard, new InMemoryRuntimeBindingRepository(),
                request.toString().getBytes(StandardCharsets.UTF_8), create);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void rejectsCsiStorageBeforeInstallingAnyMigrationFence(boolean alias) throws Exception {
        if (alias) {
            jdbc.update("UPDATE ma_storage SET storage_kind = 'CSI' WHERE alias_key = ?", WorkspaceCsiRegistration.aliasKey("tenant", "storage"));
        } else {
            jdbc.update("UPDATE ma_storage_owner SET storage_kind = 'CSI'");
        }
        var registration = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        byte[] marker = Files.readAllBytes(source.resolve(".qwen-managed-storage.json"));
        assertThatThrownBy(() -> store(true)).isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
            assertThat(error.getCode()).isEqualTo("workspace_unavailable");
            assertThat(error.isRetryable()).isFalse();
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(registration);
        assertThat(Files.readAllBytes(source.resolve(".qwen-managed-storage.json"))).isEqualTo(marker);
    }

    @Test
    void rejectsNonPrivateStateDirectoryBeforeInstallingAnyFence() throws Exception {
        Path directory = Path.of(request.path("stateDirectory").asText());
        var permissions = PosixFilePermissions.fromString("rwxr-xr-x");
        Files.setPosixFilePermissions(directory, permissions);
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_state_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
        assertThat(Files.getPosixFilePermissions(directory)).isEqualTo(permissions);
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        assertThat(store(true).inspect().path("state").asText()).isEqualTo("RETIRING");
    }

    @ParameterizedTest
    @CsvSource({"stateDirectory,false", "stateDirectory,true", "fileHistoryRoot,false", "fileHistoryRoot,true"})
    void rejectsUnavailableOriginalDirectoriesBeforeInstallingAnyFence(String field, boolean symlink) throws Exception {
        Path directory = Path.of(request.path(field).asText());
        Files.delete(directory);
        if (symlink) {
            Files.createSymbolicLink(directory, target);
        }
        String code = "stateDirectory".equals(field) ? "migration_state_unavailable" : "migration_history_unverified";
        assertThatThrownBy(() -> store(true)).hasMessageContaining(code);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
    }

    @Test
    void rejectsUnprovedHistoryIdentityBeforeInstallingAnyFenceAndPreservesOperationReplay() throws Exception {
        unreadableIdentity = Path.of(request.path("fileHistoryRoot").asText());
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_history_unverified");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
        unreadableIdentity = null;
        var original = store(true).inspect();
        Files.delete(Path.of(request.path("stateDirectory").asText()));
        Files.delete(Path.of(request.path("fileHistoryRoot").asText()));
        assertThat(store(false).inspect()).isEqualTo(original);
    }

    @ParameterizedTest
    @ValueSource(strings = {"source_drift", "migration_tree_mismatch"})
    void preservesTheCurrentWorkerFailureAndInvalidatesOnlySourceDrift(String code) throws Exception {
        Process node = new ProcessBuilder("node", "-p", "process.execPath").start();
        try {
            assertThat(node.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(node.exitValue()).isZero();
            request.put("nodeExecutable", Path.of(new String(node.getInputStream().readAllBytes(), StandardCharsets.UTF_8)
                    .trim()).toRealPath().toString());
        } finally {
            if (node.isAlive()) {
                node.destroyForcibly();
            }
        }
        Path worker = temp.resolve("failure-worker.cjs");
        Files.writeString(worker, "const rl = require('node:readline').createInterface({input: process.stdin});\n"
                + "rl.once('line', () => process.exit(1));\n"
                + "process.stdout.write(JSON.stringify({id: 1, method: 'failure', params: {code: '" + code + "'}}) + '\\n');\n");
        request.put("cliEntry", worker.toString());
        var operation = store(true);
        operation.retire(mock(RuntimeBrokerService.class));
        guard.fence("tenant", "storage", 1, request.path("fenceOperationId").asText());
        var captureRequest = request.deepCopy();
        captureRequest.remove(List.of("migrationOperationId", "targetRoot", "stateDirectory"));
        captureRequest.put("operationId", request.path("captureOperationId").asText());
        new WorkspaceRecoveryStore(jdbc, manager, guard, null, "capture",
                captureRequest.toString().getBytes(StandardCharsets.UTF_8));
        // Protocol fixture: no claim of sealed file content; exercise the real verify failure RPC.
        new WorkspaceOperations(jdbc, "tenant").update(WorkspaceOperations.Kind.WORKSPACE_RECOVERY,
                request.path("captureOperationId").asText(), WorkspaceOperations.values("state", "SEALED", "manifest_digest", "0".repeat(64), "result_json", "{}"));
        assertThatThrownBy(() -> operation.verify(false)).isInstanceOfSatisfying(
                WorkspaceRecoveryStore.RecoveryFailure.class, error -> {
                    assertThat(error.code).isEqualTo(code);
                    operation.failed(error.code);
                });
        String attempt = operation.inspect().path("verifyOperationId").asText();
        assertThat(operation.inspect().path("state").asText())
                .isEqualTo("source_drift".equals(code) ? "INVALIDATED" : "PREPARING");
        assertThat(operation.inspect().path("lastErrorCode").asText()).isEqualTo(code);
        assertThat(new WorkspaceOperations(jdbc, "tenant").find(WorkspaceOperations.Kind.WORKSPACE_RECOVERY, attempt, false).get("last_error_code")).isEqualTo(code);
        if (!"source_drift".equals(code)) {
            assertThatThrownBy(() -> operation.verify(false)).hasMessageContaining(code);
            assertThat(operation.inspect().path("verifyOperationId").asText()).isEqualTo(attempt);
        }
    }

    @Test
    void collectedSourceBytesInvalidateTheMigration() {
        var operation = store(true);
        assertThat(operation.inspect().path("state").asText()).isEqualTo("RETIRING");
        operation.failed("resource_collected");
        assertThat(operation.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(operation.inspect().path("lastErrorCode").asText()).isEqualTo("resource_collected");
    }

    @ParameterizedTest
    @CsvSource({"false,recovery_read_failed", "true,recovery_read_failed",
            "false,migration_not_writable", "true,migration_not_writable"})
    void clearsCompetingAttemptErrorsOnSuccessfulVerification(boolean promote, String code) throws Exception {
        Process node = new ProcessBuilder("node", "-p", "process.execPath").start();
        try {
            assertThat(node.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(node.exitValue()).isZero();
            request.put("nodeExecutable", Path.of(new String(node.getInputStream().readAllBytes(), StandardCharsets.UTF_8)
                    .trim()).toRealPath().toString());
        } finally {
            if (node.isAlive()) {
                node.destroyForcibly();
            }
        }
        Path ready = temp.resolve("worker-ready");
        Path release = temp.resolve("worker-release");
        Path worker = temp.resolve("successful-worker.cjs");
        request.put("cliEntry", worker.toString());
        var operation = store(true);
        operation.retire(mock(RuntimeBrokerService.class));
        guard.fence("tenant", "storage", 1, request.path("fenceOperationId").asText());
        Files.copy(source.resolve(".qwen-managed-storage.json"), target.resolve(".qwen-managed-storage.json"));
        var captureRequest = request.deepCopy();
        captureRequest.remove(List.of("migrationOperationId", "targetRoot", "stateDirectory"));
        captureRequest.put("operationId", request.path("captureOperationId").asText());
        var capture = new WorkspaceRecoveryStore(jdbc, manager, guard, null, "capture",
                captureRequest.toString().getBytes(StandardCharsets.UTF_8));
        var context = capture.call("context", WorkspaceRecoveryStore.JSON.createObjectNode());
        var manifest = WorkspaceRecoveryStore.JSON.createObjectNode().put("version", 1)
                .put("provider", "local-workspace-bundle/1").put("tenantId", "tenant").put("storageId", "storage")
                .put("captureOperationId", request.path("captureOperationId").asText()).put("activation", false);
        for (String name : List.of("fenceOperationId", "mountRevision")) {
            manifest.set(name, request.path(name));
        }
        for (String name : List.of("registration", "sourceDigest", "sessionCount")) {
            manifest.set(name, context.path(name));
        }
        for (String name : List.of("sessions", "assets")) {
            manifest.putObject(name)
                    .put("path", ".w1-recovery/" + name + ".ndjson").put("count", 0).put("byteLength", 0)
                    .put("digest", WorkspaceRecoveryStore.hash(new byte[0]));
        }
        Path metadata = Files.createDirectories(temp.resolve("bundle/.w1-recovery"));
        byte[] bytes = manifest.toString().getBytes(StandardCharsets.UTF_8);
        Files.write(metadata.resolve("manifest.json"), bytes);
        var finish = WorkspaceRecoveryStore.JSON.createObjectNode().put("manifestDigest", WorkspaceRecoveryStore.hash(bytes));
        finish.putObject("result").put("contentVerified", true).put("activation", false);
        capture.call("finish", finish);
        // Protocol fixture for the success boundary, not file-content verification.
        Files.writeString(worker, "const fs = require('node:fs');\n"
                + "const rl = require('node:readline').createInterface({input: process.stdin});\n"
                + "rl.once('line', line => {\n"
                + "  if (JSON.parse(line).error) process.exit(1);\n"
                + "  fs.writeFileSync(" + WorkspaceRecoveryStore.JSON.valueToTree(ready.toString()) + ", 'ready');\n"
                + "  const deadline = Date.now() + 10000;\n"
                + "  setInterval(() => {\n"
                + "    if (fs.existsSync(" + WorkspaceRecoveryStore.JSON.valueToTree(release.toString()) + ")) process.exit(0);\n"
                + "    if (Date.now() > deadline) process.exit(2);\n"
                + "  }, 10);\n"
                + "});\n"
                + "process.stdout.write(JSON.stringify({id: 1, method: 'finish', params: " + finish + "}) + '\\n');\n");
        if (promote) {
            Files.writeString(release, "release");
            operation.verify(false);
            Files.delete(release);
            Files.delete(ready);
        }
        try (var executor = Executors.newSingleThreadExecutor()) {
            var verified = executor.submit(() -> {
                operation.verify(promote);
                return operation.inspect();
            });
            try {
                await().atMost(10, TimeUnit.SECONDS).until(() -> Files.exists(ready));
                store(false).failed(code);
                assertThat(operation.inspect().path("lastErrorCode").asText()).isEqualTo(code);
                Files.writeString(release, "release");
                var receipt = verified.get(15, TimeUnit.SECONDS);
                assertThat(receipt.path("state").asText()).isEqualTo(promote ? "COMPLETED" : "PREPARED");
                assertThat(receipt.path("lastErrorCode").isNull()).isTrue();
                assertThat(receipt.path("result_json").path("contentVerified").asBoolean()).isTrue();
                assertThat(receipt.path("result_json").path("activation").asBoolean()).isFalse();
                assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner WHERE storage_key = (SELECT physical_key FROM ma_storage WHERE alias_key = ?)", Long.class, JdbcRuntimeBindingRepository.storageAliasKey("tenant", "storage")))
                        .isEqualTo(promote ? 2 : 1);
                operation.verify(promote);
                assertThat(operation.inspect()).isEqualTo(receipt);
                if (!promote) {
                    operation.abort();
                }
                var terminal = operation.inspect();
                operation.failed("source_drift");
                assertThat(operation.inspect()).isEqualTo(terminal);
            } finally {
                Files.writeString(release, "release");
            }
        }
    }

    @Test
    void sharesFenceOwnershipWithTheJdbcBrokerAndClearsBothReaders() {
        var bindings = new JdbcRuntimeBindingRepository(jdbc.getDataSource(),
                new AesGcmSecretProtector("test", new byte[32]));
        jdbc.update("UPDATE ma_storage SET gmt_modified = 1");
        var operation = new WorkspaceMigrationStore(jdbc, manager, guard, bindings,
                request.toString().getBytes(StandardCharsets.UTF_8), true);
        assertThat(jdbc.queryForObject("SELECT gmt_modified FROM ma_storage", Long.class)).isGreaterThan(1);
        jdbc.update("UPDATE ma_storage SET gmt_modified = 1");
        new WorkspaceMigrationStore(jdbc, manager, guard, bindings,
                request.toString().getBytes(StandardCharsets.UTF_8), true);
        assertThat(jdbc.queryForObject("SELECT gmt_modified FROM ma_storage", Long.class)).isEqualTo(1);
        String id = request.path("migrationOperationId").asText();
        assertThat(bindings.isStorageFenced("tenant", "storage", id)).isTrue();
        var scope = new RuntimeScope("tenant", "workspace", "1", source.toString(),
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        assertThatThrownBy(() -> bindings.findOrCreate(
                new RuntimeProvisionRequest(scope, "session", "local-process", "storage")))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_migrating"));
        assertThat(bindings.findOrCreate(
                new RuntimeProvisionRequest(scope, "other", "local-process", "other-storage"))).isNotNull();
        operation.retire(mock(RuntimeBrokerService.class));
        guard.fence("tenant", "storage", 1, request.path("fenceOperationId").asText());
        operation.abort();
        assertThat(bindings.isStorageFenced("tenant", "storage", null)).isFalse();
        assertThat(WorkspaceMigrationAdmission.owner(jdbc, "tenant", "storage")).isNull();
        bindings.requestStorageFence("tenant", "storage", "broker-fence");
        assertThat(WorkspaceMigrationAdmission.owner(jdbc, "tenant", "storage")).isEqualTo("broker-fence");
        assertThatThrownBy(() -> WorkspaceMigrationAdmission.requireOpen(jdbc, "tenant", "storage"))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
    }

    @Test
    void rejectsAnOversizedProtocolVersionBeforeInstallingAnyFence() {
        request.put("version", 4_294_967_297L);
        assertThatThrownBy(() -> store(true)).hasMessageContaining("invalid_request");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
    }

    // A parked title (D7-2, or UNKNOWN before it) waits as an open one does.
    @ParameterizedTest
    @ValueSource(strings = {"PENDING", "RUNNING", "RECOVERY_BLOCKED", "UNKNOWN"})
    void refusesUnfinishedTitleDeliveryEvenWithAFailedPublicReceipt(String state) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref)"
                + " VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1, 'workspace', 1, 'storage', '.', ?, 1, ?, ?)",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        jdbc.update("UPDATE ma_session SET tenant_key = ?, session_key = ?, session_scope_key = ? WHERE tenant_id = X'74656e616e74' AND session_id = X'73657373696f6e'",
                WorkspaceOperations.hash("tenant"), WorkspaceOperations.hash("session"), scope);
        ManagedReceipts.insertCommand(jdbc, "tenant", "RENAME_SESSION", "rename", "digest", "session", null, "FAILED", null, 1);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_kind, operation_id, tenant_id, session_id,"
                + " target_kind, target_key, request_digest, request_json, state, phase, delivery_state, available_at, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'RENAME', 'rename:1', 'tenant', 'session', 'SESSION', ?, 'digest', '{}', ?, 'SUBMITTED', ?, 0, 1, 1)",
                WorkspaceOperations.hash("rename"), scope, scope, WorkspaceOperations.hash("session"), state, state);
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_work_unsettled");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_request_receipt WHERE namespace = 'SESSION_COMMAND'", String.class)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT delivery_state FROM ma_operation WHERE operation_kind = 'RENAME'", String.class)).isEqualTo(state);
    }

    // A title a later title superseded, or one proven never delivered, has
    // settled and holds nothing: superseded rows used to hold the storage for
    // good, since nothing ever completes them.
    @ParameterizedTest
    @ValueSource(strings = {"COMPLETED", "SUPERSEDED", "FAILED"})
    void aSettledTitleDeliveryDoesNotHoldTheMigration(String state) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref)"
                + " VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1, 'workspace', 1, 'storage', '.', ?, 1, ?, ?)",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        jdbc.update("UPDATE ma_session SET tenant_key = ?, session_key = ?, session_scope_key = ? WHERE tenant_id = X'74656e616e74' AND session_id = X'73657373696f6e'",
                WorkspaceOperations.hash("tenant"), WorkspaceOperations.hash("session"), scope);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_kind, operation_id, tenant_id, session_id,"
                + " target_kind, target_key, request_digest, request_json, state, phase, delivery_state, available_at, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'RENAME', 'rename:1', 'tenant', 'session', 'SESSION', ?, 'digest', '{}', ?, ?, 'COMPLETED', 0, 1, 1)",
                WorkspaceOperations.hash("rename"), scope, scope, WorkspaceOperations.hash("session"), state, state);
        // Past its idle check, the migration reaches the source check, which
        // this bare Session fails.
        assertThatThrownBy(() -> store(true)).hasMessageContaining("source_drift")
                .hasMessageNotContaining("migration_work_unsettled");
    }

    // D7-2: a parked task cancel holds no lifecycle hostage, yet its
    // acceptance is unknown and its task may still use this storage, so a
    // migration waits until the reconciler settles it.
    @Test
    void refusesAStorageWithAParkedTaskCancelUntilItSettles() {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref)"
                + " VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1, 'workspace', 1, 'storage', '.', ?, 1, ?, ?)",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        jdbc.update("UPDATE ma_session SET tenant_key = ?, session_key = ?, session_scope_key = ? WHERE tenant_id = X'74656e616e74' AND session_id = X'73657373696f6e'",
                WorkspaceOperations.hash("tenant"), WorkspaceOperations.hash("session"), scope);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_kind, operation_id, tenant_id, session_id,"
                + " target_kind, target_key, request_digest, request_json, state, phase, delivery_state, failure_code, available_at, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'TASK_CANCEL', 'op_cancel', 'tenant', 'session', 'SESSION', ?, 'digest', '{}', 'RECOVERY_BLOCKED',"
                + " 'RECOVERY_BLOCKED', 'BLOCKED', 'task_cancel_unconfirmed', 0, 1, 1)",
                WorkspaceOperations.hash("cancel"), scope, scope, WorkspaceOperations.hash("session"));
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_work_unsettled");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        // Settled, it no longer holds the move: the migration gets past its
        // idle check to the source check, which this bare Session fails.
        jdbc.update("UPDATE ma_operation SET state = 'FAILED', phase = 'FAILED', failure_code = 'task_already_settled'"
                + " WHERE operation_kind = 'TASK_CANCEL'");
        assertThatThrownBy(() -> store(true)).hasMessageContaining("source_drift")
                .hasMessageNotContaining("migration_work_unsettled");
    }

    @Test
    void rejectsDescriptorDriftBeforeRetirementAndReusesTheNormalBindingReader() {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref)"
                + " VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1, 'workspace', 1, 'storage', '.', ?, 1, ?, ?)",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        ManagedReceipts.insertCreation(jdbc, "tenant", "owner".getBytes(StandardCharsets.UTF_8), "create", "sha256:test", "session", null, 1);
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, gmt_modified) VALUES (?, ?, 'SESSION', ?, 1)", "tenant", "session", new byte[0]);
        assertThat(jdbc.query("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session", (row, index) -> ManagedAgentStore.readBinding(row))
                .getFirst().getStorageId()).isEqualTo("storage");
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_member_uninitialized");
        jdbc.update("UPDATE ma_session SET workspace_config_ref = 'changed'");
        assertThatThrownBy(() -> store(true)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Persisted Workspace configuration descriptor changed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
        jdbc.update("UPDATE ma_session SET workspace_id = NULL, workspace_generation = NULL,"
                + " workspace_storage_id = NULL, cwd_relative = NULL, context_config_ref = NULL, context_revision = NULL,"
                + " workspace_config_ref = NULL, workspace_policy_ref = NULL");
        assertThat(jdbc.query("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session", (row, index) -> ManagedAgentStore.readBinding(row))
                .getFirst()).isNull();
    }

    @Test
    void persistsFenceWithoutPublicCloseAndAbortsOnlyAfterStorageIsFenced() {
        var operation = store(true);
        assertThat(operation.inspect().path("state").asText()).isEqualTo("RETIRING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head WHERE head_kind = 'HARNESS'", Long.class)).isZero();
        assertThatThrownBy(() -> WorkspaceMigrationAdmission.requireOpen(jdbc, "tenant", "storage"));
        operation.retire(mock(RuntimeBrokerService.class));
        assertThat(operation.inspect().path("state").asText()).isEqualTo("RETIRED");
        assertThatThrownBy(operation::abort);
        guard.fence("tenant", "storage", 1, request.path("fenceOperationId").asText());
        assertThatThrownBy(() -> guard.restoreOriginal("tenant", "storage", 1, request.path("fenceOperationId").asText()));
        operation.abort();
        operation.abort();
        assertThat(operation.inspect().path("state").asText()).isEqualTo("ABORTED");
        assertThat(guard.inspect("tenant", "storage")).contains("state=fenced revision=1");
        guard.restoreOriginal("tenant", "storage", 1, request.path("fenceOperationId").asText());
    }

    @Test
    void refusesAStorageWhoseChildWorkspaceIsStillOpen() {
        jdbc.update("INSERT INTO ma_workspace (tenant_id, parent_session_id, child_run_id,"
                + " child_workspace_id, workspace_id, workspace_generation, storage_id, parent_cwd_relative,"
                + " workspace_kind, child_state, parent_workspace_id, display_name, config_ref, policy_ref, state, gmt_create, gmt_modified) VALUES ('tenant', 'parent', 'run', ?, ?, 1,"
                + " 'storage', '.', 'CHILD_GIT', 'ready', 'workspace', 'Child', 'config', 'policy', 'ACTIVE', 0, 0)", "0".repeat(32), "0".repeat(32));
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_work_unsettled");
        // A landed merge still owes its cleanup.
        jdbc.update("UPDATE ma_workspace SET child_state = 'applied' WHERE child_workspace_id = ?",
                "0".repeat(32));
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_work_unsettled");
        jdbc.update("UPDATE ma_workspace SET child_state = 'conflicted' WHERE child_workspace_id = ?",
                "0".repeat(32));
        assertThat(store(true).inspect().path("state").asText()).isEqualTo("RETIRING");
    }

    @Test
    void rejectsChangedRequestAndConcurrentStorageOwner() {
        store(true);
        request.put("targetRoot", temp.resolve("another").toString());
        assertThatThrownBy(() -> store(true)).hasMessageContaining("operation_conflict");
        request.put("migrationOperationId", UUID.randomUUID().toString());
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_conflict");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isEqualTo(1);
    }

    @Test
    void preservesTheServiceRefusalCodeWhenMountIdentityBecomesUnreadable() throws Exception {
        var operation = store(true);
        operation.retire(mock(RuntimeBrokerService.class));
        guard.fence("tenant", "storage", 1, request.path("fenceOperationId").asText());
        unreadableIdentity = target;
        assertThatThrownBy(() -> operation.verify(false)).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(WorkspaceRecoveryStore.errorCode(error)).isEqualTo("workspace_unavailable");
                    operation.failed(WorkspaceRecoveryStore.errorCode(error));
                });
        assertThat(operation.inspect().path("state").asText()).isEqualTo("RETIRED");
        assertThat(operation.inspect().path("lastErrorCode").asText()).isEqualTo("workspace_unavailable");
    }

    @Test
    void publishesOnlyThePinnedTargetMarkerAndPromotesOneHigherRevision() throws Exception {
        var operation = store(true);
        operation.retire(mock(RuntimeBrokerService.class));
        guard.fence("tenant", "storage", 1, request.path("fenceOperationId").asText());
        var original = guard.recoveryRegistration("tenant", "storage", 1, request.path("fenceOperationId").asText());
        Files.copy(source.resolve(".qwen-managed-storage.json"), target.resolve(".qwen-managed-storage.json"));
        var identity = guard.migrationIdentity(target);
        var registration = UUID.randomUUID().toString();
        byte[] marker = guard.migrationMarker("tenant", "storage", identity, registration);
        Path temporary = WorkspaceStorageGuard.migrationTemporary(target, request.path("migrationOperationId").asText());
        assertThat(temporary.getParent()).isEqualTo(target);
        Files.write(temporary, java.util.Arrays.copyOf(marker, marker.length / 2));
        guard.discardMigrationTemporary(target, marker, request.path("migrationOperationId").asText());
        assertThat(temporary).doesNotExist();
        Files.writeString(temporary, "conflicting object");
        assertThatThrownBy(() -> guard.discardMigrationTemporary(target, marker, request.path("migrationOperationId").asText()));
        assertThat(Files.readString(temporary)).isEqualTo("conflicting object");
        Files.delete(temporary);
        guard.publishMigrationMarker(target, marker, original, request.path("migrationOperationId").asText());
        guard.publishMigrationMarker(target, marker, original, request.path("migrationOperationId").asText());
        assertThat(Files.readAllBytes(target.resolve(".qwen-managed-storage.json"))).isEqualTo(marker);
        assertThat(Files.readString(source.resolve(".qwen-managed-storage.json"))).contains(source.toString());
        guard.promoteMigration(original, identity, registration, request.path("migrationOperationId").asText());
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner WHERE storage_key = (SELECT physical_key FROM ma_storage WHERE alias_key = ?)", Long.class, JdbcRuntimeBindingRepository.storageAliasKey("tenant", "storage"))).isEqualTo(2);
        assertThatThrownBy(() -> guard.promoteMigration(original, identity, registration, request.path("migrationOperationId").asText()));
    }
}
