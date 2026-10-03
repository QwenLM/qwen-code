package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.mock;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
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

    @BeforeEach
    void setup() throws Exception {
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
        guard = new WorkspaceStorageGuard(jdbc, manager, properties, path -> new WorkspaceStorageGuard.Identity(
                path.toRealPath().toString(), "test-host", "device", path.getFileName().toString(), "2026-10-02T00:00:00Z"));
        guard.register("tenant", "storage", UUID.randomUUID().toString());
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
