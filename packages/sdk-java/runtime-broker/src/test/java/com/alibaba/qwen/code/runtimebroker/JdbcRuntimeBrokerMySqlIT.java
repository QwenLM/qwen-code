package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.concurrent.TimeUnit;
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

    @Test
    void independentBrokerProcessesFenceProvisioningAndDispatch()
            throws Exception {
        DataSource dataSource = dataSource();
        prepareProcessFixture(dataSource);

        Process first = startBrokerProcess("mysql-process-owner-a");
        Process second = startBrokerProcess("mysql-process-owner-b");
        assertProcessSucceeded(first);
        assertProcessSucceeded(second);
        assertPhysicalCounts(dataSource);

        Process restarted = startBrokerProcess("mysql-process-owner-c");
        assertProcessSucceeded(restarted);
        assertPhysicalCounts(dataSource);
        assertEquals(1, count(dataSource,
                "SELECT COUNT(*) FROM qwen_runtime_binding "
                        + "WHERE tenant_id = 'mysql-process-tenant' "
                        + "AND binding_state = 'READY' "
                        + "AND runtime_generation = 1"));
    }

    private static void prepareProcessFixture(DataSource dataSource)
            throws SQLException {
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        List<String> statements = List.of(
                "CREATE TABLE IF NOT EXISTS p3_physical_runtime ("
                        + "provision_request_id VARCHAR(512) PRIMARY KEY)",
                "CREATE TABLE IF NOT EXISTS p3_physical_execution ("
                        + "invocation_id VARCHAR(512) PRIMARY KEY)",
                "DELETE FROM p3_physical_execution",
                "DELETE FROM p3_physical_runtime",
                "DELETE FROM qwen_tool_execution WHERE "
                        + "harness_session_id = 'shared-harness'",
                "DELETE FROM qwen_runtime_session WHERE "
                        + "harness_session_id = 'shared-harness'",
                "DELETE FROM qwen_runtime_binding WHERE "
                        + "tenant_id = 'mysql-process-tenant'",
                "DELETE FROM qwen_runtime_binding_slot WHERE "
                        + "tenant_id = 'mysql-process-tenant'");
        try (Connection connection = dataSource.getConnection()) {
            for (String sql : statements) {
                try (PreparedStatement statement =
                        connection.prepareStatement(sql)) {
                    statement.executeUpdate();
                }
            }
        }
    }

    private static Process startBrokerProcess(String owner)
            throws IOException {
        String java = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        String classpath = System.getProperty("surefire.test.class.path");
        if (classpath == null || classpath.isBlank()) {
            classpath = System.getProperty("java.class.path");
        }
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                RuntimeBrokerProcessFixtureMain.class.getName())
                .redirectErrorStream(true);
        builder.environment().put("P3_MYSQL_URL", required("mysql.url"));
        builder.environment().put("P3_MYSQL_USER", required("mysql.user"));
        builder.environment().put("P3_MYSQL_PASSWORD",
                System.getProperty("mysql.password", ""));
        builder.environment().put("P3_BROKER_OWNER", owner);
        return builder.start();
    }

    private static void assertProcessSucceeded(Process process)
            throws Exception {
        boolean finished = process.waitFor(30, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            process.waitFor(5, TimeUnit.SECONDS);
        }
        String output = new String(process.getInputStream().readAllBytes(),
                StandardCharsets.UTF_8);
        assertTrue(finished, () -> "Broker process timed out:\n" + output);
        assertEquals(0, process.exitValue(), () ->
                "Broker process failed:\n" + output);
        assertTrue(output.contains("P3_PROCESS_FIXTURE_OK"), () ->
                "Broker process omitted success marker:\n" + output);
    }

    private static void assertPhysicalCounts(DataSource dataSource)
            throws SQLException {
        assertEquals(1, count(dataSource,
                "SELECT COUNT(*) FROM p3_physical_runtime"));
        assertEquals(1, count(dataSource,
                "SELECT COUNT(*) FROM p3_physical_execution"));
    }

    private static long count(DataSource dataSource, String sql)
            throws SQLException {
        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement =
                        connection.prepareStatement(sql);
                ResultSet result = statement.executeQuery()) {
            assertTrue(result.next());
            return result.getLong(1);
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase()
                .contains("win");
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
