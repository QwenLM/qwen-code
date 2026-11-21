package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;

import java.sql.Connection;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

class JournalCheckpointValidationTest {
    @Test
    void repeatedHistoryReferencesDoNotScanOtherResourcesAndStillRequireCommittedOwners() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:checkpoint-ownership-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        try (Connection connection = source.getConnection()) {
            var statement = new AtomicReference<String>();
            var jdbc = new ManagedSchemaJdbcTemplate(source) {
                @Override
                public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
                    statement.set(sql);
                    return super.query(sql, mapper, arguments);
                }
            };
            jdbc.execute("CREATE TABLE ma_session_journal_tx (tenant_id VARBINARY, workspace_id VARBINARY,"
                    + " session_id VARBINARY, journal_revision BIGINT,"
                    + " UNIQUE (tenant_id, session_id, journal_revision))");
            jdbc.execute("CREATE TABLE ma_resource_ref (owner_kind VARCHAR(32),"
                    + " owner_ref VARBINARY(512), owner_revision BIGINT, tenant_id VARBINARY,"
                    + " workspace_id VARBINARY, session_id VARBINARY, journal_revision BIGINT, resource_id VARBINARY(512) NOT NULL,"
                    + " UNIQUE (tenant_id, session_id, owner_kind, owner_ref, owner_revision, resource_id))");
            jdbc.execute("CREATE INDEX idx_ma_ref_resource ON ma_resource_ref (resource_id, tenant_id, session_id)");
            jdbc.execute("CREATE INDEX idx_ma_ref_journal ON ma_resource_ref (tenant_id, session_id, journal_revision, resource_id)");
            String owner = ManagedIdentityRefs.ref(ManagedIdentityRefs.OWNER_REF_BYTES, "tenant", "session");
            jdbc.execute("INSERT INTO ma_session_journal_tx SELECT 'tenant', 'workspace', 'session', x"
                    + " FROM SYSTEM_RANGE(1, 1000) AS revisions(x)");
            connection.setAutoCommit(false);
            try (var insert = connection.prepareStatement("INSERT INTO ma_resource_ref VALUES ('JOURNAL', ?, ?,"
                    + " 'tenant', 'workspace', 'session', ?, ?)")) {
                for (int revision = 1; revision <= 1000; revision++) {
                    for (int resource = 0; resource < 20; resource++) {
                        insert.setString(1, owner);
                        insert.setInt(2, revision);
                        insert.setInt(3, revision);
                        insert.setBytes(4, ("resource-" + resource).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        insert.addBatch();
                    }
                }
                insert.executeBatch();
            }
            connection.commit();
            jdbc.execute("ANALYZE");
            var validation = new JournalCheckpointValidation(jdbc);
            assertThat(validation.priorCheckpointResourceRevision("tenant", "workspace", "session", "resource-19", 1000))
                    .isEqualTo(1L);
            String sql = statement.get();
            var plan = new ManagedSchemaJdbcTemplate(source).queryForObject("EXPLAIN ANALYZE " + sql, String.class,
                    "tenant", "workspace", "session", "resource-19", owner, 1000);
            var scans = Pattern.compile("scanCount: (\\d+)").matcher(plan);
            int measured = 0;
            while (scans.find()) {
                measured++;
                assertThat(Long.parseLong(scans.group(1))).isLessThan(2500L);
            }
            assertThat(measured).isGreaterThan(0);
            assertThat(validation.priorCheckpointResourceRevision("tenant", "workspace", "session", "missing", 1000)).isNull();
            assertThat(validation.priorCheckpointResourceRevision("foreign", "workspace", "session", "resource-19", 1000)).isNull();
            assertThat(validation.priorCheckpointResourceRevision("tenant", "foreign", "session", "resource-19", 1000)).isNull();
            assertThat(validation.priorCheckpointResourceRevision("tenant", "workspace", "session", "resource-19", 0)).isNull();
            jdbc.update("INSERT INTO ma_resource_ref VALUES ('JOURNAL', ?, 1001, 'tenant', 'workspace', 'session', 1001, ?)",
                    owner, "orphan");
            assertThat(validation.priorCheckpointResourceRevision("tenant", "workspace", "session", "orphan", 1001)).isNull();
            jdbc.update("INSERT INTO ma_session_journal_tx VALUES ('tenant', 'workspace', 'session', 1001)");
            assertThat(validation.priorCheckpointResourceRevision("tenant", "workspace", "session", "orphan", 1001)).isEqualTo(1001L);
        }
    }
}
