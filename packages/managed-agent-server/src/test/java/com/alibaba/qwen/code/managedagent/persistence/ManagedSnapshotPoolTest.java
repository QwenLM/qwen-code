package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSnapshotPoolTest {
    private DruidDataSource source;
    private ManagedSchemaJdbcTemplate jdbc;

    @BeforeEach
    void setup() throws Exception {
        source = new DruidDataSource();
        source.setUrl("jdbc:h2:mem:snapshot-pool-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        source.setMaxActive(1);
        // Creating the first connection runs the schema DDL, which can exceed a
        // short lease on a loaded runner and fails setup with
        // "Fresh Managed schema initialization failed".
        source.setMaxWait(3_000L);
        source.setInitialSize(1);
        source.init();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified, tenant_key, session_key, session_scope_key) VALUES ('tenant', 'session', 'qwen-code', 0, 0, ?, ?, ?)",
                ManagedSchemaKeys.key("tenant"), ManagedSchemaKeys.key("session"),
                ManagedSessionStore.sessionScopeKey("tenant", "session"));
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, last_sequence, covered_sequence, gmt_modified) VALUES ('tenant', 'session', 'SESSION', X'', 1, 1, 0)");
    }

    @AfterEach
    void close() {
        source.close();
    }

    @Test
    void readsMessagePagesWithOneConnection() {
        jdbc.update("INSERT INTO ma_message (tenant_id,session_id,item_id,turn_id,item_type,item_role,item_status,attributes_json,"
                + "first_sequence,last_sequence,gmt_create,gmt_modified,parts_json)"
                + " VALUES ('tenant','session','item','turn','message','assistant','completed','{}',1,1,0,0,'[]')");
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        var view = new TransactionTemplate(new DataSourceTransactionManager(source));
        view.setReadOnly(true);
        view.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        assertThat(view.execute(status -> store.findMessagePage("tenant", "session", null, 20, true)).items())
                .singleElement().satisfies(item -> assertThat(item.itemId()).isEqualTo("item"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_read_lease", Integer.class)).isZero();
    }

    @Test
    void retainedPrivatePinPreventsReleasedBodyCollection() {
        var manager = new DataSourceTransactionManager(source);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,session_id,resource_id,kind,schema_version,"
                + "byte_length,sha256,storage_kind,inline_bytes,state,gmt_create,retention_until)"
                + " VALUES (?,?,'tenant','session','released','managed-message-parts',1,2,?,'MYSQL_INLINE',?,'REFERENCED',0,0)",
                ManagedSchemaKeys.key(scope, "released"), scope, "a".repeat(64), new byte[] {91, 93});
        jdbc.update("UPDATE ma_resource SET retention_until = " + ManagedSchemaTime.SQL_NOW);
        jdbc.update("UPDATE ma_session SET runtime_request_key = ?", "a".repeat(64));
        var resources = jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource");
        var refs = jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE_REF.columns() + " FROM ma_resource_ref");
        var collector = new ManagedProjectionResourceCollector(jdbc, manager);
        assertThat(collector.runOnce()).isFalse();
        assertThat(jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource"))
                .usingRecursiveComparison()
                .isEqualTo(resources);
        assertThat(jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE_REF.columns() + " FROM ma_resource_ref")).isEqualTo(refs);
    }

    @Test
    void readsSessionAndStreamCountersWithOneConnection() {
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        assertThat(store.findSession("tenant", "session").orElseThrow().lastSequence()).isEqualTo(1);
        assertThat(store.findSessionById("session")).isPresent();
    }

    @Test
    void renewsBeforeReturningFromAReadViewWithoutBorrowingInsideIt() {
        var manager = new DataSourceTransactionManager(source);
        var retention = new ToolPublicationRetentionStore(jdbc, manager);
        try (var lease = retention.read("tenant", "session")) {
            long deadline = ToolPublicationRetentionStore.now(jdbc) + 60_000;
            jdbc.update("UPDATE ma_read_lease SET expires_at = ?", deadline);
            var view = new TransactionTemplate(manager);
            view.setReadOnly(true);
            view.executeWithoutResult(status -> {
                lease.checkReadView();
                assertThat(jdbc.queryForObject("SELECT expires_at FROM ma_read_lease", Long.class))
                        .isEqualTo(deadline);
            });
            lease.check();
            assertThat(jdbc.queryForObject("SELECT expires_at FROM ma_read_lease", Long.class))
                    .isGreaterThan(deadline);
        }
    }

    @Test
    void expiredLeaseStopsTheReadViewWithoutRenewingIt() {
        var manager = new DataSourceTransactionManager(source);
        var retention = new ToolPublicationRetentionStore(jdbc, manager);
        try (var lease = retention.read("tenant", "session")) {
            jdbc.update("UPDATE ma_read_lease SET expires_at = 0");
            var view = new TransactionTemplate(manager);
            view.setReadOnly(true);
            assertThatThrownBy(() -> view.executeWithoutResult(status -> lease.checkReadView()))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("tool_output_read_expired"));
        }
    }
}
