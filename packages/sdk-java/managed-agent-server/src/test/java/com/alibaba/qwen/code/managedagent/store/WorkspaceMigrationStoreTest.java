package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.mock;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

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
        Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(data);
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
            jdbc.update("INSERT INTO managed_workspace_csi_registration"
                    + " (alias_key, tenant_id, storage_id, physical_key, registration_revision, registration_json)"
                    + " VALUES (?, 'tenant', 'storage', ?, 1, '{}')",
                    WorkspaceCsiRegistration.aliasKey("tenant", "storage"), "a".repeat(64));
        } else {
            jdbc.update("UPDATE managed_workspace_execution_lease SET storage_kind = 'CSI'");
        }
        var registration = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        byte[] marker = Files.readAllBytes(source.resolve(".qwen-managed-storage.json"));
        assertThatThrownBy(() -> store(true)).isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
            assertThat(error.getCode()).isEqualTo("workspace_unavailable");
            assertThat(error.isRetryable()).isFalse();
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_storage_fence", Long.class)).isZero();
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(registration);
        assertThat(Files.readAllBytes(source.resolve(".qwen-managed-storage.json"))).isEqualTo(marker);
    }

    @Test
    void rejectsNonPrivateStateDirectoryBeforeInstallingAnyFence() throws Exception {
        Path directory = Path.of(request.path("stateDirectory").asText());
        var permissions = PosixFilePermissions.fromString("rwxr-xr-x");
        Files.setPosixFilePermissions(directory, permissions);
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_state_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_storage_fence", Long.class)).isZero();
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_storage_fence", Long.class)).isZero();
    }

    @Test
    void rejectsUnprovedHistoryIdentityBeforeInstallingAnyFenceAndPreservesOperationReplay() throws Exception {
        unreadableIdentity = Path.of(request.path("fileHistoryRoot").asText());
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_history_unverified");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_storage_fence", Long.class)).isZero();
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
        jdbc.update("UPDATE managed_workspace_recovery_operation SET state = 'SEALED', manifest_digest = ?, result_json = '{}'"
                + " WHERE operation_id = ?", "0".repeat(64), request.path("captureOperationId").asText());
        assertThatThrownBy(() -> operation.verify(false)).isInstanceOfSatisfying(
                WorkspaceRecoveryStore.RecoveryFailure.class, error -> {
                    assertThat(error.code).isEqualTo(code);
                    operation.failed(error.code);
                });
        String attempt = operation.inspect().path("verifyOperationId").asText();
        assertThat(operation.inspect().path("state").asText())
                .isEqualTo("source_drift".equals(code) ? "INVALIDATED" : "PREPARING");
        assertThat(operation.inspect().path("lastErrorCode").asText()).isEqualTo(code);
        assertThat(jdbc.queryForObject("SELECT last_error_code FROM managed_workspace_recovery_operation WHERE operation_id = ?",
                String.class, attempt)).isEqualTo(code);
        if (!"source_drift".equals(code)) {
            assertThatThrownBy(() -> operation.verify(false)).hasMessageContaining(code);
            assertThat(operation.inspect().path("verifyOperationId").asText()).isEqualTo(attempt);
        }
    }

    @Test
    void sharesFenceOwnershipWithTheJdbcBrokerAndClearsBothReaders() {
        var bindings = new JdbcRuntimeBindingRepository(jdbc.getDataSource(),
                new AesGcmSecretProtector("test", new byte[32]));
        var operation = new WorkspaceMigrationStore(jdbc, manager, guard, bindings,
                request.toString().getBytes(StandardCharsets.UTF_8), true);
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_storage_fence", Long.class)).isZero();
    }

    @Test
    void rejectsDescriptorDriftBeforeRetirementAndReusesTheNormalBindingReader() {
        jdbc.update("INSERT INTO managed_agent_session (tenant_id, session_id, agent_id, status, created_at, updated_at,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref)"
                + " VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1, 'workspace', 1, 'storage', '.', ?, 1, ?, ?)",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_create_command (tenant_id, actor_id, idempotency_key, request_digest,"
                + " session_id, created_at) VALUES ('tenant', ?, 'create', 'sha256:test', 'session', 1)",
                "owner".getBytes(StandardCharsets.UTF_8));
        assertThat(jdbc.query("SELECT * FROM managed_agent_session", (row, index) -> ManagedAgentStore.readBinding(row))
                .getFirst().getStorageId()).isEqualTo("storage");
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_member_uninitialized");
        jdbc.update("UPDATE managed_agent_session SET workspace_config_ref = 'changed'");
        assertThatThrownBy(() -> store(true)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Persisted Workspace configuration descriptor changed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_storage_fence", Long.class)).isZero();
        jdbc.update("UPDATE managed_agent_session SET workspace_id = NULL, workspace_generation = NULL,"
                + " workspace_storage_id = NULL, cwd_relative = NULL, context_config_ref = NULL, context_revision = NULL,"
                + " workspace_config_ref = NULL, workspace_policy_ref = NULL");
        assertThat(jdbc.query("SELECT * FROM managed_agent_session", (row, index) -> ManagedAgentStore.readBinding(row))
                .getFirst()).isNull();
    }

    @Test
    void persistsFenceWithoutPublicCloseAndAbortsOnlyAfterStorageIsFenced() {
        var operation = store(true);
        assertThat(operation.inspect().path("state").asText()).isEqualTo("RETIRING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_harness_drain", Long.class)).isZero();
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
    void rejectsChangedRequestAndConcurrentStorageOwner() {
        store(true);
        request.put("targetRoot", temp.resolve("another").toString());
        assertThatThrownBy(() -> store(true)).hasMessageContaining("operation_conflict");
        request.put("migrationOperationId", UUID.randomUUID().toString());
        assertThatThrownBy(() -> store(true)).hasMessageContaining("migration_conflict");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_migration", Long.class)).isEqualTo(1);
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
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM managed_workspace_execution_lease", Long.class)).isEqualTo(2);
        assertThatThrownBy(() -> guard.promoteMigration(original, identity, registration, request.path("migrationOperationId").asText()));
    }
}
