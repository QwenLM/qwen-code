package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.apache.commons.codec.digest.DigestUtils;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.env.MockEnvironment;

import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.fail;

@EnabledOnOs({OS.LINUX, OS.MAC})
class ManagedLocalConfigurationTest {
    @TempDir
    Path temporary;

    @Test
    void bindsTheLocalProfileAndInitializesItsFileDatabase() throws Exception {
        Path directory = temporary.toRealPath();
        String workspaceId = DigestUtils.sha256Hex(directory.resolve("legacy").toString()).substring(0, 16);
        new ApplicationContextRunner()
                .withInitializer(new ConfigDataApplicationContextInitializer())
                .withConfiguration(AutoConfigurations.of(DataSourceAutoConfiguration.class, FlywayAutoConfiguration.class))
                .withUserConfiguration(ProfileConfiguration.class)
                .withPropertyValues("spring.profiles.active=managed-local",
                        "QWEN_MANAGED_AGENT_LOCAL_DATA_DIRECTORY=" + directory,
                        "QWEN_MANAGED_AGENT_WORKSPACE_ID=" + workspaceId)
                .run(context -> {
                    assertThat(context).hasNotFailed().hasSingleBean(DruidDataSource.class);
                    assertThat(context.getBean(DruidDataSource.class).getUrl())
                            .isEqualTo(ManagedLocalConfiguration.jdbcUrl(directory));
                    assertThat(ManagedSchema.schemaVersion(context.getBean(DruidDataSource.class))).isEqualTo(1);
                    var managed = context.getBean(ManagedAgentProperties.class);
                    assertThat(managed.getRuntimeBroker().getWorkspaceId()).isEqualTo(workspaceId);
                    assertThat(managed.getSessionStore().getWorkspaceId()).isEqualTo(workspaceId);
                    assertThat(context.getEnvironment().getProperty("spring.h2.console.enabled")).isEqualTo("false");
                    assertThat(context.getEnvironment().getProperty("management.endpoint.health.probes.enabled"))
                            .isEqualTo("true");
                });
    }

    @Test
    void preservesCommittedStateAndRollsBackAnUncommittedTransactionAcrossReopen() throws Exception {
        Path directory = temporary.toRealPath();
        try (var source = source(directory)) {
            migrate(source);
            try (Connection connection = source.getConnection()) {
                insert(connection, "committed");
                connection.setAutoCommit(false);
                insert(connection, "uncommitted");
            }
        }
        try (var source = source(directory)) {
            migrate(source);
            assertSessions(source, "committed");
            ManagedSchema.validate(source);
        }
        for (String name : new String[] {"database", "runtime", "workspaces", "legacy"}) {
            assertThat(Files.getPosixFilePermissions(directory.resolve(name)))
                    .isEqualTo(PosixFilePermissions.fromString("rwx------"));
        }
    }

