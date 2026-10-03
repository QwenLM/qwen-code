package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.h2.tools.Server;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class HostedWorkspaceConcurrencyIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final boolean LINUX = System.getProperty("os.name").equals("Linux");
    private static final String TOKEN = "w1-concurrency-fixture";
    @TempDir Path temporary;

    @Test
    @Timeout(180)
    void twoBrokerProcessesSerializeFenceClaimDispatchAndStaleCleanup() throws Exception {
        temporary = temporary.toRealPath();
        Server h2 = null;
        String url = System.getProperty("mysql.url");
        String user = System.getProperty("mysql.user", "sa");
        String password = System.getProperty("mysql.password", "");
        if (url == null) {
            h2 = Server.createTcpServer("-tcpPort", "0", "-ifNotExists").start();
            url = "jdbc:h2:tcp://localhost:" + h2.getPort() + "/mem:w1-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE";
        } else {
            assertThat(url).startsWith("jdbc:mysql:");
            assertThat(LINUX).as("MySQL acceptance requires physical Linux identity").isTrue();
        }
        var source = new DriverManagerDataSource(url, user, password);
        var jdbc = new JdbcTemplate(source);
        String tenant = "w1-race-" + UUID.randomUUID();
        Throwable failure = null;
        try {
            Path root = Files.createDirectory(temporary.resolve("workspace"));
            // Keep initialized-root mtime distinct from birth time without relying on sleeps.
            Files.setLastModifiedTime(root, FileTime.fromMillis(1));
            Files.createDirectory(temporary.resolve("initial-state"));
            var properties = properties(tenant, root, temporary.resolve("initial-state"));
            Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
            var store = store(source, properties);
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES (?, 'workspace', 1, 'storage', 'Race', ?, ?, 'ACTIVE')", tenant,
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES (?, 'workspace', ?, TRUE, TRUE)", tenant, "actor".getBytes(StandardCharsets.UTF_8));
            var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
            String firstSession = transaction.execute(status -> store.insertWorkspaceSessionCommand(tenant, "actor",
                    "first", "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                    new WorkspaceSelection("workspace", ".")).sessionId());
            String secondSession = transaction.execute(status -> store.insertWorkspaceSessionCommand(tenant, "actor",
                    "second", "sha256:" + "b".repeat(64), "qwen-code", null, null, List.of(), null,
                    new WorkspaceSelection("workspace", ".")).sessionId());
            guard(source, properties).register(tenant, "storage", UUID.randomUUID().toString());
            Map<String, Object> config = Map.of("url", url, "user", user, "password", password,
                    "tenant", tenant, "root", root.toString());
            try (Broker first = new Broker("first", config); Broker second = new Broker("second", config)) {
                second.ok("/runtimes:warm", Map.of("harnessSessionId", secondSession));
                String runtime = UUID.randomUUID().toString();
                first.arm("before-claim");
                var pending = first.acquire(firstSession, runtime);
                first.reached();
                first.assertWorker();
                second.assertWorker();
                String operation = UUID.randomUUID().toString();
                second.command("fence", 1, operation, true);
                var fenced = row(jdbc, tenant);
                assertThat(fenced).containsEntry("mount_state", "FENCED").containsEntry("mount_revision", 1L);
                for (String field : List.of("holder_key", "binding_id", "runtime_generation", "runtime_session_id")) {
                    assertThat(fenced.get(field)).as("%s", field).isNull();
                }
                first.resume();
                var refused = pending.get(20, TimeUnit.SECONDS);
                assertThat(row(jdbc, tenant)).isEqualTo(fenced);
                assertThat(refused.statusCode()).as("%s", refused.body()).isEqualTo(409);
                assertThat(refused.body()).contains("workspace_unavailable");
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE binding_id IN"
                        + " (SELECT binding_id FROM qwen_runtime_binding WHERE tenant_id = ?)",
                        Long.class, tenant)).isZero();
                try (var files = Files.list(root)) {
                    assertThat(files.map(path -> path.getFileName().toString()).toList())
                            .containsExactly(".qwen-managed-storage.json");
                }
                second.command("restore", 1, operation, true);

                runtime = UUID.randomUUID().toString();
                first.arm("after-claim");
                pending = first.acquire(firstSession, runtime);
                first.reached();
                var held = row(jdbc, tenant);
                assertThat(held).containsEntry("mount_state", "READY").containsEntry("mount_revision", 2L)
                        .containsEntry("runtime_session_id", runtime);
                for (String field : List.of("holder_key", "binding_id", "runtime_generation")) {
                    assertThat(held.get(field)).as("%s", field).isNotNull();
                }
                second.command("fence", 2, UUID.randomUUID().toString(), false);
                assertThat(row(jdbc, tenant)).isEqualTo(held);
                first.resume();
                assertOk(pending.get(20, TimeUnit.SECONDS));
                String execution = first.prepareWrite(firstSession, runtime, root.resolve("first.txt"), "first");
                first.arm("before-dispatch");
                pending = first.postAsync("/executions/" + execution + ":start",
                        Map.of("harnessSessionId", firstSession, "runtimeSessionId", runtime));
                first.reached();
                second.command("fence", 2, UUID.randomUUID().toString(), false);
                assertThat(row(jdbc, tenant)).isEqualTo(held);
                assertThat(root.resolve("first.txt")).doesNotExist();
                first.resume();
                assertOk(pending.get(20, TimeUnit.SECONDS));
                var executionStore = new JdbcToolExecutionRepository(source);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                while (executionStore.findByExecutionCallId(execution).getResult() == null) {
                    if (System.nanoTime() > deadline) throw new AssertionError("Tool did not settle");
                    Thread.sleep(10);
                }
                assertThat(executionStore.findByExecutionCallId(execution).getResult())
                        .containsEntry("executionStatus", "success");
                assertThat(Files.readString(root.resolve("first.txt"))).isEqualTo("first");

                first.arm("after-release");
                pending = first.postAsync("/tool-sessions/" + runtime + ":release",
                        Map.of("harnessSessionId", firstSession));
                first.reached();
                first.assertWorker();
                operation = UUID.randomUUID().toString();
                second.command("fence", 2, operation, true);
                second.command("restore", 2, operation, true);
                String rival = UUID.randomUUID().toString();
                assertOk(second.acquire(secondSession, rival).get(20, TimeUnit.SECONDS));
                var newer = row(jdbc, tenant);
                assertThat(newer).containsEntry("mount_revision", 3L).containsEntry("runtime_session_id", rival);
                first.resume();
                assertOk(pending.get(20, TimeUnit.SECONDS));
                assertThat(row(jdbc, tenant)).as("duplicate old release preserves new holder and guard").isEqualTo(newer);
                second.ok("/tool-sessions/" + rival + ":release", Map.of("harnessSessionId", secondSession));

                if (LINUX) {
                    runtime = UUID.randomUUID().toString();
                    assertOk(first.acquire(firstSession, runtime).get(20, TimeUnit.SECONDS));
                    first.arm("after-lost-release");
                    first.sendCommand("lost-cleanup", 0, runtime);
                    first.reached();
                    operation = UUID.randomUUID().toString();
                    second.command("fence", 3, operation, true);
                    second.command("restore", 3, operation, true);
                    rival = UUID.randomUUID().toString();
                    assertOk(second.acquire(secondSession, rival).get(20, TimeUnit.SECONDS));
                    newer = row(jdbc, tenant);
                    assertThat(newer).containsEntry("mount_revision", 4L).containsEntry("runtime_session_id", rival);
                    first.resume();
                    first.commandResult(true);
                    assertThat(row(jdbc, tenant)).as("valid old LOST cleanup preserves new holder and guard").isEqualTo(newer);
                    second.ok("/tool-sessions/" + rival + ":release", Map.of("harnessSessionId", secondSession));
                }
                System.out.println("W1_TWO_BROKER_A4_OK physical=" + LINUX + " staleLost=" + LINUX);
            }
        } catch (Exception | Error error) {
            failure = error;
            throw error;
        } finally {
            try {
                jdbc.update("DELETE FROM qwen_tool_execution WHERE binding_id IN"
                        + " (SELECT binding_id FROM qwen_runtime_binding WHERE tenant_id = ?)", tenant);
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE binding_id IN"
                        + " (SELECT binding_id FROM qwen_runtime_binding WHERE tenant_id = ?)",
                        Long.class, tenant)).isZero();
                for (String table : List.of("qwen_runtime_session", "qwen_runtime_binding",
                        "qwen_runtime_binding_slot", "qwen_runtime_placement_guard",
                        "managed_workspace_execution_lease", "managed_agent_event",
                        "managed_agent_consumer_progress", "managed_workspace_create_command",
                        "managed_session_create_scope", "managed_agent_session",
                        "managed_workspace_access", "managed_workspace_registry")) {
                    jdbc.update("DELETE FROM " + table + " WHERE tenant_id = ?", tenant);
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE tenant_id = ?",
                            Long.class, tenant)).as("%s fixture tenant cleanup", table).isZero();
                }
            } catch (RuntimeException | Error cleanupFailure) {
                if (failure == null) {
                    failure = cleanupFailure;
                    throw cleanupFailure;
                }
                failure.addSuppressed(cleanupFailure);
            } finally {
                try {
                    if (h2 != null) h2.stop();
                } catch (RuntimeException | Error stopFailure) {
                    if (failure == null) throw stopFailure;
                    failure.addSuppressed(stopFailure);
                }
            }
        }
    }

    private static Map<String, Object> row(JdbcTemplate jdbc, String tenant) {
        return jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE tenant_id = ?", tenant);
    }

    private static ManagedAgentStore store(DriverManagerDataSource source, ManagedAgentProperties properties) {
        var jdbc = new JdbcTemplate(source);
        return new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), ignored -> { },
                new ManagedWorkspaceRegistry(jdbc), properties);
    }

    private static ManagedAgentProperties properties(String tenant, Path root, Path state) {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setCapabilityDigest("a".repeat(64));
        var broker = properties.getRuntimeBroker();
        broker.setToken(TOKEN);
        broker.setPort(0);
        broker.setWorkspaceGeneration("1");
        broker.setWorkspaceCwd(root.toString());
        broker.setProvisioner("local-process");
        broker.setDurableLocalProcess(LINUX);
        // Linux brokers run the production-default combination; elsewhere the
        // legacy combination keeps this IT runnable on developer hosts.
        broker.setTrustedLocalRebootRecovery(LINUX);
        broker.setStateDirectory(state.toString());
        broker.setNodeExecutable(System.getProperty("node.executable", "node"));
        String bundle = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath().toString();
        broker.setWorkerEntry(bundle);
        broker.setCliEntry(bundle);
        broker.setVerifiedWorkspaceRecoveryEnabled(true);
        broker.setWorkspaceMounts(List.of(new WorkspaceMount(tenant, "storage", root.toString())));
        return properties;
    }

    private static WorkspaceStorageGuard guard(DriverManagerDataSource source, ManagedAgentProperties properties) {
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        if (LINUX) return new WorkspaceStorageGuard(jdbc, manager, properties);
        return new WorkspaceStorageGuard(jdbc, manager, properties, root -> {
            var attributes = Files.readAttributes(root, BasicFileAttributes.class);
            if (!attributes.isDirectory() || !root.equals(root.toRealPath())) throw new java.io.IOException("Invalid root");
            return new WorkspaceStorageGuard.Identity(root.toString(), "synthetic-host", "synthetic-device",
                    attributes.fileKey().toString(), attributes.creationTime().toInstant().toString());
        });
    }

    private static JsonNode assertOk(HttpResponse<String> response) throws Exception {
        assertThat(response.statusCode()).as("%s", response.body()).isEqualTo(200);
        return JSON.readTree(response.body());
    }

    private static void awaitFile(Path path, Process process) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (!Files.exists(path)) {
            assertThat(process.isAlive()).as("Broker exited before %s", path).isTrue();
            if (System.nanoTime() > deadline) throw new AssertionError("Barrier timeout: " + path);
            Thread.sleep(10);
        }
    }

    private final class Broker implements AutoCloseable {
        final Path directory;
        final Process process;
        final PrintWriter commands;
        final HttpClient http = HttpClient.newHttpClient();
        final URI endpoint;

        Broker(String name, Map<String, Object> configuration) throws Exception {
            directory = Files.createDirectory(temporary.resolve(name));
            Files.createDirectory(directory.resolve("state"));
            if (LINUX) Files.setPosixFilePermissions(directory.resolve("state"),
                    PosixFilePermissions.fromString("rwx------"));
            JSON.writeValue(directory.resolve("config.json").toFile(), configuration);
            process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin/java").toString(),
                    "-Dnode.executable=" + System.getProperty("node.executable", "node"),
                    "-Dqwen.cli.entry=" + Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath(),
                    "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                    BrokerMain.class.getName(), directory.toString()).redirectErrorStream(true)
                    .redirectOutput(directory.resolve("broker.log").toFile()).start();
            commands = new PrintWriter(process.getOutputStream(), true, StandardCharsets.UTF_8);
            try {
                awaitFile(directory.resolve("ready.json"), process);
                endpoint = URI.create(JSON.readTree(directory.resolve("ready.json").toFile()).get("uri").asText());
            } catch (Exception | AssertionError error) {
                close();
                throw error;
            }
            System.out.println("W1_BROKER_PID " + name + "=" + process.pid());
        }

        java.util.concurrent.CompletableFuture<HttpResponse<String>> acquire(String session, String runtime) throws Exception {
            return postAsync("/tool-sessions:acquire", Map.of("harnessSessionId", session,
                    "runtimeSessionId", runtime, "turnKind", "bootstrap"));
        }

        java.util.concurrent.CompletableFuture<HttpResponse<String>> postAsync(String route, Map<String, Object> body) throws Exception {
            var request = new LinkedHashMap<String, Object>(body);
            request.put("protocolVersion", 1);
            request.put("requestId", UUID.randomUUID().toString());
            return http.sendAsync(HttpRequest.newBuilder(endpoint.resolve(RuntimeBrokerHttpServer.ROUTE_PREFIX + route))
                    .timeout(Duration.ofSeconds(30)).header("Authorization", "Bearer " + TOKEN)
                    .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(request))).build(),
                    HttpResponse.BodyHandlers.ofString());
        }

        JsonNode ok(String route, Map<String, Object> body) throws Exception {
            return assertOk(postAsync(route, body).get(30, TimeUnit.SECONDS));
        }

        JsonNode control(String session, String runtime, Map<String, Object> operation) throws Exception {
            return ok("/tool-sessions/" + runtime + "/control", Map.of("harnessSessionId", session,
                    "operation", operation)).get("result");
        }

        String prepareWrite(String session, String runtime, Path file, String content) throws Exception {
            JsonNode manifest = control(session, runtime, Map.of("kind", "manifest"));
            Map<String, Object> identity = Map.of("sessionId", runtime, "promptId", "turn", "callId", "write",
                    "capabilityDigest", manifest.get("capabilityDigest").asText(),
                    "policyRevision", manifest.get("policyRevision").asText());
            control(session, runtime, Map.of("kind", "bind-history", "binding", Map.of("ownerSessionId", session,
                    "ownerRuntimeSessionId", runtime, "executionCwd", file.getParent().toString(), "snapshots", List.of())));
            control(session, runtime, Map.of("kind", "begin-turn", "identity", identity));
            JsonNode prepared = control(session, runtime, Map.of("kind", "prepare", "identity", identity,
                    "toolName", "write_file", "input", Map.of("file_path", file.toString(), "content", content)));
            Map<String, Object> ref = new LinkedHashMap<>();
            for (String field : List.of("sessionId", "promptId", "callId", "capabilityDigest", "policyRevision",
                    "invocationId", "argsDigest")) {
                ref.put(field, prepared.get(field).asText());
            }
            control(session, runtime, Map.of("kind", "confirmation", "reference", ref));
            control(session, runtime, Map.of("kind", "confirm", "reference", ref, "outcome", "proceed_once"));
            control(session, runtime, Map.of("kind", "preflight", "reference", ref));
            return ok("/executions:prepare", Map.of("idempotencyKey", "write-" + runtime, "harnessSessionId", session,
                    "runtimeSessionId", runtime, "turnId", "turn", "toolCallId", "write",
                    "requestDigest", ref.get("argsDigest"), "reference", ref)).get("executionCallId").asText();
        }

        void arm(String stage) throws Exception {
            Files.deleteIfExists(directory.resolve("reached"));
            Files.deleteIfExists(directory.resolve("resume"));
            Files.writeString(directory.resolve("armed"), stage);
        }
        void reached() throws Exception { awaitFile(directory.resolve("reached"), process); }
        void resume() throws Exception { Files.writeString(directory.resolve("resume"), "continue"); }
        void assertWorker() {
            var workers = process.descendants().filter(child -> child.info().command().orElse("").contains("node")).toList();
            assertThat(workers).hasSize(1);
            System.out.println("W1_WORKER_PID broker=" + process.pid() + " worker=" + workers.getFirst().pid());
        }
        void sendCommand(String action, long revision, String operation) throws Exception {
            Files.deleteIfExists(directory.resolve("result.json"));
            commands.println(JSON.writeValueAsString(Map.of("action", action, "revision", revision, "operation", operation)));
        }
        void command(String action, long revision, String operation, boolean success) throws Exception {
            sendCommand(action, revision, operation);
            commandResult(success);
        }
        void commandResult(boolean success) throws Exception {
            awaitFile(directory.resolve("result.json"), process);
            JsonNode result = JSON.readTree(directory.resolve("result.json").toFile());
            assertThat(result.get("ok").asBoolean()).as("%s", result).isEqualTo(success);
            if (!success) assertThat(result.get("code").asText()).isEqualTo("workspace_unavailable");
        }
        @Override public void close() throws Exception {
            var workers = process.descendants().toList();
            commands.close();
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
            for (var worker : workers) {
                if (worker.isAlive()) {
                    worker.destroyForcibly();
                    worker.onExit().get(5, TimeUnit.SECONDS);
                }
            }
            http.close();
            System.out.println(Files.readString(directory.resolve("broker.log")));
        }
    }

    public static final class BrokerMain {
        public static void main(String[] arguments) throws Exception {
            Path directory = Path.of(arguments[0]);
            JsonNode config = JSON.readTree(directory.resolve("config.json").toFile());
            var source = new DriverManagerDataSource(config.get("url").asText(), config.get("user").asText(),
                    config.get("password").asText());
            String tenant = config.get("tenant").asText();
            var properties = properties(tenant, Path.of(config.get("root").asText()), directory.resolve("state"));
            var guard = guard(source, properties);
            var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
            var sessions = new JdbcRuntimeSessionRepository(source);
            var executions = new JdbcToolExecutionRepository(source);
            var authority = new WorkspaceExecutionStore(new JdbcTemplate(source), new DataSourceTransactionManager(source), guard) {
                private void pause(String stage) {
                    try {
                        Path armed = directory.resolve("armed");
                        if (!Files.exists(armed) || !Files.readString(armed).equals(stage)) return;
                        Files.delete(armed);
                        Files.writeString(directory.resolve("reached"), stage);
                        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
                        while (!Files.exists(directory.resolve("resume"))) {
                            if (System.nanoTime() > deadline) throw new IllegalStateException("Barrier timeout " + stage);
                            Thread.sleep(10);
                        }
                    } catch (Exception error) { throw new IllegalStateException(error); }
                }
                @Override public void claim(ContextBinding binding, RuntimeSessionRecord session) {
                    pause("before-claim");
                    super.claim(binding, session);
                    pause("after-claim");
                }
                @Override public void assertHeld(ContextBinding binding, RuntimeSessionRecord session) {
                    pause("before-dispatch");
                    super.assertHeld(binding, session);
                }
                @Override public void release(ContextBinding binding, RuntimeSessionRecord session) {
                    super.release(binding, session);
                    pause("after-release");
                    super.release(binding, session);
                }
                @Override public void releaseLost(RuntimeBindingRecord binding) {
                    super.releaseLost(binding);
                    pause("after-lost-release");
                    super.releaseLost(binding);
                }
            };
            try (var broker = new EmbeddedRuntimeBroker(store(source, properties), properties, bindings, sessions,
                    executions, authority); var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
                publish(directory.resolve("ready.json"), Map.of("uri", broker.getBaseUri().toString()));
                String line;
                while ((line = input.readLine()) != null) {
                    JsonNode command = JSON.readTree(line);
                    Map<String, Object> result;
                    try {
                        long revision = command.get("revision").asLong();
                        String operation = command.get("operation").asText();
                        switch (command.get("action").asText()) {
                            case "fence" -> guard.fence(tenant, "storage", revision, operation);
                            case "restore" -> guard.restoreOriginal(tenant, "storage", revision, operation);
                            case "lost-cleanup" -> {
                                var rows = new JdbcTemplate(source).queryForList("SELECT binding_id FROM qwen_runtime_session"
                                        + " WHERE runtime_session_id = ?", String.class, operation);
                                assertThat(rows).hasSize(1);
                                var saved = bindings.findById(rows.getFirst());
                                String resource = saved.getResourceHandle().getValue().get("resourceId").toString();
                                long pid = JSON.readTree(directory.resolve("state/" + resource + ".json").toFile()).get("pid").asLong();
                                var worker = ProcessHandle.of(pid).orElseThrow();
                                worker.destroyForcibly();
                                worker.onExit().get(5, TimeUnit.SECONDS);
                                try (var local = LocalProcessRuntimeProvisioner.durable(List.of("must-not-start"),
                                        directory.resolve("state"), new HttpRuntimeTransport(), false)) {
                                    var proof = local.attestOperatorStop(saved, UUID.randomUUID().toString());
                                    var claimed = bindings.claimOperation(saved.getBindingId(), "w1-recovery", Duration.ofMinutes(2));
                                    assertThat(claimed).isNotNull();
                                    var lost = bindings.compareAndSet(claimed, claimed.withRecoveryEvidence(
                                            proof.getLossEvidence(), proof.getStopEvidence(), Instant.now()));
                                    lost = bindings.recoverLost(sessions, executions, lost);
                                    assertThat(lost.getState()).isEqualTo(RuntimeBindingRecord.State.LOST);
                                    authority.releaseLost(lost);
                                    assertThat(bindings.finishLostRecovery(sessions, executions, lost).getState())
                                            .isEqualTo(RuntimeBindingRecord.State.RELEASED);
                                    bindings.releaseOperation(lost.getBindingId(), "w1-recovery", lost.getOperationGeneration());
                                }
                            }
                            default -> throw new IllegalArgumentException("Unknown fixture command");
                        }
                        result = Map.of("ok", true);
                    } catch (RuntimeBrokerException error) { result = Map.of("ok", false, "code", error.getCode()); }
                    publish(directory.resolve("result.json"), result);
                }
            }
        }

        private static void publish(Path path, Map<String, Object> value) throws Exception {
            Path pending = path.resolveSibling(path.getFileName() + ".pending");
            JSON.writeValue(pending.toFile(), value);
            Files.move(pending, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
