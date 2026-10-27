package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.security.WriterCredentialPolicy;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.lang3.StringUtils;
import org.springframework.boot.SpringApplication;

import javax.sql.DataSource;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryType;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

final class ManagedSessionHistoryHttpFixture {
    private ManagedSessionHistoryHttpFixture() {}

    static ObjectNode run(Path directory, String url, String user, String password, String driver,
            int eventCount, String engine) throws Exception {
        Path root = Path.of("../..").toRealPath();
        assertThat(root.resolve("packages/core/dist/src/managed-runtime/managed-session-authority.js")).isRegularFile();
        ManagementFactory.getMemoryPoolMXBeans().forEach(pool -> pool.resetPeakUsage());
        int port;
        try (var socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        SpringApplication application = new SpringApplication(ManagedAgentServerApplication.class);
        try (var context = application.run("--server.port=0", "--spring.datasource.url=" + url,
                "--spring.datasource.username=" + user, "--spring.datasource.password=" + password,
                "--spring.datasource.driver-class-name=" + driver,
                "--qwen.managed-agent.harness.enabled=false", "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.binding-key=pr5-history-integration-binding-key",
                "--qwen.managed-agent.internal-server.address=127.0.0.1",
                "--qwen.managed-agent.internal-server.port=" + port)) {
            ObjectMapper json = context.getBean(ObjectMapper.class);
            ObjectNode database = database(context.getBean(DataSource.class), json, engine, eventCount);
            String revision = StringUtils.defaultIfBlank(System.getenv("QWEN_HISTORY_TEST_REVISION"), "working-tree-uncommitted");
            assertThat(revision).matches("[a-f0-9]{40}|[a-f0-9]{64}|working-tree-uncommitted");
            String tenant = "pr5-http";
            String workspace = "pr5-workspace";
            String session = "pr5-" + UUID.randomUUID();
            String token = context.getBean(WriterCredentialPolicy.class).issue(tenant, workspace, session);
            Path reports = Path.of("target/managed-history-scale").toAbsolutePath();
            Files.createDirectories(reports);
            Path report = reports.resolve(engine + "-" + eventCount + ".json");
            Files.deleteIfExists(report);
            ObjectNode starting = json.createObjectNode().put("engine", engine).put("eventCount", eventCount).put("status", "starting").put("revision", revision);
            starting.set("database", database);
            json.writerWithDefaultPrettyPrinter().writeValue(report.toFile(), starting);
            Path input = directory.resolve("input.json");
            json.writeValue(input.toFile(), Map.of("baseUrl", "http://127.0.0.1:" + port,
                    "sessionKey", Map.of("tenantId", tenant, "workspaceId", workspace, "sessionId", session),
                    "writerToken", token, "eventCount", eventCount, "engine", engine,
                    "metricsPath", report.toString(), "historyDirectory", directory.resolve("history").toString(), "revision", revision));
            Path script = directory.resolve("history.mjs");
            try (var source = ManagedSessionHistoryHttpFixture.class.getResourceAsStream("/managed-session-history-http.mjs")) {
                assertThat(source).isNotNull();
                Files.copy(source, script);
            }
            Path log = reports.resolve(engine + "-" + eventCount + ".node.log.txt");
            Process process = new ProcessBuilder(System.getProperty("node.executable", "node"),
                    "--max-old-space-size=256", "--expose-gc", script.toString(), input.toString())
                    .directory(root.toFile()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            boolean completed = false;
            try {
                int timeoutSeconds = eventCount == 1100 ? 70 : eventCount == 10000 ? 600 : 5400;
                assertThat(process.waitFor(timeoutSeconds, TimeUnit.SECONDS)).as("Core HTTP history case finishes: %s", log).isTrue();
                assertThat(process.exitValue()).as(Files.readString(log)).isZero();
                assertThat(Files.readString(log)).contains("PR5_NATIVE_HISTORY_HTTP_PASS");
                if (engine.equals("mysql")) {
                    assertThat(Files.readString(log)).contains("PR5_NATIVE_HISTORY_HTTP_MYSQL_PASS");
                }
                ObjectNode metrics = (ObjectNode) json.readTree(Files.readString(report));
                metrics.set("database", database);
                metrics.set("jvm", jvm(json));
                assertThat(metrics.path("revision").textValue()).isEqualTo(revision);
                json.writerWithDefaultPrettyPrinter().writeValue(report.toFile(), metrics);
                System.out.println("PR5_MANAGED_HISTORY_METRICS " + json.writeValueAsString(metrics));
                completed = true;
                return metrics;
            } finally {
                if (process.isAlive()) {
                    process.destroyForcibly().waitFor(5, TimeUnit.SECONDS);
                }
                if (!completed) {
                    ObjectNode failed = (ObjectNode) json.readTree(Files.readString(report));
                    failed.put("status", "failed").put("revision", revision);
                    failed.set("database", database);
                    failed.set("jvm", jvm(json));
                    json.writerWithDefaultPrettyPrinter().writeValue(report.toFile(), failed);
                }
            }
        }
    }

    private static ObjectNode database(DataSource source, ObjectMapper json, String engine, int eventCount) throws Exception {
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            var metadata = connection.getMetaData();
            ObjectNode evidence = json.createObjectNode().put("product", metadata.getDatabaseProductName())
                    .put("version", metadata.getDatabaseProductVersion()).put("url", metadata.getURL());
            if (engine.equals("h2")) {
                assertThat(metadata.getDatabaseProductName()).isEqualTo("H2");
                assertThat(metadata.getURL()).startsWith("jdbc:h2:file:");
                try (var result = statement.executeQuery("SELECT setting_value FROM information_schema.settings"
                        + " WHERE LOWER(setting_name) = 'cache_size'")) {
                    assertThat(result.next()).as("H2 cache budget is explicit").isTrue();
                    int cache = Integer.parseInt(result.getString(1));
                    assertThat(cache).isEqualTo(8192);
                    evidence.put("cacheKiB", cache);
                }
            } else if (eventCount != 1100) {
                assertThat(metadata.getDatabaseProductName()).isEqualTo("MySQL");
                try (var result = statement.executeQuery("SELECT VERSION(), @@max_allowed_packet, @@log_bin, @@innodb_use_native_aio")) {
                    assertThat(result.next()).isTrue();
                    assertThat(result.getString(1)).startsWith("8.4.");
                    assertThat(result.getLong(2)).isGreaterThanOrEqualTo(134217728L);
                    assertThat(result.getInt(3)).isZero();
                    assertThat(result.getInt(4)).isZero();
                    evidence.put("maxAllowedPacket", result.getLong(2)).put("logBin", result.getInt(3))
                            .put("nativeAio", result.getInt(4));
                }
            }
            return evidence;
        }
    }

    private static ObjectNode jvm(ObjectMapper json) throws InterruptedException {
        long before = collections();
        ManagementFactory.getMemoryMXBean().gc();
        Thread.sleep(250);
        ManagementFactory.getMemoryMXBean().gc();
        Thread.sleep(250);
        long after = collections();
        assertThat(after).as("Explicit GC completed before retaining the service heap sample").isGreaterThan(before);
        var heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        ObjectNode evidence = json.createObjectNode().put("heapUsedBytes", heap.getUsed())
                .put("heapMaxBytes", heap.getMax()).put("collectionsBefore", before).put("collectionsAfter", after)
                .put("isolation", "Shared sequential JVM fork; service context and database pool remain open during this sample.");
        ObjectNode pools = evidence.putObject("pools");
        for (var pool : ManagementFactory.getMemoryPoolMXBeans()) {
            var peak = pool.getPeakUsage();
            var used = pool.getUsage();
            if (peak != null && used != null) {
                pools.putObject(pool.getName()).put("type", pool.getType() == MemoryType.HEAP ? "heap" : "non-heap")
                        .put("usedBytes", used.getUsed()).put("peakUsedBytes", peak.getUsed());
            }
        }
        return evidence;
    }

    private static long collections() {
        return ManagementFactory.getGarbageCollectorMXBeans().stream()
                .mapToLong(bean -> Math.max(0, bean.getCollectionCount())).sum();
    }
}
