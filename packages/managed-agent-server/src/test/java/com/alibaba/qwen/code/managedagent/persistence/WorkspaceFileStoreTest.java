package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
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
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;

class WorkspaceFileStoreTest {
    @TempDir
    Path temp;
    JdbcTemplate jdbc;
    WorkspaceFileStore files;
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
        var registry = new ManagedWorkspaceRegistry(jdbc);
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties,
                path -> new WorkspaceStorageGuard.Identity(path.toString(), "test-host", "1", "2", "2026-10-15T00:00:00.123456789Z"));
        var mapper = new ObjectMapper();
        workspace = new WorkspaceCreationStore(jdbc, manager, guard, registry, properties, mapper, Clock.systemUTC())
                .create("tenant", "actor", "Files", "create").workspaceId();
        files = new WorkspaceFileStore(registry, guard, mock(SshWorkspaceService.class), properties, jdbc, manager, mapper);
    }

    Map<String, Object> result() {
        return Map.of("files", Map.of("protocolVersion", 1, "entries", java.util.List.of(
                Map.of("path", "a.txt", "name", "a.txt", "kind", "file")), "truncated", false));
    }

    WorkspaceFileStore.QueryResult query() {
        return files.query("tenant", "actor", workspace, ".", ".", "", null);
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
