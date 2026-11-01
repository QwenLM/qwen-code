/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

// FG11c slice 2 (issue #14446): the Spring-side crash gates for the
// automation domains. The scanner and its lease live in Spring, so the
// control plane runs in its own JVM (HostedAutomationCrashFixtureMain) and
// the IT kills it with a POSIX signal mid-fire. This class starts with the
// fixture plumbing and the first crash window; the remaining windows land
// on top of the same lifecycle.
class HostedAutomationSpringCrashIT {
    private static final String MODEL = "fg11c2-model";
    private static final String TOKEN = "fg11-harness-token";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final Pattern LISTENING = Pattern.compile(
            "listening on http://127\\.0\\.0\\.1:(\\d+)");
    private final ObjectMapper json = new ObjectMapper();
    private final StringBuilder harnessLog = new StringBuilder();
    private final List<String> modelPrompts =
            Collections.synchronizedList(new ArrayList<>());

    @TempDir
    private Path temporary;

    private HttpServer model;
    private int modelPort;
    private Process harness;
    private int harnessPort = -1;
    private int brokerPort = -1;
    private Process fixture;
    private JdbcTemplate jdbc;
    private String controlUrl;
    private String internalUrl;
    private String publicUrl;
    private String tenant;
    private int fixtureInternalPort;
    private int fixturePublicPort;
    private String fixtureDatabaseUrl;
    private IsolatedManagedSchemaMySqlTestDatabase isolated;

    @AfterEach
    void tearDown() throws Exception {
        if (fixture != null) {
            fixture.destroyForcibly();
            fixture.waitFor(10, TimeUnit.SECONDS);
            fixture = null;
        }
        if (harness != null) {
            harness.descendants().forEach(child -> child.destroyForcibly());
            harness.destroyForcibly();
            harness = null;
        }
        if (model != null) {
            model.stop(0);
            model = null;
        }
        // Drop the owned database only after the children are gone: an open
        // pooled connection would hold the metadata lock DROP DATABASE needs.
        if (isolated != null) {
            isolated.close();
            isolated = null;
        }
    }

