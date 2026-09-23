package com.alibaba.qwen.code.runtimebroker;

import java.sql.Connection;
import java.sql.PreparedStatement;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

class JdbcRuntimeBrokerMySqlIT {
    @Test
    void repositoriesPreserveTheirContractsOnMySql() throws Exception {
        JdbcRepositoryContract.verify(dataSource(), "mysql");
    }

    @Test
    void databaseClockIgnoresSessionTimeZone() throws Exception {
        DataSource dataSource = dataSource();
        for (String offset : new String[] {"+00:00", "+08:00", "-04:00"}) {
            try (Connection connection = dataSource.getConnection();
                    PreparedStatement timeZone = connection.prepareStatement(
                            "SET time_zone = '" + offset + "'")) {
                timeZone.execute();
                JdbcRepositorySupportTest.assertStorageSafeClock(
                        JdbcRepositorySupport.databaseNow(connection));
            }
        }
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
