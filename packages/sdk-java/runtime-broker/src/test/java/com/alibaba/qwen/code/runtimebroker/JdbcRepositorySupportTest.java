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
    void preservesLegacyHashesAndSeparatesManagedStorageIdentity() {
        RuntimeProvisionRequest managed = ManagedContextProtocolTest.request();
        RuntimeProvisionRequest legacy = new RuntimeProvisionRequest(
                managed.getScope(), null, managed.getProvisionerKind());
        assertEquals("9483cdc5e70f3594cb9abf3416c592c710e23494cb1d52c2ae2d4b4520cc715f",
                JdbcRepositorySupport.scopeKey(managed.getScope()));
        assertEquals("a6a254c7261ee5da2dd213d5a3f399f740e5c77ced4069b188f74dcb54973d54",
                JdbcRepositorySupport.requestKey(legacy));
        org.junit.jupiter.api.Assertions.assertNotEquals(JdbcRepositorySupport.requestKey(legacy),
                JdbcRepositorySupport.requestKey(managed));
        RuntimeProvisionRequest other = new RuntimeProvisionRequest(managed.getScope(), null,
                managed.getProvisionerKind(), "different-storage");
        org.junit.jupiter.api.Assertions.assertNotEquals(JdbcRepositorySupport.requestKey(managed),
                JdbcRepositorySupport.requestKey(other));
    }

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