    @Test
    @Timeout(60)
    void locksOutAnotherJvmAndRecoversCommittedStateAfterTheOwnerIsKilled() throws Exception {
        Path directory = temporary.toRealPath();
        Path log = directory.resolve("database-process.log");
        Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("java.class.path"), DatabaseProcess.class.getName(), directory.toString())
                .redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (!Files.readString(log).contains("LOCAL_DATABASE_READY")) {
                if (!child.isAlive() || System.nanoTime() >= deadline) {
                    fail("Database process did not become ready: " + Files.readString(log));
                }
                Thread.sleep(50);
            }
            assertThatThrownBy(() -> {
                try (var ignored = DriverManager.getConnection(ManagedLocalConfiguration.jdbcUrl(directory), "qwen", "")) {
                    fail("A second process opened the private database");
                }
            }).hasMessageContaining("Database may be already in use");
            child.destroyForcibly();
            assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
            try (var source = source(directory)) {
                migrate(source);
                assertSessions(source, "committed");
                ManagedSchema.validate(source);
            }
        } finally {
            child.destroyForcibly();
            child.waitFor(10, TimeUnit.SECONDS);
        }
    }

    @Test
    void refusesAForeignFileDatabaseWithoutChangingItsData() throws Exception {
        Path directory = temporary.toRealPath();
        try (var source = source(directory)) {
            var jdbc = new JdbcTemplate(source);
            jdbc.execute("CREATE TABLE foreign_data (payload VARCHAR(32))");
            jdbc.update("INSERT INTO foreign_data VALUES ('preserve-me')");
            assertThatThrownBy(() -> migrate(source)).isInstanceOf(IllegalStateException.class);
            assertThat(jdbc.queryForObject("SELECT payload FROM foreign_data", String.class)).isEqualTo("preserve-me");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'public'",
                    Integer.class)).isEqualTo(1);
        }
    }

    @Test
    void refusesAChangedDatabaseUrlAndExposedListenersBeforeDatabaseCreation() throws Exception {
        Path directory = temporary.toRealPath();
        var source = properties(directory);
        source.setUrl(source.getUrl() + ";AUTO_SERVER=TRUE");
        assertThatThrownBy(() -> configure(directory, source, server(), managed(directory)))
                .hasMessageContaining("private file H2");
        var server = server();
        server.setAddress(InetAddress.getByName("0.0.0.0"));
        assertThatThrownBy(() -> configure(directory, properties(directory), server, managed(directory)))
                .hasMessageContaining("loopback");
        assertThat(Files.exists(directory.resolve("database"))).isFalse();
    }

    @Test
    void refusesPublicPermissionsAndSymlinkedPrivateState() throws Exception {
        Path directory = temporary.toRealPath();
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        assertThatThrownBy(() -> source(directory)).hasMessageContaining("owner-only");
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        Files.createSymbolicLink(directory.resolve("database"), directory.resolve("other"));
        assertThatThrownBy(() -> source(directory)).isInstanceOf(Exception.class);
    }

    private static DruidDataSource source(Path directory) throws Exception {
        return configure(directory, properties(directory), server(), managed(directory));
    }

    private static DruidDataSource configure(Path directory, DataSourceProperties source,
            ServerProperties server, ManagedAgentProperties managed) throws Exception {
        return new ManagedLocalConfiguration().managedLocalDataSource(source, server, managed,
                new MockEnvironment().withProperty("QWEN_MANAGED_AGENT_LOCAL_DATA_DIRECTORY", directory.toString()));
    }

    private static DataSourceProperties properties(Path directory) {
        var source = new DataSourceProperties();
        source.setUrl(ManagedLocalConfiguration.jdbcUrl(directory));
        source.setUsername("qwen");
        source.setPassword("");
        return source;
    }

    private static ServerProperties server() throws Exception {
        var server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        return server;
    }

    private static ManagedAgentProperties managed(Path directory) {
        var properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getSessionStore().setBaseUrl("http://127.0.0.1:8080");
        var broker = properties.getRuntimeBroker();
        broker.setVerifiedWorkspaceRecoveryEnabled(true);
        broker.setStateDirectory(directory.resolve("runtime").toString());
        broker.setWorkspaceCwd(directory.resolve("legacy").toString());
        broker.setWorkspaceCreationRoot(directory.resolve("workspaces").toString());
        return properties;
    }

    private static void migrate(DruidDataSource source) {
        new ManagedSchemaConfiguration().freshManagedSchema(source).migrate(
                Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load());
    }

    private static void insert(Connection connection, String session) throws Exception {
        try (var statement = connection.prepareStatement("INSERT INTO ma_session"
                + " (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified)"
                + " VALUES ('local', ?, 'qwen-code', 'ACTIVE', 1, 1)")) {
            statement.setString(1, session);
            statement.executeUpdate();
        }
    }

    private static void assertSessions(DruidDataSource source, String session) {
        assertThat(new JdbcTemplate(source).queryForList("SELECT session_id FROM ma_session", String.class))
                .containsExactly(session);
    }

    @TestConfiguration(proxyBeanMethods = false)
    @EnableConfigurationProperties({ServerProperties.class, ManagedAgentProperties.class})
    @Import({ManagedLocalConfiguration.class, ManagedSchemaConfiguration.class})
    static class ProfileConfiguration {
    }

    public static final class DatabaseProcess {
        private DatabaseProcess() {
        }

        public static void main(String[] args) throws Exception {
            try (var source = source(Path.of(args[0]))) {
                migrate(source);
                try (var connection = source.getConnection()) {
                    insert(connection, "committed");
                    connection.setAutoCommit(false);
                    insert(connection, "uncommitted");
                    System.out.println("LOCAL_DATABASE_READY");
                    System.out.flush();
                    Thread.currentThread().join();
                }
            }
        }
    }
}
