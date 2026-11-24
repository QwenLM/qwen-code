package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ChildWorkspaceStoreTest {
    private JdbcTemplate jdbc;
    private JdbcChildWorkspaceStore store;

    @BeforeEach
    void setup() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:child-admission-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        store = new JdbcChildWorkspaceStore(jdbc, new DataSourceTransactionManager(source));
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant', 'workspace', 1, 'storage', 'Project', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
    }

    @ParameterizedTest
    @ValueSource(strings = {"LOCAL", "UNREGISTERED"})
    void admitsAndReplaysLocalChildWorkspaces(String kind) {
        alias("storage", kind);
        var first = store.admit("tenant", "parent", "run", binding("storage"), 1);
        assertThat(first.state()).isEqualTo(JdbcChildWorkspaceStore.PREPARING);
        assertThat(store.admit("tenant", "parent", "run", binding("storage"), 2)).isEqualTo(first);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace WHERE workspace_kind = 'CHILD_GIT'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CHILD_WORKSPACE'", Integer.class)).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"SSH_LOCAL", "EXTERNAL"})
    void refusesNonLocalStorageBeforeWritingAChildWorkspaceOrOperation(String kind) {
        alias("storage", kind);
        assertThatThrownBy(() -> store.admit("tenant", "parent", "run", binding("storage"), 1))
                .isInstanceOf(RuntimeBrokerException.class);
        assertUnchanged();
    }

    @Test
    void cannotSubstituteALocalAliasForTheRemoteParentsStorage() {
        alias("storage", "SSH_LOCAL");
        alias("local-alias", "LOCAL");
        assertThatThrownBy(() -> store.admit("tenant", "parent", "run", binding("local-alias"), 1))
                .isInstanceOf(RuntimeBrokerException.class);
        assertUnchanged();
    }

    private void assertUnchanged() {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT storage_id FROM ma_workspace WHERE workspace_id = ?", String.class, "workspace"))
                .isEqualTo("storage");
    }

    private void alias(String id, String kind) {
        jdbc.update("INSERT INTO ma_storage (tenant_id, storage_id, storage_kind) VALUES (?, ?, ?)",
                "tenant", id, kind);
        if ("LOCAL".equals(kind)) {
            String physical = WorkspaceTestStorage.key("tenant", id);
            jdbc.update("INSERT INTO ma_storage_owner (physical_id, storage_kind, mount_state, mount_revision)"
                    + " VALUES (?, 'LOCAL', 'READY', 1)", physical);
            jdbc.update("UPDATE ma_storage SET physical_id = ?, registration_state = 'REGISTERED', registration_revision = 1,"
                    + " registration_json = '{}', mount_revision = 1 WHERE tenant_id = ? AND storage_id = ?",
                    physical, "tenant", id);
        }
    }

    private static ContextBinding binding(String storage) {
        return new ContextBinding("tenant", "workspace", 1, storage, ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
    }
}
