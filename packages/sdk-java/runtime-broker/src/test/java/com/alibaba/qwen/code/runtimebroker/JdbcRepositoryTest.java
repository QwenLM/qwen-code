package com.alibaba.qwen.code.runtimebroker;

import java.util.UUID;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class JdbcRepositoryTest {
    @Test
    void repositoriesPreserveTheirContractsAcrossInstances()
            throws Exception {
        JdbcRepositoryContract.verify(dataSource(), "h2");
    }

    @Test
    void standaloneInitializerUpgradesOldRowsWithoutChangingTheirOutcome() throws Exception {
        DataSource source = dataSource();
        String schema;
        try (var stream = getClass().getResourceAsStream("/com/alibaba/qwen/code/runtimebroker/schema.sql")) {
            schema = new String(stream.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)
                    .replace("    loss_evidence_json LONGTEXT,\n", "")
                    .replace("    stop_evidence_json LONGTEXT,\n", "")
                    .replace("    abandoned_at DATETIME(6),\n", "")
                    .replace("    loss_evidence_id VARCHAR(512),\n", "");
        }
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            for (String command : schema.split(";")) {
                if (!command.isBlank()) {
                    statement.execute(command);
                }
            }
        }
        JdbcRepositoryContract.writeLegacyRows(source, "standalone-upgrade");
        JdbcRuntimeBrokerSchema.initialize(source);
        JdbcRuntimeBrokerSchema.initialize(source);
        var executions = new JdbcToolExecutionRepository(source);
        for (String state : java.util.List.of("PREPARED", "UNKNOWN", "SETTLED")) {
            var stored = executions.findByIdempotencyKey("standalone-upgrade-" + state + "-key");
            org.junit.jupiter.api.Assertions.assertEquals(state, stored.getState().name());
            org.junit.jupiter.api.Assertions.assertEquals(5, stored.getVersion());
            org.junit.jupiter.api.Assertions.assertNull(stored.getLossEvidenceId());
        }
    }

    private static DataSource dataSource() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:runtime-broker-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return dataSource;
    }
}
