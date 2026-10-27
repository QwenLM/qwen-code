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
    void freshInitializerRefusesLegacyTablesWithoutChangingExistingRows() throws Exception {
        DataSource source = dataSource();
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE qwen_runtime_binding (binding_id VARCHAR(128) PRIMARY KEY)");
            statement.execute("INSERT INTO qwen_runtime_binding VALUES ('original')");
        }
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class,
                () -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source));
        try (var connection = source.getConnection(); var statement = connection.createStatement();
                var rows = statement.executeQuery("SELECT binding_id FROM qwen_runtime_binding")) {
            org.junit.jupiter.api.Assertions.assertTrue(rows.next());
            org.junit.jupiter.api.Assertions.assertEquals("original", rows.getString(1));
            org.junit.jupiter.api.Assertions.assertFalse(rows.next());
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
