package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** Optional operation variant fields are present in the fresh baseline. */
class ManagedOperationSchemaUpgradeTest {
    @Test
    void readsAbsentAndPopulatedLifecycleVariantFieldsWithoutASecondSchema() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:operation-baseline-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var jdbc = new JdbcTemplate(source);
        var store =
                new ManagedAgentStore(
                        jdbc,
                        new ObjectMapper(),
                        Clock.systemUTC(),
                        ignored -> {},
                        new ManagedWorkspaceRegistry(jdbc),
                        new ManagedAgentProperties());
        String scope = ManagedSessionStore.sessionScopeKey("t", "s");
        jdbc.update(
                "INSERT INTO ma_operation"
                    + " (operation_key,scope_key,operation_id,operation_kind,tenant_id,session_id,"
                    + "target_kind,target_key,request_digest,request_json,state,phase,admission_stage,delivery_state,session_status_before,gmt_create,gmt_modified)"
                    + " VALUES (?,?,?,'CLOSE',?,?,'SESSION',?,'digest','{}',"
                    + "'PENDING','PENDING','JAVA_DURABLE','PENDING','ACTIVE',0,0)",
                ManagedSchemaKeys.key("operation"),
                scope,
                "op-1",
                "t",
                "s",
                ManagedSchemaKeys.key("s"));
        assertThat(store.findOperation("t", "s", "op-1"))
                .hasValueSatisfying(
                        operation -> {
                            assertThat(operation.targetCwdRelative()).isNull();
                            assertThat(operation.expectedContextRevision()).isNull();
                            assertThat(operation.resultContextRevision()).isNull();
                            assertThat(operation.lifecycleProtocolVersion()).isZero();
                        });
        jdbc.update(
                "UPDATE ma_operation SET"
                    + " lifecycle_protocol_version=1,target_cwd_relative=?,expected_context_revision=2,result_context_revision=3"
                    + " WHERE operation_key=?",
                ".",
                ManagedSchemaKeys.key("operation"));
        assertThat(store.findOperation("t", "s", "op-1"))
                .hasValueSatisfying(
                        operation -> {
                            assertThat(operation.lifecycleProtocolVersion()).isEqualTo(1);
                            assertThat(operation.targetCwdRelative()).isEqualTo(".");
                            assertThat(operation.expectedContextRevision()).isEqualTo(2L);
                            assertThat(operation.resultContextRevision()).isEqualTo(3L);
                        });
        ManagedSchema.validate(source);
    }
}
