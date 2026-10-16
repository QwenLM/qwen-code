package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedModelContextRetentionTest {
    @Test
    void existingRetirementReleasesThePrivateObservationAndItsResourceReference() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:model-context-retirement-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        String record = ManagedExtensionProjection.recordKey("session", "hosted_context_usage", "latest");
        String resource = ManagedSchemaKeys.key(scope, "resource");
        byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified,"
                + " retired_at) VALUES ('tenant', 'session', 'qwen-code', 1, 1, 1)");
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id,"
                + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                + " inline_bytes, state, gmt_create) VALUES (?, ?, 'tenant', 'workspace', 'session',"
                + " 'resource', 'managed-hosted-model-usage', 1, 2, ?, 'MYSQL_INLINE', ?,"
                + " 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")", resource, scope, "a".repeat(64), body);
        jdbc.update("INSERT INTO ma_session_record (record_kind, session_scope_key, record_key,"
                + " tenant_id, workspace_id, session_id, domain, record_id, revision,"
                + " record_resource_id, gmt_create, settled_at, first_sequence) VALUES ('DOMAIN',"
                + " ?, ?, 'tenant', 'workspace', 'session', 'hosted_context_usage', 'latest', 2,"
                + " 'resource', 1, 2, 1)", scope, record);
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                + " owner_revision, resource_key, tenant_id, workspace_id, session_id, resource_id,"
                + " gmt_create) VALUES (?, 'SESSION_RECORD', ?, 2, ?, 'tenant', 'workspace',"
                + " 'session', 'resource', " + ManagedSchemaTime.SQL_NOW + ")", scope, record, resource);

        var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        Boolean changed = transaction.execute(status -> ManagedSessionRetirementStore.deleteOwnerBatch(
                jdbc, "tenant", "session", 32));
        assertThat(changed).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind ="
                + " 'SESSION_RECORD'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Integer.class)).isEqualTo(1);
    }
}
