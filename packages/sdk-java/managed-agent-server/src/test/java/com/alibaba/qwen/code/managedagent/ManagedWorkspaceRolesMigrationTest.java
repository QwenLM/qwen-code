package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class ManagedWorkspaceRolesMigrationTest {
    private static final byte[] OPERATOR = "operator"
            .getBytes(StandardCharsets.UTF_8);
    private static final byte[] READER = "reader"
            .getBytes(StandardCharsets.UTF_8);
    private static final byte[] CREATOR = "creator"
            .getBytes(StandardCharsets.UTF_8);

    @Test
    void backfillsRolesAndSessionOwnersAndRejectsNoRole() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:workspace-roles-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source).target("47").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(source);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 1, 'storage', 'Workspace',"
                + " 'config', 'policy', 'ACTIVE')");
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, can_read, can_create) VALUES"
                + " ('tenant', 'workspace', ?, TRUE, TRUE)", OPERATOR);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, can_read, can_create) VALUES"
                + " ('tenant', 'workspace', ?, TRUE, FALSE)", READER);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, can_read, can_create) VALUES"
                + " ('tenant', 'workspace', ?, FALSE, TRUE)",
                "write-no-read".getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, can_read, can_create) VALUES"
                + " ('tenant', 'workspace', ?, FALSE, FALSE)",
                "no-access".getBytes(StandardCharsets.UTF_8));
        insertSession(jdbc, "owned", CREATOR);
        insertSession(jdbc, "anonymous", null);

        Flyway.configure().dataSource(source).load().migrate();

        assertThat(jdbc.queryForObject("SELECT role FROM"
                + " managed_workspace_access WHERE actor_id = ?",
                String.class, OPERATOR)).isEqualTo("OPERATOR");
        assertThat(jdbc.queryForObject("SELECT role FROM"
                + " managed_workspace_access WHERE actor_id = ?",
                String.class, READER)).isEqualTo("READER");
        // Rows without can_read granted nothing under the booleans and are
        // dropped instead of gaining a role through the backfill.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " managed_workspace_access WHERE actor_id IN (?, ?)",
                Integer.class, "write-no-read".getBytes(StandardCharsets.UTF_8),
                "no-access".getBytes(StandardCharsets.UTF_8))).isZero();
        assertThat(jdbc.queryForObject("SELECT owner_actor_key FROM"
                + " managed_agent_session WHERE session_id = 'owned'",
                byte[].class)).isEqualTo(CREATOR);
        assertThat(jdbc.queryForObject("SELECT owner_actor_key FROM"
                + " managed_agent_session WHERE session_id = 'anonymous'",
                byte[].class)).isNull();
        // Fresh actor keys per negative case: reusing a seeded key would
        // let a primary-key clash (also a DataIntegrityViolationException)
        // mask the constraint actually being probed.
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " managed_workspace_access (tenant_id, workspace_id,"
                + " actor_id, role) VALUES ('tenant', 'workspace', ?,"
                + " 'NONE')", "none-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " managed_workspace_access (tenant_id, workspace_id,"
                + " actor_id, role) VALUES ('tenant', 'workspace', ?,"
                + " 'SPECTATOR')",
                "spectator-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);
        // role carries no default: an INSERT omitting it must fail loudly,
        // as omitting a boolean did under the old NOT NULL columns.
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " managed_workspace_access (tenant_id, workspace_id,"
                + " actor_id) VALUES ('tenant', 'workspace', ?)",
                "default-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);
        // PAD SPACE comparisons accept a padded value into an IN-list
        // CHECK; the REGEXP constraint stores only byte-exact enum names.
        assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                + " managed_workspace_access (tenant_id, workspace_id,"
                + " actor_id, role) VALUES ('tenant', 'workspace', ?,"
                + " 'READER ')",
                "padded-actor".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(DataIntegrityViolationException.class);

        // A creation written after V52 keeps owner = creator on the store
        // path too; the two columns now only diverge through the handover
        // command that a later slice adds.
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES ('tenant',"
                + " 'workspace', ?, 'OPERATOR')", CREATOR);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> { },
                new ManagedWorkspaceRegistry(jdbc), properties);
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        String sessionId = transactions.execute(ignored -> store
                .insertWorkspaceSessionCommand("tenant", "creator", "create",
                        "digest", "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("workspace", "."))
                .sessionId());
        assertThat(jdbc.queryForObject("SELECT owner_actor_key FROM"
                + " managed_agent_session WHERE session_id = ?",
                byte[].class, sessionId)).isEqualTo(CREATOR);
    }

    private static void insertSession(JdbcTemplate jdbc, String id,
            byte[] creatorKey) {
        jdbc.update("INSERT INTO managed_agent_session"
                + " (tenant_id, session_id, agent_id, status, created_at,"
                + " updated_at) VALUES ('tenant', ?, 'qwen-code', 'ACTIVE',"
                + " 1, 1)", id);
        if (creatorKey != null) {
            jdbc.update("UPDATE managed_agent_session SET creator_actor_key"
                    + " = ? WHERE session_id = ?", creatorKey, id);
        }
    }
}
