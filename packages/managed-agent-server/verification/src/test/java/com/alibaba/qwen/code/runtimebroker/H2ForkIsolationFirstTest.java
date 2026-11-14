package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;

import java.sql.DriverManager;
import java.sql.SQLException;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class H2ForkIsolationFirstTest {
    @Test
    void startsWithoutAnotherTestClassCatalog() throws SQLException {
        boolean surefire = System.getProperty("surefire.test.class.path") != null;
        if ("true".equals(System.getenv("GITHUB_ACTIONS"))) {
            assertTrue(surefire, "CI must run the H2 fork-isolation check through Surefire");
        }
        assumeTrue(surefire, "This checks Maven's test-class fork boundary");
        try (var connection = DriverManager.getConnection(
                "jdbc:h2:mem:test-class-isolation;DB_CLOSE_DELAY=-1")) {
            try (var tables = connection.getMetaData().getTables(null, "PUBLIC", "CLASS_OWNER", null)) {
                assertFalse(tables.next(), "Another test class retained its H2 catalog in this JVM");
            }
            try (var statement = connection.createStatement()) {
                statement.execute("CREATE TABLE class_owner (id INTEGER PRIMARY KEY)");
            }
        }
    }
}
