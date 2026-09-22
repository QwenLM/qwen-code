package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class JdbcRepositorySupportTest {
    @Test
    void databaseClockUsesStorageSafePrecision() throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:runtime-broker-clock-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");

        try (Connection connection = dataSource.getConnection()) {
            assertStorageSafeClock(
                    JdbcRepositorySupport.databaseNow(connection));
        }
    }

    static void assertStorageSafeClock(Instant actual) {
        assertEquals(0, actual.getNano());
        Duration drift = Duration.between(Instant.now(), actual).abs();
        assertTrue(drift.compareTo(Duration.ofSeconds(5)) < 0,
                () -> "database clock drifted by " + drift);
    }
}
