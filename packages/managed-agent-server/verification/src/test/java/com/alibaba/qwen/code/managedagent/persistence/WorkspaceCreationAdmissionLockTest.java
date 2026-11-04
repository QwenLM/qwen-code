package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceCreationAdmissionLockTest {
    protected DataSource source;
    protected StoreLockTrace trace;
    protected JdbcTemplate jdbc;
    protected TransactionTemplate transactions;
    protected ManagedWorkspaceRegistry registry;

    protected DataSource dataSource() {
        var data = new JdbcDataSource();
        data.setURL("jdbc:h2:mem:workspace-admission-lock-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return data;
    }

    @BeforeEach
    void setup() {
        source = dataSource();
        ManagedSchema.initialize(source);
        trace = new StoreLockTrace(source);
        jdbc = new ManagedSchemaJdbcTemplate(trace);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(trace));
        registry = new ManagedWorkspaceRegistry(jdbc);
        register("chosen", true);
        register("unselected", false);
        trace.clear();
    }

    @Test
    void defaultSelectionReadsTheChosenWorkspaceOnce() {
        var resolved = transactions.execute(status -> {
            WorkspaceLifecycleStore.lockPlacement(jdbc, "tenant");
            return registry.resolveForCreation("tenant", "actor", null);
        });
        assertThat(resolved.binding().getWorkspaceId()).isEqualTo("chosen");
        var reads = workspaceReads();
        System.out.println("WORKSPACE_ADMISSION_PROBE default_workspace_reads=" + reads.size() + " sql=" + reads);
        assertThat(reads).as("default selection and binding validation use one locked Workspace read").hasSize(1);
    }

    @Test
    void explicitSelectionReadsTheChosenWorkspaceOnce() {
        var resolved = transactions.execute(status -> {
            WorkspaceLifecycleStore.lockPlacement(jdbc, "tenant");
            return registry.resolveForCreation("tenant", "actor", new WorkspaceSelection("unselected", "child"));
        });
        assertThat(resolved.binding().getWorkspaceId()).isEqualTo("unselected");
        assertThat(resolved.binding().getCwdRelative()).isEqualTo("child");
        assertThat(workspaceReads()).hasSize(1);
    }

    @ParameterizedTest
    @CsvSource({
        "false, missing, 400, workspace_required",
        "true, missing, 404, workspace_not_found",
        "false, grant, 400, workspace_required",
        "true, grant, 404, workspace_not_found",
        "false, reader, 400, workspace_required",
        "true, reader, 403, workspace_forbidden",
        "false, inactive, 400, workspace_required",
        "true, inactive, 409, workspace_unavailable"
    })
    void selectionRefusalsDoNotFallBackToAnotherAuthorizedWorkspace(boolean explicit, String condition,
            int status, String code) {
        switch (condition) {
            case "missing" -> jdbc.update("DELETE FROM ma_workspace WHERE workspace_id = ?", "chosen");
            case "grant" -> jdbc.update("DELETE FROM ma_workspace_access WHERE workspace_id = ?", "chosen");
            case "reader" -> jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE workspace_id = ?", "chosen");
            case "inactive" -> jdbc.update("UPDATE ma_workspace SET state = 'REMOVED' WHERE workspace_id = ?", "chosen");
            default -> throw new IllegalArgumentException(condition);
        }
        WorkspaceSelection selection = explicit ? new WorkspaceSelection("chosen", ".") : null;
        assertThatThrownBy(() -> transactions.execute(ignored -> registry.resolveForCreation("tenant", "actor", selection)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(status);
                    assertThat(error.getCode()).isEqualTo(code);
                });
    }

    @ParameterizedTest
    @ValueSource(strings = {"default", "grant", "inactive", "registration"})
    void lockingResolutionSeesChangesAfterAnEarlierReadView(String mutation) {
        transactions.executeWithoutResult(status -> {
            boolean mysql = Boolean.TRUE.equals(jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Boolean>) connection -> {
                boolean isMySql = "MySQL".equals(connection.getMetaData().getDatabaseProductName());
                if (isMySql) {
                    assertThat(connection.getTransactionIsolation()).isEqualTo(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
                }
                return isMySql;
            }));
            assertThat(jdbc.queryForObject("SELECT workspace_id FROM ma_workspace WHERE is_default = TRUE", String.class))
                    .isEqualTo("chosen");
            String snapshotSql = "SELECT r.workspace_generation, r.storage_id, r.state, r.is_default, a.role"
                    + " FROM ma_workspace r JOIN ma_workspace_access a"
                    + " ON r.tenant_id = a.tenant_id AND r.workspace_id = a.workspace_id"
                    + " WHERE r.tenant_id = ? AND r.workspace_id = ?";
            var before = jdbc.queryForMap(snapshotSql, "tenant", "chosen");
            mutateOutsideAdmission(mutation);
            if (mysql) {
                assertThat(jdbc.queryForMap(snapshotSql, "tenant", "chosen"))
                        .as("ordinary reads retain the established MySQL read view").isEqualTo(before);
            }
            assertCurrentResolution(mutation);
        });
    }

    protected void assertCurrentResolution(String mutation) {
        if ("default".equals(mutation) || "registration".equals(mutation)) {
            var current = registry.resolveForCreation("tenant", "actor", null).binding();
            assertThat(current.getWorkspaceId()).isEqualTo("default".equals(mutation) ? "unselected" : "chosen");
            assertThat(current.getWorkspaceGeneration()).isEqualTo("registration".equals(mutation) ? 2 : 1);
            assertThat(current.getStorageId()).isEqualTo("registration".equals(mutation) ? "storage-new" : "storage-unselected");
        } else {
            assertThatThrownBy(() -> registry.resolveForCreation("tenant", "actor", null))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(400);
                        assertThat(error.getCode()).isEqualTo("workspace_required");
                    });
        }
    }

    protected void mutateOutsideAdmission(String mutation) {
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            switch (mutation) {
                case "default" -> {
                    update(connection, "UPDATE ma_workspace SET is_default = FALSE WHERE workspace_id = ?", "chosen");
                    update(connection, "UPDATE ma_workspace SET is_default = TRUE WHERE workspace_id = ?", "unselected");
                }
                case "grant" -> update(connection, "DELETE FROM ma_workspace_access WHERE workspace_id = ?", "chosen");
                case "inactive" -> update(connection, "UPDATE ma_workspace SET state = 'REMOVED' WHERE workspace_id = ?", "chosen");
                case "registration" -> update(connection, "UPDATE ma_workspace SET workspace_generation = 2,"
                        + " storage_id = 'storage-new' WHERE workspace_id = ?", "chosen");
                default -> throw new IllegalArgumentException(mutation);
            }
            connection.commit();
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void update(java.sql.Connection connection, String sql, String workspace) throws SQLException {
        try (var statement = connection.prepareStatement(sql)) {
            statement.setBytes(1, workspace.getBytes(StandardCharsets.UTF_8));
            assertThat(statement.executeUpdate()).isEqualTo(1);
        }
    }

    private List<String> workspaceReads() {
        return trace.events().stream().filter(event -> event.phase() == StoreLockTrace.Phase.SUCCEEDED)
                .map(StoreLockTrace.Event::sql)
                .filter(sql -> sql.startsWith("select ") && sql.contains("from ma_workspace "))
                .toList();
    }

    private void register(String workspace, boolean isDefault) {
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state, is_default)"
                        + " VALUES ('tenant', ?, 1, ?, ?, 'config', 'policy', 'ACTIVE', ?)",
                workspace, "storage-" + workspace, workspace, isDefault);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES ('tenant', ?, ?, 'OPERATOR')",
                workspace, "actor".getBytes(StandardCharsets.UTF_8));
    }
}
