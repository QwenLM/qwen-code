package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSessionOwnerTest {
    @Test
    void writesTheOwnerAsTheCreatorOnEveryCreationPath() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:session-owner-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
        JdbcTemplate jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 1, 'storage', 'Workspace', ?, ?,"
                + " 'ACTIVE')", WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES ('tenant',"
                + " 'workspace', ?, 'OPERATOR')",
                "actor".getBytes(StandardCharsets.UTF_8));
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(source));

        String bound = transactions.execute(ignored -> store
                .insertWorkspaceSessionCommand("tenant", "actor", "bound",
                        "digest-bound", "qwen-code", null, null, List.of(),
                        null, new WorkspaceSelection("workspace", "."))
                .sessionId());
        assertThat(jdbc.queryForObject("SELECT owner_actor_key FROM"
                + " ma_session WHERE session_id = ?",
                byte[].class, bound))
                .isEqualTo("actor".getBytes(StandardCharsets.UTF_8));
        assertThat(jdbc.queryForObject("SELECT owner_actor_key FROM"
                + " ma_session WHERE session_id = ?",
                byte[].class, bound))
                .isEqualTo(jdbc.queryForObject("SELECT creator_actor_key FROM"
                        + " ma_session WHERE session_id = ?",
                        byte[].class, bound));

        store.insertSessionCommand("tenant", "actor", "CREATE_SESSION",
                "legacy", "digest-legacy", "qwen-code", null, null, List.of(),
                null);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_session WHERE owner_actor_key"
                + " = creator_actor_key AND creator_actor_key IS NOT NULL",
                Integer.class)).isEqualTo(2);

        store.insertSessionCommand("tenant", "CREATE_SESSION", "anonymous",
                "digest-anonymous", "qwen-code", null, null, List.of(),
                null);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_session WHERE owner_actor_key IS NULL"
                + " AND creator_actor_key IS NULL", Integer.class))
                .isEqualTo(1);
    }
}
