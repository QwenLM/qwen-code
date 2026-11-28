package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.adapters.event.RocketMqSessionResourceGc;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SessionResourceGcConfiguration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.PlatformTransactionManager;

import javax.sql.DataSource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The collector suite on a real InnoDB engine, where the locking interleavings are observable.
 * One schema serves the whole class: a per-test database re-ran every Flyway migration for each
 * inherited test, and that bootstrap dominated the MariaDB CI job's timeout budget. Truncating
 * every table after each test keeps the same isolation.
 */
class SessionResourceCollectionMySqlIT extends SessionResourceCollectionCollectorTest {
    private static JdbcTemplate admin;
    private static String schema;
    private static DriverManagerDataSource data;

    @BeforeAll
    static void createSchema() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "stream_capture_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @Override
    protected DataSource dataSource() {
        return data;
    }

    @Test
    void rocketMqWakeupsAndPolling(@TempDir Path directory) throws Exception {
        String endpoints = System.getProperty("gc.mq.endpoints");
        if (!Boolean.getBoolean("gc.mq.required")) {
            assumeTrue(endpoints != null, "Set gc.mq.endpoints, gc.mq.topic and gc.mq.group to run the MQ integration case");
        }
        String topic = System.getProperty("gc.mq.topic");
        String group = System.getProperty("gc.mq.group");
        assertThat(endpoints).as("gc.mq.endpoints").isNotBlank();
        assertThat(topic).as("gc.mq.topic").isNotBlank();
        assertThat(group).as("gc.mq.group").isNotBlank();
        jdbc.update("DELETE FROM ma_output_capture WHERE tenant_id = ?", tenant);
        seedGc("duplicate", 1);
        seedGc("lost", 1);

        var owner = mysqlCollector(data);

        Path receipts = Files.createFile(directory.resolve("receipts"));
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                WorkerProcess.class.getName(), endpoints, topic, group, receipts.toString(), tenant)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.environment().put("GC_TEST_JDBC_URL", data.getUrl());
        builder.environment().put("GC_TEST_JDBC_USER", data.getUsername());
        builder.environment().put("GC_TEST_JDBC_PASSWORD", data.getPassword());
        Process worker = builder.start();
        try {
            await().atMost(Duration.ofSeconds(15)).untilAsserted(() ->
                    assertThat(Files.readAllLines(receipts)).contains("ready"));
            var deliveries = new CopyOnWriteArrayList<String>();
            try (var mq = new RocketMqSessionResourceGc(endpoints, topic, group, (targetTenant, targetSession) -> {
                if (tenant.equals(targetTenant)) {
                    owner.wake(targetTenant, targetSession);
                    deliveries.add(targetSession);
                }
            })) {
                mq.connect();
                mq.publish(tenant, "duplicate", Duration.ZERO);
                mq.publish(tenant, "duplicate", Duration.ZERO);
                await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
                    long remote = Files.readAllLines(receipts).stream().filter("duplicate"::equals).count();
                    long local = deliveries.stream().filter("duplicate"::equals).count();
                    assertThat(remote + local).isGreaterThanOrEqualTo(2);
                });
                assertThat(gc("duplicate")).containsEntry("state", "SUCCEEDED").containsEntry("claim_generation", 1L);
                assertThat(bodies("duplicate")).isZero();
                assertThat(gc("lost")).containsEntry("state", "PENDING");
                verifyScheduledFallback();
            }

            seedGc("takeover", 205);
            var claim = owner.claim(tenant, "takeover");
            assertThat(owner.collect(claim)).isTrue();
            var stale = owner.claim(tenant, "takeover");
            assertThat(stale.cursor()).isEqualTo("part-099");
            assertThat(gc("takeover")).containsEntry("claim_generation", 2L);

            try (var publisher = new RocketMqSessionResourceGc(endpoints, topic, group, null)) {
                publisher.connect();
                var completedDuplicate = gc("duplicate");
                long previousDuplicates = Files.readAllLines(receipts).stream().filter("duplicate"::equals).count();
                publisher.publish(tenant, "duplicate", Duration.ZERO);
                await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(Files.readAllLines(receipts)
                        .stream().filter("duplicate"::equals).count()).isGreaterThan(previousDuplicates));
                assertThat(gc("duplicate")).isEqualTo(completedDuplicate);

                publisher.publish(tenant, "takeover", Duration.ZERO);
                await().atMost(Duration.ofSeconds(15)).untilAsserted(() ->
                        assertThat(Files.readAllLines(receipts)).contains("takeover"));
                assertThat(gc("takeover")).containsEntry("claim_generation", 2L).containsEntry("state", "LEASED");
                assertThat(bodies("takeover")).isEqualTo(105);

                jdbc.update("UPDATE ma_operation SET claim_until = 0 WHERE operation_kind = 'SESSION_RESOURCE_GC'"
                        + " AND tenant_id = ? AND session_id = 'takeover'", tenant);
                publisher.publish(tenant, "takeover", Duration.ZERO);
                await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(gc("takeover"))
                        .containsEntry("claim_generation", 3L).containsEntry("state", "LEASED"));
                await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(bodies("takeover")).isEqualTo(5));
                var resumed = gc("takeover");
                assertThat(JdbcManagedToolResultStore.parse((String) resumed.get("result_json"))
                        .path("cursor").asText()).isEqualTo("part-199");
                assertThat(owner.collect(stale)).isFalse();
                assertThat(gc("takeover")).isEqualTo(resumed);

                publisher.publish(tenant, "takeover", Duration.ZERO);
                await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(gc("takeover"))
                        .containsEntry("claim_generation", 4L).containsEntry("state", "SUCCEEDED"));
                var completed = gc("takeover");
                assertThat(JdbcManagedToolResultStore.parse((String) completed.get("result_json"))
                        .path("collectedBytes").asLong()).isEqualTo(205);
                assertThat(bodies("takeover")).isZero();
            }
        } finally {
            worker.getOutputStream().close();
            if (!worker.waitFor(5, TimeUnit.SECONDS)) {
                worker.destroyForcibly();
                assertThat(worker.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
        }
    }

    private void verifyScheduledFallback() {
        new ApplicationContextRunner().withUserConfiguration(Scheduling.class, SessionResourceGcConfiguration.class)
                .withBean("managedJdbcTemplate", JdbcTemplate.class, () -> jdbc)
                .withBean("managedAgentTransactionManager", PlatformTransactionManager.class, () -> manager)
                .withBean(ThreadPoolTaskSchedulerBuilder.class, ThreadPoolTaskSchedulerBuilder::new)
                .withPropertyValues("qwen.managed-agent.session-resource-gc.enabled=true",
                        "qwen.managed-agent.tool-publication.deletion-grace=0s")
                .run(app -> {
                    assertThat(app).hasNotFailed();
                    await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                            assertThat(gc("lost")).containsEntry("state", "SUCCEEDED"));
                    assertThat(bodies("lost")).isZero();
                });
    }

    @Configuration(proxyBeanMethods = false)
    @EnableScheduling
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class Scheduling {}

    private void seedGc(String target, int count) {
        for (int index = 0; index < count; index++) {
            jdbc.update("INSERT INTO ma_resource (tenant_id, session_id, resource_id, kind, schema_version,"
                            + " byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES"
                            + " (?, ?, ?, 'input', 1, 1, ?, 'MYSQL_INLINE', ?, 'PUBLISHED', 0)",
                    tenant, target, String.format("part-%03d", index), "a".repeat(64), new byte[] {1});
        }
        tx.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, target);
            ToolPublicationRetentionStore.retire(jdbc, tenant, target, "delete-" + target);
        });
    }

    private Map<String, Object> gc(String target) {
        return jdbc.queryForMap("SELECT state, claim_generation, result_json FROM ma_operation WHERE"
                + " operation_kind = 'SESSION_RESOURCE_GC' AND tenant_id = ? AND session_id = ?", tenant, target);
    }

    private long bodies(String target) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE tenant_id = ? AND session_id = ?"
                + " AND inline_bytes IS NOT NULL", Long.class, tenant, target);
    }

    private static SessionResourceCollectionCollector mysqlCollector(DataSource source) {
        var properties = new ManagedAgentProperties();
        properties.getToolPublication().setDeletionGrace(Duration.ZERO);
        return SessionResourceCollectionCollector.mysqlOnly(new ManagedSchemaJdbcTemplate(source),
                new DataSourceTransactionManager(source), properties);
    }

    public static class WorkerProcess {
        public static void main(String[] args) throws IOException {
            var source = new DriverManagerDataSource(System.getenv("GC_TEST_JDBC_URL"),
                    System.getenv("GC_TEST_JDBC_USER"), System.getenv("GC_TEST_JDBC_PASSWORD"));
            var collector = mysqlCollector(source);
            Path receipts = Path.of(args[3]);
            try (var mq = new RocketMqSessionResourceGc(args[0], args[1], args[2], (tenant, session) -> {
                if (args[4].equals(tenant)) {
                    collector.wake(tenant, session);
                    try {
                        Files.writeString(receipts, session + "\n", StandardOpenOption.APPEND);
                    } catch (IOException failure) {
                        throw new UncheckedIOException(failure);
                    }
                }
            })) {
                mq.connect();
                Files.writeString(receipts, "ready\n", StandardOpenOption.APPEND);
                System.in.read();
            }
        }
    }

    @AfterEach
    void truncateTables() {
        // FOREIGN_KEY_CHECKS is session-scoped and a DriverManagerDataSource hands out a fresh
        // connection per call, so the toggle and the truncates must share one connection.
        admin.execute((ConnectionCallback<Void>) connection -> {
            try (var statement = connection.createStatement()) {
                var found = statement.executeQuery("SELECT TABLE_NAME FROM information_schema.TABLES"
                        + " WHERE TABLE_SCHEMA = '" + schema + "' AND TABLE_TYPE = 'BASE TABLE'");
                var tables = new ArrayList<String>();
                while (found.next()) {
                    tables.add(found.getString(1));
                }
                statement.execute("SET FOREIGN_KEY_CHECKS = 0");
                try {
                    for (String table : tables) {
                        if (!table.equals("flyway_schema_history")) {
                            statement.execute("TRUNCATE TABLE " + schema + "." + table);
                        }
                    }
                } finally {
                    statement.execute("SET FOREIGN_KEY_CHECKS = 1");
                }
            }
            return null;
        });
    }

    @AfterAll
    static void dropSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }
}