    @Test
    @Timeout(600)
    void fg11c2SpringFixtureBootsAndScansOnMySql() throws Exception {
        assertThat(System.getProperty("os.name"))
                .as("FG11c slice 2 sends POSIX signals")
                .doesNotContainIgnoringCase("windows");
        assertThat(System.getProperty("mysql.url"))
                .as("FG11c slice 2 requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user"))
                .as("FG11c slice 2 requires -Dmysql.user").isNotBlank();
        jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(
                new DriverManagerDataSource(required("mysql.url"),
                        required("mysql.user"),
                        System.getProperty("mysql.password", "")));
        jdbc.setQueryTimeout(10);
        temporary = temporary.toRealPath();
        String tenant = "hosted-automation-spring-" + UUID.randomUUID();
        startModel();
        harnessPort = freePort();
        brokerPort = freePort();
        Path root = Files.createDirectories(
                temporary.resolve("fixture"));
        startFixture(root, tenant);
        startHarness();
        // The control plane drives one scanner tick: with no definition
        // armed the tick must succeed and leave the ledger empty, which is
        // the baseline every crash case is measured against.
        control("scan", "");
        assertThat(occurrences(tenant)).as("no definition, no occurrence")
                .isZero();
        assertThat(fixture.isAlive()).as("fixture survived the tick").isTrue();
        assertThat(internalUrl).startsWith("http://127.0.0.1:");
    }

    private int occurrences(String tenant) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_schedule_occurrence"
                        + " WHERE tenant_id = ?", Integer.class, tenant);
        return count == null ? 0 : count;
    }

    private void control(String endpoint, String query) throws Exception {
        controlAt(controlUrl, endpoint, query);
    }

    private void controlAt(String base, String endpoint, String query)
            throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(base
                + "/control/" + endpoint + (query.isEmpty() ? "" : "?"
                        + query))).timeout(Duration.ofSeconds(10)).POST(
                HttpRequest.BodyPublishers.noBody()).build();
        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(204);
    }

    private record Child(Process process, String controlUrl,
            String publicUrl) {
    }

    private Child startChild(Path root, String tenant, int internalPort,
            int publicPort, int broker, int storeBasePort) throws Exception {
        if (fixtureDatabaseUrl == null) {
            // Cases that do not need a private database share the one the
            // pass provided.
            fixtureDatabaseUrl = required("mysql.url");
        }
        Path log = root.resolve("fixture.log");
        Files.deleteIfExists(root.resolve("ready.json"));
        ProcessBuilder builder = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", System.getProperty("java.class.path"),
                HostedAutomationCrashFixtureMain.class.getName(),
                root.toString(), required("node.executable"),
                cliEntry().toString(), tenant,
                String.valueOf(internalPort), String.valueOf(broker),
                String.valueOf(publicPort), String.valueOf(storeBasePort));
        builder.environment().put("FG11C_MYSQL_URL", fixtureDatabaseUrl);
        builder.environment().put("FG11C_MYSQL_USER", required("mysql.user"));
        builder.environment().put("FG11C_MYSQL_PASSWORD",
                System.getProperty("mysql.password", ""));
        builder.environment().put("FG11C_HARNESS_URL",
                "http://127.0.0.1:" + harnessPort);
        Process process = builder.redirectErrorStream(true)
                .redirectOutput(log.toFile()).start();
        await("fixture ready", 90, () -> {
            if (!process.isAlive()) {
                return new IllegalStateException("fixture exited:\n"
                        + HostedChannelGateSupport.safeRead(log));
            }
            return Files.exists(root.resolve("ready.json")) ? true : null;
        });
        JsonNode ready = json.readTree(
                Files.readString(root.resolve("ready.json")));
        return new Child(process, ready.path("controlUrl").asText(),
                ready.path("publicUrl").asText());
    }

    private void startFixture(Path root, String tenant) throws Exception {
        if (fixtureInternalPort == 0) {
            fixtureInternalPort = freePort();
            fixturePublicPort = freePort();
        }
        Child child = startChild(root, tenant, fixtureInternalPort,
                fixturePublicPort, brokerPort, fixtureInternalPort);
        fixture = child.process();
        controlUrl = child.controlUrl();
        publicUrl = child.publicUrl();
        internalUrl = json.readTree(
                Files.readString(root.resolve("ready.json")))
                .path("internalUrl").asText();
        this.tenant = tenant;
    }

    private int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 0,
                java.net.InetAddress.getLoopbackAddress())) {
            return socket.getLocalPort();
        }
    }

    private void startModel() throws IOException {
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelPort = model.getAddress().getPort();
        model.createContext("/v1/chat/completions", this::respondToModel);
        model.start();
    }

    private void respondToModel(HttpExchange exchange) throws IOException {
        try {
            String prompt = json.readTree(exchange.getRequestBody()).toString();
            modelPrompts.add(prompt);
            ObjectNode chunk = json.createObjectNode();
            chunk.put("id", "fg11c2-fixture")
                    .put("object", "chat.completion.chunk")
                    .put("created", 0).put("model", MODEL);
            ObjectNode choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "fg11c2-reply");
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
            byte[] body = (first + "data: " + json.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
        } finally {
            exchange.close();
        }
    }

    private void startHarness() throws Exception {
        Path cli = cliEntry();
        String node = required("node.executable");
        Path home = Files.createDirectories(temporary.resolve("harness-home"));
        Path config = Files.createDirectories(home.resolve(".qwen"));
        Path workspace = Files.createDirectories(
                temporary.resolve("harness-workspace"));
        String modelUrl = "http://127.0.0.1:" + modelPort + "/v1";
        Files.writeString(config.resolve("settings.json"),
                json.writeValueAsString(Map.of("security", Map.of("auth",
                        Map.of("selectedType", "openai")), "model",
                        Map.of("name", MODEL), "telemetry",
                        Map.of("enabled", false), "modelProviders",
                        Map.of("openai", List.of(Map.of("id", MODEL,
                                "envKey", "OPENAI_API_KEY", "baseUrl",
                                modelUrl))))));
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--port", String.valueOf(harnessPort), "--hostname",
                "127.0.0.1", "--require-auth", "--no-web", "--workspace",
                workspace.toString(), "--managed-runtime-broker-url",
                "http://127.0.0.1:" + brokerPort,
                "--managed-runtime-broker-token", "fg11-broker-token")
                .directory(workspace.toFile()).redirectErrorStream(true);
        Map<String, String> environment = builder.environment();
        environment.clear();
        for (String name : List.of("PATH", "SystemRoot", "WINDIR", "COMSPEC",
                "PATHEXT")) {
            if (System.getenv(name) != null) {
                environment.put(name, System.getenv(name));
            }
        }
        environment.putAll(Map.of("HOME", home.toString(), "USERPROFILE",
                home.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", temporary.resolve("harness-runtime").toString(),
                "OPENAI_API_KEY", "fake-local-key", "OPENAI_BASE_URL", modelUrl,
                "OPENAI_MODEL", MODEL, "QWEN_MODEL", MODEL,
                "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST));
        environment.put("TMPDIR", temporary.toString());
        environment.put("TMP", temporary.toString());
        environment.put("TEMP", temporary.toString());
        environment.put("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                temporary.resolve("system-settings.json").toString());
        environment.put("QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                temporary.resolve("system-defaults.json").toString());
        environment.put("QWEN_CODE_TRUSTED_FOLDERS_PATH",
                temporary.resolve("trusted-folders.json").toString());
        harness = builder.start();
        Thread.ofPlatform().daemon().start(() -> {
            try (var reader = harness.inputReader(StandardCharsets.UTF_8)) {
                char[] buffer = new char[2048];
                for (int count; (count = reader.read(buffer)) >= 0;) {
                    synchronized (harnessLog) {
                        harnessLog.append(buffer, 0, count);
                        if (harnessLog.length() > 32_768) {
                            harnessLog.delete(0, harnessLog.length() - 32_768);
                        }
                    }
                }
            } catch (IOException failure) {
                synchronized (harnessLog) {
                    harnessLog.append(failure);
                }
            }
        });
        await("harness listening", 90, () -> {
            if (!harness.isAlive()) {
                return new IllegalStateException("harness exited:\n"
                        + harnessLogSnapshot());
            }
            synchronized (harnessLog) {
                var match = LISTENING.matcher(harnessLog);
                if (!match.find()) {
                    return null;
                }
                if (Integer.parseInt(match.group(1)) != harnessPort) {
                    return new IllegalStateException("harness bound port "
                            + match.group(1) + " instead of the reserved "
                            + harnessPort + ":\n" + harnessLogSnapshot());
                }
                return true;
            }
        });
        await("harness ready", 30, () -> harnessReady() ? true : null);
    }

    private boolean harnessReady() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) URI.create("http://127.0.0.1:"
                    + harnessPort + "/capabilities").toURL().openConnection();
            connection.setRequestProperty("Authorization", "Bearer " + TOKEN);
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(1000);
            return connection.getResponseCode() == 200;
        } catch (IOException unavailable) {
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static Path cliEntry() {
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).as("Build and bundle the packaged CLI first")
                .isRegularFile();
        return cli;
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        assertThat(value).as("Pass -D" + name).isNotBlank();
        return value;
    }

    private void await(String description, int seconds,
            Supplier<Object> probe) throws Exception {
        Object outcome;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        Throwable lastFailure = null;
        while (System.nanoTime() < deadline) {
            try {
                outcome = probe.get();
            } catch (RuntimeException failure) {
                lastFailure = failure;
                outcome = null;
            }
            if (Boolean.TRUE.equals(outcome)) {
                return;
            }
            if (outcome instanceof IllegalStateException failure) {
                throw failure;
            }
            if (outcome instanceof Exception failure) {
                throw failure;
            }
            Thread.sleep(200);
        }
        String suffix = lastFailure == null ? ""
                : "\nlast probe failure: " + lastFailure;
        throw new AssertionError(description + " timed out; harness log:\n"
                + harnessLogSnapshot() + suffix, lastFailure);
    }

    @Test
    @Timeout(600)
    void fg11c2ScannerFiresOneOccurrenceOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG11c slice 2 requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(
                new DriverManagerDataSource(required("mysql.url"),
                        required("mysql.user"),
                        System.getProperty("mysql.password", "")));
        jdbc.setQueryTimeout(10);
        temporary = temporary.toRealPath();
        String tenantName = "hosted-automation-fire-" + UUID.randomUUID();
        startModel();
        harnessPort = freePort();
        brokerPort = freePort();
        Path root = Files.createDirectories(temporary.resolve("fire"));
        startFixture(root, tenantName);
        startHarness();
        String session = createSession("fire");
        String definition = apiRequest("POST", "/v1/agent-automations",
                definition(session, "FG11C2_FIRE"), "fg11c2-def", 202)
                .path("id").asText();
        assertThat(definition).startsWith("asch_");
        // One scanner tick must open a slot for the every-minute definition.
        control("scan", "");
        await("occurrence for the definition", 120, () -> {
            Integer count = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM ma_schedule_occurrence"
                            + " WHERE tenant_id = ? AND schedule_id = ?",
                    Integer.class, tenant, definition);
            return count != null && count > 0 ? true : null;
        });
    }

    private boolean watermarkReached() {
        try {
            HttpRequest request = HttpRequest.newBuilder(
                            URI.create(controlUrl
                                    + "/control/watermark-reached"))
                    .timeout(Duration.ofSeconds(5)).GET().build();
            HttpResponse<String> response = HttpClient.newHttpClient()
                    .send(request, HttpResponse.BodyHandlers.ofString());
            return response.statusCode() == 200
                    && response.body().contains("\"reached\":true");
        } catch (Exception unavailable) {
            return false;
        }
    }

    private Long watermarkSlot(String scheduleId) {
        return jdbc.queryForObject(
                "SELECT watermark_slot FROM ma_schedule WHERE tenant_id = ?"
                        + " AND schedule_id = ?", Long.class, tenant,
                scheduleId);
    }

    private void triggerScanAsync() {
        Thread.ofPlatform().daemon().start(() -> {
            try {
                control("scan", "");
            } catch (Exception parked) {
                // The scanner thread is parked on the watermark row; the
                // kill ends it, so the control answer never arrives.
            }
        });
    }

    @Test
    @Timeout(600)
    void fg11c2SpringKillBeforeWatermarkNeverFiresTwice() throws Exception {
        assertThat(System.getProperty("os.name"))
                .as("FG11c slice 2 sends POSIX signals")
                .doesNotContainIgnoringCase("windows");
        assertThat(System.getProperty("mysql.url"))
                .as("FG11c slice 2 requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        String databaseUrl = freshDatabaseUrl();
        jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(
                new DriverManagerDataSource(databaseUrl,
                        required("mysql.user"),
                        System.getProperty("mysql.password", "")));
        jdbc.setQueryTimeout(10);
        temporary = temporary.toRealPath();
        String tenantName = "hosted-automation-kill-watermark-"
                + UUID.randomUUID();
        startModel();
        harnessPort = freePort();
        brokerPort = freePort();
        Path root = Files.createDirectories(
                temporary.resolve("kill-watermark"));
        startFixture(root, tenantName);
        startHarness();
        String session = createSession("kill-watermark");
        String definition = apiRequest("POST", "/v1/agent-automations",
                definition(session, "FG11C2_KILL_WATERMARK"),
                "fg11c2-kw-def", 202).path("id").asText();
        control("arm-watermark", "");
        triggerScanAsync();
        await("the occurrence settled before the watermark move", 120,
                () -> "fired".equals(occurrenceOutcome(definition))
                        ? true : null);
        await("the watermark advance reached the hold", 60,
                () -> watermarkReached() ? true : null);
        // The answer landed; the covered marker has not moved yet.
        killFixture();
        startFixture(root, tenantName);
        await("the watermark catches up without a second fire", 240, () -> {
            Integer chains = jdbc.queryForObject(
                    "SELECT COUNT(DISTINCT run_id) FROM ma_schedule_occurrence"
                            + " WHERE tenant_id = ? AND schedule_id = ?"
                            + " AND outcome = 'fired'",
                    Integer.class, tenant, definition);
            return watermarkSlot(definition) != null && chains != null
                    && chains == 1 ? true : null;
        });
        String runId = runIdOf(definition);
        assertThat(committedRuns(session))
                .as("one committed automation_run across the crash")
                .isEqualTo(1);
        assertThat(acceptedInputs(session, runId))
                .as("one accepted input across the crash")
                .isEqualTo(1);
        // The kill also drops the Harness's Session connection, so the
        // wake turn may be aborted before its model call; no Turn is asserted.
        assertThat(occurrenceOutcome(definition)).isEqualTo("fired");
    }

    private String freshDatabaseUrl() {
        // The owned database is created through an admin connection and
        // dropped on close; the Hosted lane creates only its own catalog.
        isolated = new IsolatedManagedSchemaMySqlTestDatabase();
        fixtureDatabaseUrl = isolated.url();
        return fixtureDatabaseUrl;
    }

    private void killFixture() throws Exception {
        assertThat(fixture).as("a fixture to kill").isNotNull();
        fixture.destroyForcibly();
        assertThat(fixture.waitFor(15, TimeUnit.SECONDS))
                .as("the killed Spring generation exited").isTrue();
        fixture = null;
    }

    @Test
    @Timeout(600)
    void fg11c2SpringKillBeforeAnswerNeverFiresTwice() throws Exception {
        assertThat(System.getProperty("os.name"))
                .as("FG11c slice 2 sends POSIX signals")
                .doesNotContainIgnoringCase("windows");
        assertThat(System.getProperty("mysql.url"))
                .as("FG11c slice 2 requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        String databaseUrl = freshDatabaseUrl();
        jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(
                new DriverManagerDataSource(databaseUrl,
                        required("mysql.user"),
                        System.getProperty("mysql.password", "")));
        jdbc.setQueryTimeout(10);
        temporary = temporary.toRealPath();
        String tenantName = "hosted-automation-kill-answer-" + UUID.randomUUID();
        startModel();
        harnessPort = freePort();
        brokerPort = freePort();
        Path root = Files.createDirectories(temporary.resolve("kill-answer"));
        startFixture(root, tenantName);
        startHarness();
        String session = createSession("kill-answer");
        String definition = apiRequest("POST", "/v1/agent-automations",
                definition(session, "FG11C2_KILL_ANSWER"), "fg11c2-ka-def", 202)
                .path("id").asText();
        control("arm-fire", "");
        control("scan", "");
        await("the scanner's fire reached the hold", 120,
                () -> fireReached() ? true : null);
        assertThat(occurrenceOutcome(definition)).isEqualTo("firing");
        // Kill Spring with the answer in flight: the occurrence is committed,
        // the answer never lands.
        killFixture();
        startFixture(root, tenantName);
        await("one run chain for the re-driven slot", 240, () -> {
            Integer chains = jdbc.queryForObject(
                    "SELECT COUNT(DISTINCT run_id) FROM ma_schedule_occurrence"
                            + " WHERE tenant_id = ? AND schedule_id = ?"
                            + " AND outcome = 'fired'",
                    Integer.class, tenant, definition);
            return "fired".equals(occurrenceOutcome(definition))
                    && chains != null && chains == 1 ? true : null;
        });
        String runId = runIdOf(definition);
        assertThat(committedRuns(session))
                .as("one committed automation_run for the re-driven slot")
                .isEqualTo(1);
        assertThat(acceptedInputs(session, runId))
                .as("one accepted input for the re-driven slot")
                .isEqualTo(1);
        // The kill also drops the Harness's Session connection, so the wake
        // turn may be aborted before its model call. This case owns the
        // committed run and its accepted input, not a Turn count.
    }

    private boolean fireReached() {
        try {
            HttpRequest request = HttpRequest.newBuilder(
                            URI.create(controlUrl + "/control/fire-reached"))
                    .timeout(Duration.ofSeconds(5)).GET().build();
            HttpResponse<String> response = HttpClient.newHttpClient()
                    .send(request, HttpResponse.BodyHandlers.ofString());
            return response.statusCode() == 200
                    && response.body().contains("\"reached\":true");
        } catch (Exception unavailable) {
            return false;
        }
    }

    private String runIdOf(String schedule) {
        List<String> runIds = jdbc.queryForList(
                "SELECT run_id FROM ma_schedule_occurrence WHERE tenant_id = ?"
                        + " AND schedule_id = ?"
                        + " AND outcome IN ('firing', 'fired')"
                        + " ORDER BY slot DESC LIMIT 1", String.class, tenant,
                schedule);
        assertThat(runIds)
                .as("a firing or fired occurrence for %s carries a run id",
                        schedule)
                .isNotEmpty();
        return runIds.get(0);
    }

    private int committedRuns(String sessionId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_session_record WHERE tenant_id = ?"
                        + " AND session_id = ? AND domain = 'automation_run'",
                Integer.class, tenant, sessionId);
        return count == null ? 0 : count;
    }

    private int acceptedInputs(String sessionId, String runId)
            throws Exception {
        int count = 0;
        for (byte[] record : jdbc.queryForList(
                "SELECT record_bytes FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY journal_revision",
                byte[].class, tenant, sessionId)) {
            for (String line : new String(record, StandardCharsets.UTF_8)
                    .lines().toList()) {
                JsonNode entry = json.readTree(line);
                if ("managed_session_event_v1".equals(
                        entry.path("subtype").asText())
                        && "input.accepted".equals(entry.path(
                                "managedSession").path("kind").asText())
                        && entry.path("managedSession").path("eventId")
                                .asText().startsWith(runId + ":")) {
                    count++;
                }
            }
        }
        return count;
    }

    private String occurrenceOutcome(String schedule) {
        List<String> outcomes = jdbc.queryForList(
                "SELECT outcome FROM ma_schedule_occurrence WHERE tenant_id = ?"
                        + " AND schedule_id = ?"
                        + " AND outcome IN ('firing', 'fired')"
                        + " ORDER BY slot DESC LIMIT 1", String.class,
                tenant, schedule);
        // The waiters poll this helper before the slot row exists, so an
        // absent row must read as a value they can compare, not a throw.
        return outcomes.isEmpty() ? "absent" : outcomes.get(0);
    }

    @Test
    @Timeout(600)
    void fg11c2TwoScannerRaceFiresOnce() throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG11c slice 2 requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        String databaseUrl = freshDatabaseUrl();
        jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(
                new DriverManagerDataSource(databaseUrl,
                        required("mysql.user"),
                        System.getProperty("mysql.password", "")));
        jdbc.setQueryTimeout(10);
        temporary = temporary.toRealPath();
        String tenantName = "hosted-automation-race-" + UUID.randomUUID();
        startModel();
        harnessPort = freePort();
        brokerPort = freePort();
        Path rootA = Files.createDirectories(temporary.resolve("race-a"));
        Path rootB = Files.createDirectories(temporary.resolve("race-b"));
        startFixture(rootA, tenantName);
        startHarness();
        // The store is the primary child's. The second child binds no
        // internal listener (port 0) and points its store base URL at the
        // primary, or the Harness rejects every load with a store mismatch.
        Child second = startChild(rootB, tenantName, 0, freePort(),
                freePort(), fixtureInternalPort);
        try {
            String session = createSession("race");
            String definition = apiRequest("POST", "/v1/agent-automations",
                    definition(session, "FG11C2_RACE"), "fg11c2-race-def",
                    202).path("id").asText();
            // Two scanners, one due slot: the first claims it, and the
            // second's tick must leave the ledger alone.
            control("scan", "");
            controlAt(second.controlUrl(), "scan", "");
            await("one occurrence and one run chain", 180, () -> {
                Integer occurrences = jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_schedule_occurrence"
                                + " WHERE tenant_id = ? AND schedule_id = ?"
                                + " AND outcome = 'fired'",
                        Integer.class, tenant, definition);
                Integer chains = jdbc.queryForObject(
                        "SELECT COUNT(DISTINCT run_id) FROM"
                                + " ma_schedule_occurrence WHERE tenant_id = ?"
                                + " AND schedule_id = ? AND outcome = 'fired'",
                        Integer.class, tenant, definition);
                return occurrences != null && occurrences == 1
                        && chains != null && chains == 1
                        && "fired".equals(occurrenceOutcome(definition))
                        ? true : null;
            });
            String runId = runIdOf(definition);
            assertThat(committedRuns(session))
                    .as("one committed automation_run for the raced slot")
                    .isEqualTo(1);
            assertThat(acceptedInputs(session, runId))
                    .as("one accepted input for the raced slot")
                    .isEqualTo(1);
            await("one model Turn for the raced slot", 120,
                    () -> modelPrompts.stream().anyMatch(prompt -> prompt
                            .contains("FG11C2_RACE")) ? true : null);
            long turns = modelPrompts.stream()
                    .filter(prompt -> prompt.contains("FG11C2_RACE"))
                    .count();
            assertThat(turns).as("one model Turn for the raced slot")
                    .isEqualTo(1);
        } finally {
            second.process().destroyForcibly();
            second.process().waitFor(15, TimeUnit.SECONDS);
        }
    }

    private String createSession(String name) throws Exception {
        String session = apiRequest("POST", "/v1/agents/sessions",
                Map.of("agent_id", "qwen-code", "input", List.of(),
                        "workspace", Map.of("workspace_id", "workspace-0",
                                "cwd_relative", "child")),
                "fg11c2-session-" + name, 202).path("id").asText();
        await("session active", 90, () -> "ACTIVE".equals(jdbc.queryForObject(
                "SELECT status FROM ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, tenant,
                session)) ? true : null);
        // The automation verbs load the Session on the Harness, never create
        // it, so the Session runs one Turn first.
        apiRequest("POST", "/v1/agents/sessions/" + session + "/events",
                Map.of("type", "agent.session.input.message", "input",
                        List.of(Map.of("type", "input_text", "text",
                                "FG11C2_WARM " + name))),
                "fg11c2-warm-" + name, 202);
        await("warm turn completed", 120, () -> jdbc.queryForList(
                "SELECT status FROM ma_turn WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, tenant, session)
                .contains("COMPLETED") ? true : null);
        return session;
    }

    private Map<String, Object> definition(String session, String goal) {
        return Map.of("session_id", session, "goal", goal,
                "cron", "* * * * *", "timezone", "UTC",
                "prompt", goal + " reply with FG11C2_DONE.");
    }

    private JsonNode apiRequest(String method, String path, Object body,
            String key, int expected) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                        URI.create(publicUrl + path))
                .timeout(Duration.ofSeconds(60))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("x-qwen-actor", "actor")
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .method(method, body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(
                                json.writeValueAsString(body)));
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode())
                .as("%s %s: %s", method, path, response.body())
                .isEqualTo(expected);
        return json.readTree(response.body());
    }

    private String harnessLogSnapshot() {
        synchronized (harnessLog) {
            return harnessLog.toString();
        }
    }
}
