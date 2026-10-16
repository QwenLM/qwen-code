package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedWorkspaceRolesMigrationTest {
    private static final byte[] OPERATOR = "operator"
            .getBytes(StandardCharsets.UTF_8);
    private static final byte[] READER = "reader"
            .getBytes(StandardCharsets.UTF_8);
    private static final byte[] CREATOR = "creator"
            .getBytes(StandardCharsets.UTF_8);

    @Test
    void freshRoleConstraintsAndSessionOwnerAuthorityRemainExact() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:workspace-roles-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        JdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 1, 'storage', 'Workspace',"
                + " 'config', 'policy', 'ACTIVE')");
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', 'workspace', ?, 'OPERATOR')", OPERATOR);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', 'workspace', ?, 'READER')", READER);
        assertThat(new ManagedWorkspaceRegistry(jdbc).accessOf("tenant", "operator", "workspace").canCreate()).isTrue();
        assertThat(new ManagedWorkspaceRegistry(jdbc).accessOf("tenant", "reader", "workspace").canCreate()).isFalse();
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " ma_workspace_access (tenant_id, workspace_id,"
                + " actor_id, role) VALUES ('tenant', 'workspace', ?,"
                + " 'NONE')", "none-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " ma_workspace_access (tenant_id, workspace_id,"
                + " actor_id, role) VALUES ('tenant', 'workspace', ?,"
                + " 'SPECTATOR')",
                "spectator-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);
        // role carries no default: an INSERT omitting it must fail loudly,
        // as omitting a boolean did under the old NOT NULL columns.
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " ma_workspace_access (tenant_id, workspace_id,"
                + " actor_id) VALUES ('tenant', 'workspace', ?)",
                "default-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);
        // PAD SPACE comparisons accept a padded value into an IN-list
        // CHECK; the length-guarded CHECK stores only byte-exact enum
        // names.
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " ma_workspace_access (tenant_id, workspace_id,"
                + " actor_id, role) VALUES ('tenant', 'workspace', ?,"
                + " 'READER ')",
                "padded-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);

        // A creation written after V53 keeps owner = creator on the store
        // path too; the two columns now only diverge through the handover
        // command that a later slice adds.
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES ('tenant',"
                + " 'workspace', ?, 'OPERATOR')", CREATOR);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        String sessionId = transactions.execute(ignored -> store
                .insertWorkspaceSessionCommand("tenant", "creator", "create",
                        "digest", "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("workspace", "."))
                .sessionId());
        assertThat(jdbc.queryForObject("SELECT owner_actor_key FROM"
                + " ma_session WHERE session_id = ?",
                byte[].class, sessionId)).isEqualTo(CREATOR);
    }
}
