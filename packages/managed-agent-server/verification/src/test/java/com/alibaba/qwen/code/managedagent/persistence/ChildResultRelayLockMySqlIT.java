package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore.RelayRow;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The classification's locking read under real InnoDB. The H2 suite pins the
 * mirror's state machine; only MySQL proves the lock scope: a lookup that
 * matches the session scope without the record's primary key takes next-key
 * locks across the Session, so an unrelated child run's commit waits behind a
 * classification that has nothing to do with it.
 */
class ChildResultRelayLockMySqlIT {
    private static final String TENANT = "tenant-relay-lock";
    private static final String SESSION = "session-relay-lock";

    private IsolatedManagedSchemaMySqlTestDatabase database;
    private JdbcTemplate jdbc;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        insert("run-lock");
        insert("run-keep");
    }

    @AfterEach
    void cleanUp() {
        if (database != null) {
            database.close();
        }
    }

    private void insert(String run) {
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, gmt_create)"
                        + " VALUES (?, ?, ?, 'workspace', ?, 'child_run', ?,"
                        + " 'h', 1, ?, 'child_agent', 'pending', 'session',"
                        + " 'accepted', 1)",
                ManagedSessionStore.sessionScopeKey(TENANT, SESSION),
                ManagedExtensionProjection.recordKey(SESSION, "child_run",
                        run),
                TENANT, SESSION, run, "resource-" + run);
    }

    @Test
    void contentBootstrapRetainsItsReceiptIdentityAcrossOtherTurnsOnMySql() {
        String child = "content-child";
        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,status,gmt_create,gmt_modified,"
                + "workspace_id,workspace_generation,workspace_storage_id,cwd_relative,context_config_ref,"
                + "context_revision,workspace_config_ref,workspace_policy_ref,tool_profile,public_child_agents_version)"
                + " VALUES (?,?,'qwen-code','ACTIVE',1,1,'workspace',1,'storage','.','context',1,'config','policy',"
                + "'hosted-workspace-external-files/2',1)", TENANT, SESSION);
        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,status,gmt_create,gmt_modified,"
                + "workspace_id,workspace_generation,workspace_storage_id,cwd_relative,context_config_ref,"
                + "context_revision,workspace_config_ref,workspace_policy_ref,tool_profile,public_child_agents_version,parent_session_id,root_session_id,"
                + "parent_child_run_id,child_depth)"
                + " VALUES (?,?,'qwen-code','ACTIVE',1,1,'workspace',1,'storage','.','context',1,'config','policy',"
                + "'hosted-workspace-external-files/2',1,?,?,'content-run',1)", TENANT, child, SESSION, SESSION);
        for (int index = 0; index < 3; index++) {
            jdbc.update("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,payload_digest,"
                    + "status,is_submission_attempted,gmt_create,gmt_modified) VALUES (?,?,?,?,'[]','d','COMPLETED',TRUE,?,?)",
                    TENANT, child, "turn-" + index, "prompt-" + index, index + 1, index + 1);
        }
        ManagedReceipts.insertCreation(jdbc, TENANT,
                ManagedWorkspaceRegistry.actorKey(TENANT, ChildSessionAdmissions.childActorOf(SESSION)),
                "content-creation", "digest", child, "turn-1", 1);
        var store = new JdbcChildResultRelayStore(jdbc);
        var row = new RelayRow(TENANT, SESSION, "content-run", "content-creation", child,
                "binding", "owner", 100, 0, 0, null, 0, 0);
        assertThat(store.bootstrapAdmission(row, child).promptId()).isEqualTo("prompt-1");
        assertThat(store.bootstrapAdmission(row, child).turn().turnId()).isEqualTo("turn-1");
        assertThat(store.latestTurn(TENANT, child).turnId()).isEqualTo("turn-2");
        jdbc.update("UPDATE ma_session SET workspace_generation=2 WHERE tenant_id=? AND session_id=?", TENANT, child);
        assertThatThrownBy(() -> store.bootstrapAdmission(row, child)).hasMessageContaining("original admission");
    }

    @Test
    @Timeout(30)
    void classifyLocksOnlyItsOwnRecord() throws Exception {
        long now = System.currentTimeMillis();
        JdbcChildResultRelayStore store = new JdbcChildResultRelayStore(jdbc);
        RelayRow row = store.claim(TENANT, SESSION, "run-lock", "key-lock",
                "owner", now + 30_000, now);
        assertThat(row).isNotNull();
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        JdbcTemplate pausing = new JdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> List<T> query(String sql, RowMapper<T> rowMapper,
                    Object... args) {
                List<T> result = super.query(sql, rowMapper, args);
                if (sql.contains("FOR UPDATE")
                        && sql.contains("ma_session_record")) {
                    locked.countDown();
                    try {
                        release.await(10, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
                return result;
            }
        };
        JdbcChildResultRelayStore pausingStore = new JdbcChildResultRelayStore(
                pausing);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<?> classify = executor.submit(() -> pausingStore.classify(row,
                "owner", "done", null, now + 1_000));
        try {
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();
            try (Connection connection = database.source().getConnection()) {
                try (Statement statement = connection.createStatement()) {
                    statement.execute(
                            "SET SESSION innodb_lock_wait_timeout = 2");
                }
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE ma_session_record SET delivery_state ="
                                + " 'consumed' WHERE record_kind = 'DOMAIN'"
                                + " AND session_scope_key = ? AND record_key = ?")) {
                    update.setString(1, ManagedSessionStore.sessionScopeKey(
                            TENANT, SESSION));
                    update.setString(2, ManagedExtensionProjection.recordKey(
                            SESSION, "child_run", "run-keep"));
                    assertThat(update.executeUpdate())
                            .as("the unrelated record still commits")
                            .isEqualTo(1);
                }
            }
        } finally {
            release.countDown();
        }
        classify.get(10, TimeUnit.SECONDS);
        executor.shutdownNow();
    }
}
