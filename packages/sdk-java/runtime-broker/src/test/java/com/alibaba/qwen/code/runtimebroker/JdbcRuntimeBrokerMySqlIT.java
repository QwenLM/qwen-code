package com.alibaba.qwen.code.runtimebroker;

import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

class JdbcRuntimeBrokerMySqlIT {
    @Test
    void repositoriesPreserveTheirContractsOnMySql() throws Exception {
        JdbcRepositoryContract.verify(dataSource(), "mysql");
    }

    private static DataSource dataSource() {
        return new DriverManagerDataSource(required("mysql.url"),
                required("mysql.user"),
                System.getProperty("mysql.password", ""));
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
