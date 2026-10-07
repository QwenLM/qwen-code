package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class HostedProcessCrashIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> CASES = List.of("harness-prepare", "harness-start", "harness-result",
            "spring-kill", "worker-kill", "worker-stop");
    @TempDir
    private Path temporary;

    @Test
    @Timeout(420)
    void processCrashesNeverReplayHostedToolsOnMySql() throws Exception {
        assertThat(required("mysql.url")).startsWith("jdbc:mysql:");
        assertThat(System.getProperty("os.name").toLowerCase()).doesNotContain("windows");
        var source = new DriverManagerDataSource(required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", ""));
        Properties timeouts = new Properties();
        timeouts.setProperty("connectTimeout", "5000");
        timeouts.setProperty("socketTimeout", "10000");
        source.setConnectionProperties(timeouts);
        JdbcTemplate jdbc = new JdbcTemplate(source);
        jdbc.setQueryTimeout(10);
        var database = jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine");
        assertThat(database.toString().toLowerCase()).containsAnyOf("mysql", "mariadb");
        System.out.println("FG6C_DATABASE " + JSON.writeValueAsString(database));
        String selected = System.getProperty("qwen.fg6c.case");
        if (selected != null) {
            assertThat(CASES).contains(selected);
        }
        for (String fault : selected == null ? CASES : List.of(selected)) {
            try (Fixture fixture = new Fixture(jdbc, fault)) {
                fixture.run();
            }
        }
    }

    private final class Fixture implements AutoCloseable {
        private final JdbcTemplate jdbc;
        private final String fault;
        private final Path root;
        private final Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath().normalize();
        private final String node = required("node.executable");
        private final String tenant = "hosted-crash-" + UUID.randomUUID();
        private final Set<ProcessHandle> processes = new LinkedHashSet<>();
        private final AtomicReference<Throwable> controlFailure = new AtomicReference<>();
        private Process spring;
        private Process driver;
        private ObjectNode ready;
        private HttpServer controller;
        private int boots;
        private int injections;
        private Map<String, Object> originalOwner;

        private Fixture(JdbcTemplate jdbc, String fault) throws Exception {
            this.jdbc = jdbc;
            this.fault = fault;
            root = Files.createDirectory(temporary.resolve(fault)).toRealPath();
            Files.createDirectory(root.resolve("runtime"));
            Files.createDirectories(root.resolve("workspace/child"));
            assertThat(cli).isRegularFile();
        }

        private void run() throws Exception {
            startSpring();
            controller = HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
            controller.createContext("/", exchange -> {
                try {
                    assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                    byte[] response = JSON.writeValueAsBytes(control(exchange.getRequestURI().getPath()));
                    exchange.sendResponseHeaders(200, response.length);
                    exchange.getResponseBody().write(response);
                } catch (Throwable error) {
                    controlFailure.compareAndSet(null, error);
                    byte[] response = error.toString().getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(500, response.length);
                    exchange.getResponseBody().write(response);
                } finally {
                    exchange.close();
                }
            });
            controller.start();
            Path config = root.resolve("driver.json");
            ready.put("controlUrl", "http://127.0.0.1:" + controller.getAddress().getPort());
            JSON.writeValue(config.toFile(), ready);
            Path log = root.resolve("driver.log");
            driver = new ProcessBuilder(node, "--import", "tsx",
                    "integration-tests/helpers/hosted-process-crash-driver.ts", config.toString())
                    .directory(cli.getParent().getParent().toFile()).redirectErrorStream(true)
                    .redirectOutput(log.toFile()).start();
            processes.add(driver.toHandle());
            assertThat(driver.waitFor(150, TimeUnit.SECONDS)).as("%s driver timeout: %s", fault, Files.readString(log)).isTrue();
            assertThat(controlFailure.get()).as("%s process controller", fault).isNull();
            assertThat(driver.exitValue()).as("%s driver output: %s", fault, Files.readString(log)).isZero();
            System.out.println(Files.readString(log));
            assertThat(Files.readString(log)).contains("HOSTED_PROCESS_CRASH_OK");
            assertThat(injections).isEqualTo(fault.startsWith("harness-") ? 0 : 1);
            assertThat(boots).isEqualTo(fault.equals("spring-kill") ? 2 : 1);
            assertLedger(JSON.readTree(Files.readString(Path.of(config + ".results"))));
        }

        private void startSpring() throws Exception {
            Path readiness = root.resolve("ready.json");
            Files.deleteIfExists(readiness);
            String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
            Path log = root.resolve("spring-" + ++boots + ".log");
            ProcessBuilder builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", classpath, HostedProcessCrashFixtureMain.class.getName(), root.toString(), node,
                    cli.toString(), tenant, fault).redirectErrorStream(true).redirectOutput(log.toFile());
            builder.environment().put("FG6C_MYSQL_URL", required("mysql.url"));
            builder.environment().put("FG6C_MYSQL_USER", required("mysql.user"));
            builder.environment().put("FG6C_MYSQL_PASSWORD", System.getProperty("mysql.password", ""));
            spring = builder.start();
            processes.add(spring.toHandle());
            await(() -> Files.exists(readiness) || !spring.isAlive(), 30, "Spring readiness");
            assertThat(spring.isAlive()).as("Spring failed: %s", Files.readString(log)).isTrue();
            ObjectNode next = (ObjectNode) JSON.readTree(Files.readString(readiness));
            if (ready != null) {
                assertThat(next.path("sessionId")).isEqualTo(ready.path("sessionId"));
            }
            ready = next;
        }

        private Map<String, Object> control(String route) throws Exception {
            if (route.equals("/evidence")) {
                var rows = executions();
                if (rows.isEmpty()) {
                    return Map.of();
                }
                assertThat(rows).hasSize(1);
                var row = rows.getFirst();
                captureOwner(row);
                var evidence = new LinkedHashMap<String, Object>();
                evidence.put("executionState", row.get("execution_state"));
                evidence.put("executionStatus", row.get("execution_status"));
                evidence.put("dispatchGeneration", row.get("dispatch_generation"));
                return evidence;
            }
            assertThat(route).isEqualTo("/" + fault);
            assertThat(injections++).isZero();
            var execution = executions();
            assertThat(execution).hasSize(1);
            assertThat(execution.getFirst().get("execution_state")).isEqualTo("EXECUTING");
            assertThat(((Number) execution.getFirst().get("dispatch_generation")).longValue()).isEqualTo(1);
            assertOwner(execution.getFirst());
            List<ProcessHandle> workers = spring.children().filter(process -> Arrays.asList(
                    process.info().arguments().orElse(new String[0])).contains("managed-runtime-worker")).toList();
            assertThat(workers).as("one actual worker owned by Spring").hasSize(1);
            ProcessHandle worker = workers.getFirst();
            processes.addAll(spring.descendants().toList());
            if (route.equals("/spring-kill")) {
                long pid = spring.pid();
                spring.destroyForcibly();
                assertThat(spring.waitFor(10, TimeUnit.SECONDS)).isTrue();
                assertThat(spring.exitValue()).isEqualTo(137);
                assertThat(running(worker)).as("Spring SIGKILL leaves the real worker alive").isTrue();
                // Keep the Store down beyond the Harness's five-second writer lease.
                Thread.sleep(8_000);
                startSpring();
                assertThat(spring.children().toList()).as("restart must not spawn a replacement worker").isEmpty();
                return Map.of("pid", pid, "newPid", spring.pid(), "signal", "SIGKILL",
                        "storeUrl", ready.path("storeUrl").asText(), "brokerUrl", ready.path("brokerUrl").asText());
            }
            if (route.equals("/worker-kill")) {
                assertThat(worker.destroyForcibly()).isTrue();
                await(() -> !running(worker), 10, "worker SIGKILL");
                return Map.of("pid", worker.pid(), "signal", "SIGKILL");
            }
            assertThat(route).isEqualTo("/worker-stop");
            Process signal = new ProcessBuilder("kill", "-STOP", Long.toString(worker.pid())).start();
            assertThat(signal.waitFor(5, TimeUnit.SECONDS)).isTrue();
            assertThat(signal.exitValue()).isZero();
            await(() -> stopped(worker), 5, "worker SIGSTOP");
            return Map.of("pid", worker.pid(), "signal", "SIGSTOP");
        }

        private List<Map<String, Object>> executions() {
            return jdbc.queryForList("SELECT * FROM qwen_tool_execution WHERE harness_session_id = ?",
                    ready.path("sessionId").asText());
        }

        private Map<String, Object> owner() throws Exception {
            return jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?",
                    sha256((tenant + "\u0000storage").getBytes(StandardCharsets.UTF_8)));
        }

        private void captureOwner(Map<String, Object> execution) throws Exception {
            if (originalOwner == null) {
                originalOwner = owner();
            }
            assertOwner(execution);
        }

        private void assertOwner(Map<String, Object> execution) throws Exception {
            var owner = owner();
            assertThat(originalOwner).as("owner captured before crash").isNotNull();
            assertThat(owner).isEqualTo(originalOwner);
            assertThat(owner.get("binding_id")).isEqualTo(execution.get("binding_id"));
            assertThat(owner.get("runtime_generation")).isEqualTo(execution.get("runtime_generation"));
            assertThat(owner.get("runtime_session_id")).isEqualTo(execution.get("runtime_session_id"));
            assertThat(owner.get("holder_key")).isEqualTo(sha256((execution.get("binding_id") + "\u0000"
                    + execution.get("runtime_generation") + "\u0000" + execution.get("runtime_session_id"))
                    .getBytes(StandardCharsets.UTF_8)));
        }

        private void assertLedger(JsonNode report) throws Exception {
            assertThat(report.path("fault").asText()).isEqualTo(fault);
            assertThat(report.path("modelCalls").asInt()).isEqualTo(1);
            assertThat(report.path("signalEvidence").isArray()).isTrue();
            assertThat(report.path("signalEvidence").size()).isEqualTo(fault.startsWith("harness-") ? 1 : 2);
            var rows = executions();
            assertThat(rows).hasSize(1);
            var execution = rows.getFirst();
            assertThat(execution.get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
            assertThat(execution.get("idempotency_key")).isEqualTo(report.path("idempotencyKey").asText());
            assertThat(execution.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
            assertThat(execution.get("turn_id")).isEqualTo(report.path("promptId").asText());
            boolean prepared = fault.equals("harness-prepare");
            boolean settled = List.of("harness-start", "harness-result").contains(fault);
            assertThat(((Number) execution.get("dispatch_generation")).longValue()).isEqualTo(prepared ? 0 : 1);
            assertThat(execution.get("execution_state")).isEqualTo(prepared ? "PREPARED" : settled ? "SETTLED"
                    : fault.equals("spring-kill") ? "EXECUTING" : "UNKNOWN");
            assertThat(execution.get("execution_status")).isEqualTo(settled ? "success" : null);
            if (!settled) {
                assertThat(execution.get("result_json")).isNull();
            }
            assertOwner(execution);
            var session = jdbc.queryForMap("SELECT * FROM qwen_runtime_session WHERE harness_session_id = ?",
                    ready.path("sessionId").asText());
            assertThat(session.get("session_state")).isEqualTo("READY");
            assertThat(session.get("runtime_session_id")).isEqualTo(execution.get("runtime_session_id"));
            assertThat(session.get("binding_id")).isEqualTo(execution.get("binding_id"));
            assertThat(jdbc.queryForList("SELECT binding_state FROM qwen_runtime_binding WHERE tenant_id = ?", String.class,
                    tenant)).containsExactly("READY");
            Path proof = root.resolve("workspace/child/proof.txt");
            assertThat(proof).isRegularFile();
            assertThat(Files.readString(proof)).isEqualTo(settled ? "xx" : "x");
            assertThat(root.resolve("workspace/proof.txt")).doesNotExist();
            assertJournal(report, prepared);
        }

        private void assertJournal(JsonNode report, boolean prepared) throws Exception {
            String session = ready.path("sessionId").asText();
            var journal = jdbc.queryForList("SELECT * FROM qwen_managed_session_journal_tx"
                    + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision", tenant, session);
            var transactionIds = new HashSet<String>();
            var eventIds = new HashSet<String>();
            var events = new ArrayList<JsonNode>();
            long revision = 0;
            long sequence = 0;
            for (var transaction : journal) {
                assertThat(((Number) transaction.get("journal_revision")).longValue()).isEqualTo(++revision);
                assertThat(transactionIds.add(transaction.get("transaction_id").toString())).isTrue();
                byte[] bytes = (byte[]) transaction.get("record_bytes");
                for (String line : new String(bytes, StandardCharsets.UTF_8).lines().toList()) {
                    JsonNode record = JSON.readTree(line);
                    if (!record.path("subtype").asText().equals("managed_session_event_v1")) {
                        continue;
                    }
                    JsonNode event = record.path("managedSession");
                    assertThat(event.path("sequence").asLong()).isEqualTo(++sequence);
                    assertThat(eventIds.add(event.path("eventId").asText())).isTrue();
                    assertThat(event.path("sessionKey").path("sessionId").asText()).isEqualTo(session);
                    events.add(event);
                }
            }
            var head = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?",
                    tenant, session);
            assertThat(((Number) head.get("journal_revision")).longValue()).isEqualTo(revision);
            assertThat(((Number) head.get("committed_sequence")).longValue()).isEqualTo(sequence);
            Object checkpointId = head.get("latest_checkpoint_resource_id");
            byte[] checkpoint = jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource"
                    + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?", byte[].class, tenant, session, checkpointId);
            JsonNode saved = JSON.readTree(checkpoint);
            assertThat(saved.path("continuation").path("phase").asText()).isEqualTo(prepared ? "before_model" : "await_runtime");
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("input.accepted")
                    && event.path("payload").path("turnId").equals(report.path("promptId")))).hasSize(1);
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("tool.intent"))).hasSize(prepared ? 0 : 1);
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("turn.settled"))).isEmpty();
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("message.committed")
                    && event.path("payload").path("role").asText().equals("tool_result"))).isEmpty();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource WHERE tenant_id = ?"
                    + " AND session_id = ? AND kind = 'managed-tool-outcome'", Integer.class, tenant, session))
                    .isZero();
            JsonNode target = report.path("target");
            if (fault.equals("harness-result")) {
                assertThat(target.path("transactionId").asText()).isNotBlank();
                assertThat(transactionIds).doesNotContain(target.path("transactionId").asText());
            }
            assertThat(report.path("restoreTransactions").isArray()).isTrue();
            assertThat(report.path("restoreTransactions").size()).isPositive();
            for (JsonNode restored : report.path("restoreTransactions")) {
                var matching = journal.stream().filter(transaction -> transaction.get("transaction_id")
                        .equals(restored.path("transactionId").asText())).toList();
                assertThat(matching).hasSize(1);
                assertThat((byte[]) matching.getFirst().get("record_bytes"))
                        .isEqualTo(Base64.getDecoder().decode(restored.path("recordBytesBase64").asText()));
                assertThat(matching.getFirst().get("record_digest")).isEqualTo(restored.path("recordDigest").asText());
            }
        }

        @Override
        public void close() throws Exception {
            if (controller != null) {
                controller.stop(0);
            }
            if (driver != null) {
                processes.addAll(driver.descendants().toList());
            }
            if (spring != null) {
                processes.addAll(spring.descendants().toList());
            }
            processes.forEach(ProcessHandle::destroyForcibly);
            for (ProcessHandle process : processes) {
                await(() -> !running(process), 10, "process cleanup " + process.pid());
            }
            if (driver != null) {
                assertThat(driver.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
            if (spring != null) {
                assertThat(spring.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
        }
    }

    private static boolean running(ProcessHandle process) {
        if (!process.isAlive()) {
            return false;
        }
        Path stat = Path.of("/proc", Long.toString(process.pid()), "stat");
        if (Files.exists(stat)) {
            try {
                String value = Files.readString(stat);
                return value.charAt(value.lastIndexOf(')') + 2) != 'Z';
            } catch (java.io.IOException gone) {
                return process.isAlive();
            }
        }
        return true;
    }

    private static boolean stopped(ProcessHandle worker) {
        try {
            Process ps = new ProcessBuilder("ps", "-o", "stat=", "-p", Long.toString(worker.pid())).start();
            if (!ps.waitFor(2, TimeUnit.SECONDS)) {
                ps.destroyForcibly();
                return false;
            }
            return ps.exitValue() == 0 && new String(ps.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim().startsWith("T");
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static void await(BooleanSupplier condition, int seconds, String description) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (!condition.getAsBoolean()) {
            assertThat(System.nanoTime()).as(description).isLessThan(deadline);
            Thread.sleep(20);
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String required(String key) {
        String value = System.getProperty(key);
        assertThat(value).as("Pass -D%s", key).isNotBlank();
        return value;
    }
}
