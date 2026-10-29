package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.time.Duration;
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

import static org.assertj.core.api.Assertions.assertThat;

class HostedProcessCrashIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> CASES = List.of("harness-prepare", "harness-start", "harness-unknown",
            "harness-result", "spring-kill", "worker-kill", "worker-stop", "recovery-settlement");
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
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
        JdbcTemplate jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(source);
        jdbc.setQueryTimeout(10);
        var database = jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine");
        try (var connection = source.getConnection()) {
            assertThat(connection.getMetaData().getDatabaseProductName())
                    .containsAnyOf("MySQL", "MariaDB");
        }
        System.out.println("FG6C_DATABASE " + JSON.writeValueAsString(database));
        String selected = System.getProperty("qwen.fg6c.case");
        if ("coordinator-only".equals(selected)) {
            return;
        }
        if (selected != null) {
            assertThat(CASES).contains(selected);
        }
        for (String fault : selected == null ? CASES : List.of(selected)) {
            try (Fixture fixture = new Fixture(jdbc, fault)) {
                fixture.run();
            }
        }
    }

    @Test
    @Timeout(180)
    void coordinatorRestartReattachesTheResidentTurnOnMySql() throws Exception {
        String selected = System.getProperty("qwen.fg6c.case");
        if (selected != null && !"coordinator-only".equals(selected)) {
            return;
        }
        assertThat(required("mysql.url")).startsWith("jdbc:mysql:");
        assertThat(System.getProperty("os.name").toLowerCase()).doesNotContain("windows");
        var source = new DriverManagerDataSource(required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", ""));
        Properties timeouts = new Properties();
        timeouts.setProperty("connectTimeout", "5000");
        timeouts.setProperty("socketTimeout", "10000");
        source.setConnectionProperties(timeouts);
        JdbcTemplate jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(source);
        jdbc.setQueryTimeout(10);
        try (var fixture = new CoordinatorRestartFixture(jdbc)) {
            fixture.run();
        }
    }

    private final class CoordinatorRestartFixture implements AutoCloseable {
        private final JdbcTemplate jdbc;
        private final Path root;
        private final Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath().normalize();
        private final String node = required("node.executable");
        private final String tenant = "hosted-coordinator-" + UUID.randomUUID();
        private final int port;
        private final Set<ProcessHandle> processes = new LinkedHashSet<>();
        private final HttpClient http = HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(5)).build();
        private Process spring;
        private Process driver;
        private ObjectNode driverReady;
        private int boots;

        private CoordinatorRestartFixture(JdbcTemplate jdbc) throws Exception {
            this.jdbc = jdbc;
            root = Files.createDirectory(temporary.resolve("coordinator-only")).toRealPath();
            assertThat(cli).isRegularFile();
            try (var socket = new ServerSocket(0)) {
                socket.setReuseAddress(true);
                port = socket.getLocalPort();
            }
        }

        private void run() throws Exception {
            startDriver();
            startSpring();
            JsonNode created = api("POST", "/v1/agents/sessions", "create", """
                    {"agent_id":"qwen-code","input":[]}
                    """, 202);
            String session = created.path("id").asText();
            JsonNode admitted = api("POST", "/v1/agents/sessions/" + session + "/events", "primary", """
                    {"type":"agent.session.input.message",
                     "input":[{"type":"input_text","text":"COORDINATOR_ONLY"}]}
                    """, 202);
            String turn = admitted.path("turn_id").asText();
            await(() -> {
                JsonNode state = driverState();
                return state.path("firstChunk").asBoolean()
                        && state.path("primaryRequests").asInt() == 1;
            }, 30, "first model chunk");
            await(() -> jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event"
                            + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?"
                            + " AND event_type = 'item.output_text.delta'", Integer.class,
                    tenant, session, turn) == 1, 30, "first persisted delta");
            int loadResponsesBeforeRestart = driverState().path("loadResponses").asInt();
            String originalOwner = jdbc.queryForObject("SELECT dispatch_owner FROM ma_turn"
                    + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?", String.class,
                    tenant, session, turn);

            long killedPid = spring.pid();
            spring.destroyForcibly();
            assertThat(spring.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(spring.exitValue()).isEqualTo(137);
            JsonNode during = driverState();
            assertThat(during.path("harnessAlive").asBoolean()).isTrue();
            assertThat(during.path("primaryRequests").asInt()).isEqualTo(1);
            assertThat(during.path("released").asBoolean()).isFalse();

            startSpring();
            await(() -> {
                String owner = jdbc.queryForObject("SELECT dispatch_owner FROM ma_turn"
                                + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                        String.class, tenant, session, turn);
                return owner != null && !owner.equals(originalOwner);
            }, 30, "replacement coordinator claim");
            await(() -> driverState().path("loadResponses").asInt() > loadResponsesBeforeRestart,
                    30, "replacement coordinator Harness load");
            control("POST", "/release");
            await(() -> "COMPLETED".equals(jdbc.queryForObject("SELECT status FROM ma_turn"
                            + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                    String.class, tenant, session, turn)), 45, "recovered Turn completion");
            assertThat(api("GET", "/v1/agents/sessions/" + session + "/turns/" + turn,
                    null, null, 200).path("status").asText()).isEqualTo("completed");
            await(() -> api("GET", "/v1/agents/sessions/" + session + "/items?limit=100",
                    null, null, 200).toString().contains("RESTART_OK"), 15,
                    "materialized recovered output");

            JsonNode state = driverState();
            assertThat(state.path("primaryRequests").asInt()).isEqualTo(1);
            assertThat(state.path("harnessAlive").asBoolean()).isTrue();
            List<String> deltas = jdbc.queryForList("SELECT data_json FROM ma_public_event"
                            + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?"
                            + " AND event_type = 'item.output_text.delta' ORDER BY sequence_id",
                    String.class, tenant, session, turn);
            String output = deltas.stream().map(value -> {
                try {
                    return JSON.readTree(value).path("text").asText();
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
            }).reduce("", String::concat);
            assertThat(output).isEqualTo("RESTART_OK");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event"
                            + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?"
                            + " AND event_type IN ('turn.completed','turn.failed','turn.cancelled')",
                    Integer.class, tenant, session, turn)).isEqualTo(1);
            assertThat(api("GET", "/v1/agents/sessions/" + session + "/events", null,
                    null, 200).path("data").toString()).contains("RESTART_").contains("OK")
                    .contains("turn.completed");

            JsonNode followup = api("POST", "/v1/agents/sessions/" + session + "/events", "follow-up", """
                    {"type":"agent.session.input.message",
                     "input":[{"type":"input_text","text":"FOLLOW_UP"}]}
                    """, 202);
            String followupTurn = followup.path("turn_id").asText();
            await(() -> "COMPLETED".equals(jdbc.queryForObject("SELECT status FROM ma_turn"
                            + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                    String.class, tenant, session, followupTurn)), 30, "following Turn completion");
            await(() -> api("GET", "/v1/agents/sessions/" + session + "/items?limit=100",
                    null, null, 200).toString().contains("FOLLOW_UP_OK"), 15,
                    "materialized following output");
            state = driverState();
            assertThat(state.path("primaryRequests").asInt()).isEqualTo(1);
            assertThat(state.path("followupRequests").asInt()).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ?"
                            + " AND session_id = ? AND status = 'COMPLETED'", Integer.class,
                    tenant, session)).isEqualTo(2);
            System.out.printf("ISSUE13327 coordinatorPid=%d replacementPid=%d session=%s turn=%s"
                            + " primaryModelRequests=1 output=%s terminal=1 followup=COMPLETED%n",
                    killedPid, spring.pid(), session, turn, output);
        }

        private void startDriver() throws Exception {
            Path config = root.resolve("coordinator-driver.json");
            Path ready = root.resolve("coordinator-driver-ready.json");
            JSON.writeValue(config.toFile(), Map.of("readyPath", ready.toString()));
            Path log = root.resolve("coordinator-driver.log");
            driver = new ProcessBuilder(node, "--import", "tsx",
                    "integration-tests/helpers/hosted-coordinator-restart-driver.ts", config.toString())
                    .directory(cli.getParent().getParent().toFile()).redirectErrorStream(true)
                    .redirectOutput(log.toFile()).start();
            processes.add(driver.toHandle());
            await(() -> Files.exists(ready) || !driver.isAlive(), 30, "coordinator driver readiness");
            assertThat(driver.isAlive()).as("Driver failed: %s", Files.readString(log)).isTrue();
            driverReady = (ObjectNode) JSON.readTree(Files.readString(ready));
        }

        private void startSpring() throws Exception {
            Path readiness = root.resolve("ready.json");
            Files.deleteIfExists(readiness);
            String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
            Path log = root.resolve("coordinator-spring-" + ++boots + ".log");
            ProcessBuilder builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", classpath, HostedProcessCrashFixtureMain.class.getName(), root.toString(), node,
                    cli.toString(), tenant, "coordinator-only", Integer.toString(port),
                    driverReady.path("harnessUrl").asText()).redirectErrorStream(true).redirectOutput(log.toFile());
            builder.environment().put("FG6C_MYSQL_URL", required("mysql.url"));
            builder.environment().put("FG6C_MYSQL_USER", required("mysql.user"));
            builder.environment().put("FG6C_MYSQL_PASSWORD", System.getProperty("mysql.password", ""));
            spring = builder.start();
            processes.add(spring.toHandle());
            await(() -> Files.exists(readiness) || !spring.isAlive(), 90, "coordinator Spring readiness");
            assertThat(spring.isAlive()).as("Spring failed: %s", Files.readString(log)).isTrue();
            assertThat(JSON.readTree(Files.readString(readiness)).path("storeUrl").asText())
                    .isEqualTo("http://127.0.0.1:" + port);
        }

        private JsonNode api(String method, String route, String idempotencyKey,
                String body, int expected) {
            try {
                HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + route))
                        .timeout(java.time.Duration.ofSeconds(10))
                        .header("X-Qwen-Tenant-Id", tenant).header("X-Qwen-Actor-Id", "actor")
                        .header("Accept", "application/json")
                        .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                                : HttpRequest.BodyPublishers.ofString(body));
                if (body != null) {
                    request.header("Content-Type", "application/json");
                }
                if (idempotencyKey != null) {
                    request.header("Idempotency-Key", idempotencyKey);
                }
                HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).as("%s %s: %s", method, route, response.body())
                        .isEqualTo(expected);
                return JSON.readTree(response.body());
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }

        private JsonNode driverState() {
            return control("GET", "/state");
        }

        private JsonNode control(String method, String route) {
            try {
                HttpRequest request = HttpRequest.newBuilder(URI.create(driverReady.path("controlUrl").asText() + route))
                        .timeout(java.time.Duration.ofSeconds(10))
                        .method(method, HttpRequest.BodyPublishers.noBody()).build();
                HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).as("driver %s %s: %s", method, route, response.body())
                        .isEqualTo(200);
                return JSON.readTree(response.body());
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }

        @Override
        public void close() throws Exception {
            if (driver != null && driver.isAlive()) {
                processes.addAll(driver.descendants().toList());
                if (driverReady == null) {
                    driver.destroyForcibly();
                } else {
                    try {
                        control("POST", "/stop");
                        if (!driver.waitFor(10, TimeUnit.SECONDS)) {
                            driver.destroyForcibly();
                        }
                    } catch (RuntimeException ignored) {
                        driver.destroyForcibly();
                    }
                }
            }
            if (spring != null) {
                processes.addAll(spring.descendants().toList());
            }
            processes.forEach(ProcessHandle::destroyForcibly);
            for (ProcessHandle process : processes) {
                HostedProcessLiveness.awaitStopped(process, Duration.ofSeconds(10), "process cleanup");
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
        private Map<String, Object> originalMember;
        private final int springPort;
        private final int harnessProxyPort;
        private final int brokerPort;
        private Process brokerSidecar;
        private ProcessHandle residentWorker;

        private Fixture(JdbcTemplate jdbc, String fault) throws Exception {
            this.jdbc = jdbc;
            this.fault = fault;
            root = Files.createDirectory(temporary.resolve(fault)).toRealPath();
            Files.createDirectory(root.resolve("runtime"));
            Files.createDirectories(root.resolve("workspace/child"));
            // Keep initialized-root mtime distinct from birth time without relying on sleeps.
            Files.setLastModifiedTime(root.resolve("workspace"), FileTime.fromMillis(1));
            springPort = freePort();
            harnessProxyPort = freePort();
            brokerPort = freePort();
            if (fault.equals("recovery-settlement")) {
                Files.setPosixFilePermissions(root.resolve("runtime"),
                        java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
                Files.createDirectory(root.resolve("coordinator-runtime"),
                        java.nio.file.attribute.PosixFilePermissions.asFileAttribute(
                                java.nio.file.attribute.PosixFilePermissions.fromString("rwx------")));
            }
            assertThat(cli).isRegularFile();
        }

        private void run() throws Exception {
            if (fault.equals("recovery-settlement")) {
                startBrokerSidecar();
            }
            startSpring();
            if (List.of("Linux", "Mac OS X").contains(System.getProperty("os.name"))) {
                var storageRegistrationProperties = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
                storageRegistrationProperties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
                storageRegistrationProperties.getRuntimeBroker().setWorkspaceMounts(List.of(
                        new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                                tenant, "storage", root.resolve("workspace").toString())));
                new com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard(jdbc,
                        new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()), storageRegistrationProperties, new com.alibaba.qwen.code.runtimebroker.provisioning.NativeStorageIdentityReader())
                        .register(tenant, "storage", UUID.randomUUID().toString());
            }
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
            if (fault.equals("recovery-settlement")) {
                ready.put("harnessProxyPort", harnessProxyPort);
            }
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
            assertThat(boots).isEqualTo(List.of("spring-kill", "recovery-settlement").contains(fault) ? 2 : 1);
            JsonNode report = JSON.readTree(Files.readString(Path.of(config + ".results")));
            if (fault.equals("recovery-settlement")) {
                assertResidentExecution();
                var finalExecutions = executions();
                assertThat(finalExecutions).hasSize(1);
                var originalExecution = finalExecutions.getFirst();
                assertThat(originalExecution.get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
                assertThat(originalExecution.get("idempotency_key")).isEqualTo(report.path("idempotencyKey").asText());
                assertThat(originalExecution.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
                assertThat(originalExecution.get("turn_id")).isEqualTo(report.path("promptId").asText());
                assertThat(((Number) originalExecution.get("dispatch_generation")).longValue()).isEqualTo(1);
                assertThat(report.path("modelCalls").asInt()).isEqualTo(2);
                assertThat(report.path("promptSubmissions").asInt()).isEqualTo(2);
                assertThat(report.path("cancelAdmissions").asInt()).isGreaterThanOrEqualTo(2);
                assertThat(report.path("continuationsAfterFailure").asInt()).isZero();
                assertThat(report.path("lateCancelReplays").asInt()).isEqualTo(1);
                assertThat(jdbc.queryForList("SELECT status FROM ma_turn WHERE tenant_id=?"
                        + " AND session_id=? ORDER BY gmt_create", String.class,
                        tenant, ready.path("sessionId").asText())).containsExactly("CANCELLED", "COMPLETED");
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE tenant_id=?"
                        + " AND session_id=? AND event_type IN ('turn.cancelled', 'turn.completed')"
                        + " AND source_key IS NOT NULL", Integer.class,
                        tenant, ready.path("sessionId").asText())).isEqualTo(2);
            } else {
                assertLedger(report);
            }
        }

        private void startSpring() throws Exception {
            Path readiness = root.resolve("ready.json");
            Files.deleteIfExists(readiness);
            String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
            Path log = root.resolve("spring-" + ++boots + ".log");
            var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", classpath, HostedProcessCrashFixtureMain.class.getName(), root.toString(), node,
                    cli.toString(), tenant, fault));
            if (fault.equals("recovery-settlement")) {
                command.addAll(List.of(Integer.toString(springPort), Integer.toString(harnessProxyPort),
                        Integer.toString(brokerPort)));
            }
            ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile());
            builder.environment().put("FG6C_MYSQL_URL", required("mysql.url"));
            builder.environment().put("FG6C_MYSQL_USER", required("mysql.user"));
            builder.environment().put("FG6C_MYSQL_PASSWORD", System.getProperty("mysql.password", ""));
            spring = builder.start();
            processes.add(spring.toHandle());
            await(() -> Files.exists(readiness) || !spring.isAlive(), 90, "Spring readiness");
            assertThat(spring.isAlive()).as("Spring failed: %s", Files.readString(log)).isTrue();
            ObjectNode next = (ObjectNode) JSON.readTree(Files.readString(readiness));
            if (ready != null) {
                assertThat(next.path("sessionId")).isEqualTo(ready.path("sessionId"));
            }
            ready = next;
        }

        private void startBrokerSidecar() throws Exception {
            Path log = root.resolve("broker-sidecar.log");
            String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
            var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", classpath, HostedProcessCrashFixtureMain.class.getName(), root.toString(), node,
                    cli.toString(), tenant, "recovery-broker", "0", Integer.toString(harnessProxyPort),
                    Integer.toString(brokerPort)).redirectErrorStream(true).redirectOutput(log.toFile());
            builder.environment().put("FG6C_MYSQL_URL", required("mysql.url"));
            builder.environment().put("FG6C_MYSQL_USER", required("mysql.user"));
            builder.environment().put("FG6C_MYSQL_PASSWORD", System.getProperty("mysql.password", ""));
            brokerSidecar = builder.start();
            processes.add(brokerSidecar.toHandle());
            Path readiness = root.resolve("broker-ready.json");
            await(() -> Files.exists(readiness) || !brokerSidecar.isAlive(), 90, "resident Broker readiness");
            assertThat(brokerSidecar.isAlive()).as("Broker failed: %s", Files.readString(log)).isTrue();
            assertThat(JSON.readTree(Files.readString(readiness)).path("brokerUrl").asText())
                    .isEqualTo("http://127.0.0.1:" + brokerPort + "/");
        }

        private void assertResidentExecution() {
            assertThat(brokerSidecar.isAlive()).as("resident Broker survived coordinator restart").isTrue();
            assertThat(spring.children().toList()).as("coordinator must not provision a worker").isEmpty();
            var workers = brokerSidecar.children().filter(process -> Arrays.asList(
                    process.info().arguments().orElse(new String[0])).contains("managed-runtime-worker")).toList();
            assertThat(workers).as("the resident Broker owns the original worker").hasSize(1);
            if (residentWorker == null) {
                residentWorker = workers.getFirst();
            }
            assertThat(workers.getFirst().pid()).isEqualTo(residentWorker.pid());
            assertThat(HostedProcessLiveness.running(residentWorker)).isTrue();
        }

        private Map<String, Object> control(String route) throws Exception {
            if (route.equals("/recovery-pending")) {
                assertResidentExecution();
                var turn = jdbc.queryForMap("SELECT status, error_code FROM ma_turn WHERE tenant_id=?"
                        + " AND session_id=?", tenant, ready.path("sessionId").asText());
                assertThat(turn.get("status")).isEqualTo("RUNNING");
                assertThat(turn.get("error_code")).isEqualTo(AgentStateStore.RUNTIME_RECOVERY_BLOCKED);
                var execution = executions();
                assertThat(execution).hasSize(1);
                assertThat(execution.getFirst().get("execution_state")).isIn("EXECUTING", "CANCEL_REQUESTED");
                assertThat(((Number) execution.getFirst().get("dispatch_generation")).longValue()).isEqualTo(1);
                assertOwner(execution.getFirst());
                return turn;
            }
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
            if (fault.equals("recovery-settlement")) {
                assertThat(execution.getFirst().get("execution_state")).isIn("EXECUTING", "CANCEL_REQUESTED");
            } else {
                assertThat(execution.getFirst().get("execution_state")).isEqualTo("EXECUTING");
            }
            assertThat(((Number) execution.getFirst().get("dispatch_generation")).longValue()).isEqualTo(1);
            assertOwner(execution.getFirst());
            if (route.equals("/recovery-settlement")) {
                control("/recovery-pending");
                processes.addAll(spring.descendants().toList());
                long pid = spring.pid();
                spring.destroyForcibly();
                assertThat(spring.waitFor(10, TimeUnit.SECONDS)).isTrue();
                assertThat(spring.exitValue()).isEqualTo(137);
                startSpring();
                assertResidentExecution();
                return Map.of("pid", pid, "newPid", spring.pid(), "signal", "SIGKILL",
                        "brokerPid", brokerSidecar.pid(), "workerPid", residentWorker.pid());
            }
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
                assertThat(HostedProcessLiveness.running(worker)).as("Spring SIGKILL leaves the real worker alive").isTrue();
                // Keep the Store down beyond the Harness's five-second writer lease.
                Thread.sleep(8_000);
                startSpring();
                assertThat(spring.children().toList()).as("restart must not spawn a replacement worker").isEmpty();
                return Map.of("pid", pid, "newPid", spring.pid(), "signal", "SIGKILL",
                        "storeUrl", ready.path("storeUrl").asText(), "brokerUrl", ready.path("brokerUrl").asText());
            }
            if (route.equals("/worker-kill")) {
                assertThat(worker.destroyForcibly()).isTrue();
                HostedProcessLiveness.awaitStopped(worker, Duration.ofSeconds(10), "worker SIGKILL");
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
            return jdbc.queryForList("SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns() + " FROM ma_tool_execution WHERE harness_session_id = ?",
                    ready.path("sessionId").asText());
        }

        private Map<String, Object> owner() throws Exception {
            return jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns("o") + " FROM ma_storage_owner o JOIN ma_storage s ON s.physical_key = o.storage_key WHERE s.alias_key = ? AND s.tenant_id = ? AND s.storage_id = ?",
                    com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.storageAliasKey(tenant, "storage"),
                    tenant, "storage");
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
            if (owner.get("holder_key") == null) {
                assertThat(owner.get("holder_key")).isNull();
                assertThat(owner.get("binding_id")).isNull();
                assertThat(owner.get("runtime_generation")).isNull();
                assertThat(owner.get("runtime_session_id")).isNull();
                assertThat(owner.get("maintenance_id")).isNull();
                assertThat(owner.get("storage_kind")).isEqualTo("LOCAL");
                assertThat(owner.get("mount_state")).isEqualTo("READY");
                assertThat(((Number) owner.get("mount_revision")).longValue()).isPositive();
                assertThat(owner.get("mount_root")).isEqualTo(root.resolve("workspace").toString());
                var members = jdbc.queryForList("SELECT " + ManagedSchemaProjection.RUNTIME_SESSION.columns()
                        + " FROM ma_runtime_session WHERE execution_storage_key=?", owner.get("storage_key"));
                assertThat(members).as("the original shared Workspace execution member").hasSize(1);
                var member = members.getFirst();
                if (originalMember == null) {
                    originalMember = new LinkedHashMap<>(member);
                }
                for (String key : List.of("scope_key", "tenant_id", "workspace_id", "workspace_generation",
                        "canonical_cwd", "capability_digest", "isolation_class", "harness_session_id",
                        "runtime_session_id", "binding_id", "runtime_generation", "execution_storage_key")) {
                    assertThat(member.get(key)).as("original Workspace member %s", key).isEqualTo(originalMember.get(key));
                }
                assertThat(member).containsEntry("tenant_id", tenant)
                        .containsEntry("harness_session_id", ready.path("sessionId").asText())
                        .containsEntry("workspace_id", "workspace").containsEntry("isolation_class", "session")
                        .containsEntry("capability_digest", WorkspaceExecutionProfile.CAPABILITY_DIGEST)
                        .containsEntry("canonical_cwd", owner.get("mount_root"))
                        .containsEntry("runtime_session_id", execution.get("runtime_session_id"))
                        .containsEntry("binding_id", execution.get("binding_id"))
                        .containsEntry("runtime_generation", execution.get("runtime_generation"))
                        .containsEntry("session_state", "READY").containsEntry("execution_exclusive", false);
                assertThat(((Number) member.get("runtime_generation")).longValue()).isEqualTo(1);
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding b"
                        + " JOIN ma_runtime_session rs ON rs.binding_id=b.binding_id AND rs.runtime_generation=b.runtime_generation"
                        + " JOIN ma_session s ON s.tenant_id=rs.tenant_id AND s.session_id=rs.harness_session_id"
                        + " JOIN ma_storage st ON st.tenant_id=s.tenant_id AND st.storage_id=s.workspace_storage_id"
                        + " WHERE rs.scope_key=? AND rs.runtime_session_id=? AND b.scope_key=rs.scope_key"
                        + " AND b.tenant_id=rs.tenant_id AND b.workspace_id=rs.workspace_id AND b.workspace_generation=rs.workspace_generation"
                        + " AND b.canonical_cwd=rs.canonical_cwd AND b.capability_digest=rs.capability_digest AND b.isolation_class=rs.isolation_class"
                        + " AND b.provisioner_kind='local-process' AND b.binding_state='READY' AND b.drain_requested=FALSE"
                        + " AND s.workspace_id=b.workspace_id AND s.workspace_generation=b.workspace_generation AND s.workspace_storage_id=b.storage_id"
                        + " AND st.physical_key=rs.execution_storage_key AND st.registration_state='REGISTERED' AND st.storage_kind='LOCAL'"
                        + " AND st.registration_revision>0 AND s.workspace_config_ref=? AND s.workspace_policy_ref=? AND s.context_config_ref=?",
                        Integer.class, member.get("scope_key"), member.get("runtime_session_id"),
                        WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF,
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF)).isEqualTo(1);
                return;
            }
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
            boolean settled = List.of("harness-start", "harness-result", "harness-unknown").contains(fault);
            assertThat(((Number) execution.get("dispatch_generation")).longValue()).isEqualTo(prepared ? 0 : 1);
            assertThat(execution.get("execution_state")).isEqualTo(prepared ? "PREPARED" : settled ? "SETTLED"
                    : fault.equals("spring-kill") ? "EXECUTING" : "UNKNOWN");
            assertThat(execution.get("execution_status")).isEqualTo(settled ? "success" : null);
            if (!settled) {
                assertThat(execution.get("result_json")).isNull();
            }
            assertOwner(execution);
            var session = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.RUNTIME_SESSION.columns() + " FROM ma_runtime_session WHERE harness_session_id = ?",
                    ready.path("sessionId").asText());
            assertThat(session.get("session_state")).isEqualTo("READY");
            assertThat(session.get("runtime_session_id")).isEqualTo(execution.get("runtime_session_id"));
            assertThat(session.get("binding_id")).isEqualTo(execution.get("binding_id"));
            assertThat(jdbc.queryForList("SELECT binding_state FROM ma_runtime_binding WHERE tenant_id = ?", String.class,
                    tenant)).containsExactly("READY");
            Path proof = root.resolve("workspace/child/proof.txt");
            assertThat(proof).isRegularFile();
            assertThat(Files.readString(proof)).isEqualTo(settled ? "xx" : "x");
            assertThat(root.resolve("workspace/proof.txt")).doesNotExist();
            assertJournal(report, prepared);
        }

        private void assertJournal(JsonNode report, boolean prepared) throws Exception {
            String session = ready.path("sessionId").asText();
            var journal = jdbc.queryForList("SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + " FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision", tenant, session);
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
            var head = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE tenant_id = ? AND session_id = ?",
                    tenant, session);
            assertThat(((Number) head.get("journal_revision")).longValue()).isEqualTo(revision);
            assertThat(((Number) head.get("committed_sequence")).longValue()).isEqualTo(sequence);
            Object checkpointId = head.get("latest_checkpoint_resource_id");
            // Led by the indexed session scope key, as in HostedGateTestSupport:
            // the raw tenant+session form scans the lane's accumulated ma_resource rows.
            byte[] checkpoint = jdbc.queryForObject("SELECT inline_bytes FROM ma_resource"
                    + " WHERE session_scope_key = ? AND resource_id = ? AND tenant_id = ? AND session_id = ?",
                    byte[].class, com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), checkpointId, tenant, session);
            JsonNode saved = JSON.readTree(checkpoint);
            assertThat(saved.path("continuation").path("phase").asText()).isEqualTo(prepared ? "before_model" : "await_runtime");
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("input.accepted")
                    && event.path("payload").path("turnId").equals(report.path("promptId")))).hasSize(1);
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("tool.intent"))).hasSize(prepared ? 0 : 1);
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("turn.settled"))).isEmpty();
            assertThat(events.stream().filter(event -> event.path("kind").asText().equals("message.committed")
                    && event.path("payload").path("role").asText().equals("tool_result"))).isEmpty();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE session_scope_key = ?"
                    + " AND kind = 'managed-tool-outcome' AND tenant_id = ? AND session_id = ?",
                    Integer.class, com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), tenant, session))
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
            if (brokerSidecar != null) {
                processes.addAll(brokerSidecar.descendants().toList());
            }
            processes.forEach(ProcessHandle::destroyForcibly);
            for (ProcessHandle process : processes) {
                HostedProcessLiveness.awaitStopped(process, Duration.ofSeconds(10), "process cleanup");
            }
            if (driver != null) {
                assertThat(driver.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
            if (spring != null) {
                assertThat(spring.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
            if (brokerSidecar != null) {
                assertThat(brokerSidecar.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
        }
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

    private static int freePort() throws java.io.IOException {
        try (var socket = new ServerSocket(0)) {
            return socket.getLocalPort();
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
