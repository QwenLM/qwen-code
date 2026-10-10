package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.WorkspaceRecoveryCommand;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

/** Real maintenance CLI, real worker and SQL; only the model is deterministic. */
final class HostedOperatorRecoveryProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ServletWebServerApplicationContext spring;
    private final JdbcTemplate jdbc;
    private final List<Map<String, Object>> sessions;
    private final Path state;
    private final RuntimeBrokerService broker;
    private final Object local;
    private final Set<ProcessHandle> processes = new LinkedHashSet<>();
    private final Map<String, ProcessHandle> escapedProcesses = new HashMap<>();
    private final Map<String, String> recoveries = new HashMap<>();

    HostedOperatorRecoveryProbe(ServletWebServerApplicationContext spring, List<Map<String, Object>> sessions,
            Path state, HttpServer server) {
        this.spring = spring;
        this.jdbc = spring.getBean(JdbcTemplate.class);
        this.sessions = sessions;
        this.state = state;
        broker = (RuntimeBrokerService) ReflectionTestUtils.getField(spring.getBean(EmbeddedRuntimeBroker.class), "service");
        Object provisioner = ReflectionTestUtils.getField(broker, "provisioner");
        local = ReflectionTestUtils.getField(provisioner, "delegate");
        server.createContext("/operator-recovery/", exchange -> {
            try {
                assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                String[] route = exchange.getRequestURI().getPath().split("/");
                assertThat(route).hasSize(4);
                var session = sessions.stream().filter(value -> value.get("sessionId").equals(route[2]))
                        .findFirst().orElseThrow();
                byte[] result = JSON.writeValueAsBytes(check(session, route[3]));
                exchange.sendResponseHeaders(200, result.length);
                exchange.getResponseBody().write(result);
            } catch (Throwable error) {
                byte[] result = error.toString().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, result.length);
                exchange.getResponseBody().write(result);
            } finally {
                exchange.close();
            }
        });
    }

    private Map<String, Object> check(Map<String, Object> session, String phase) throws Exception {
        String id = session.get("sessionId").toString();
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_execution WHERE harness_session_id = ?", id);
        assertThat(rows).hasSize(1);
        var execution = rows.getFirst();
        String binding = execution.get("binding_id").toString();
        String generation = execution.get("runtime_generation").toString();
        assertThat(execution.get("dispatch_generation")).isEqualTo(1L);
        if (phase.equals("prepare")) {
            assertBusy(session);
            String inspection = command("inspect", binding, generation);
            var view = JSON.readTree(inspection.lines().filter(line -> line.startsWith("{")).findFirst().orElseThrow());
            assertThat(view.path("captureStatus").asText()).isEqualTo("partial");
            assertThat(view.path("captureReason").asText()).isEqualTo("producer_lost");
            String holder = view.path("holderKey").asText();
            assertThat(holder).isNotBlank();
            String prepared = command("prepare", binding, generation, holder, "#12904 physical acceptance");
            String recovery = prepared.lines().filter(line -> line.matches("[0-9a-f-]{36}")).findFirst().orElseThrow();
            assertThat(recoveries.putIfAbsent(id, recovery)).isNull();
            ProcessHandle worker = worker(binding);
            processes.addAll(worker.descendants().toList());
            processes.add(worker);
            ProcessHandle escaped = escaped(session);
            if ("detached".equals(session.get("fault"))) {
                assertThat(escaped).as("detached fixture must start a real escaped writer").isNotNull();
            }
            worker.destroyForcibly();
            worker.onExit().get(10, TimeUnit.SECONDS);
            assertHeld(binding, holder);
            if (escaped != null) {
                Path proof = Path.of(session.get("directory").toString(), "escaped.txt");
                long before = Files.size(proof);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                while (Files.size(proof) == before && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                }
                assertThat(running(escaped)).isTrue();
                assertThat(Files.size(proof)).as("escaped writer survives worker death").isGreaterThan(before);
                assertHeld(binding, holder);
            }
            return Map.of("bindingId", binding, "holderKey", holder, "recoveryId", recovery,
                    "state", "fenced", "escapedWriterLive", escaped != null);
        }
        assertThat(phase).isEqualTo("complete");
        String recovery = recoveries.get(id);
        assertThat(recovery).isNotNull();
        stopOwnedProcesses();
        Path evidence = state.resolve(recovery + ".json");
        Files.writeString(evidence, JSON.writeValueAsString(Map.of("version", 1, "recoveryId", recovery,
                "verifiedAt", Instant.now().toString(), "method", "isolated test process inventory",
                "actions", "Stopped the owned worker, Shell descendants and escaped writer; no external restart source exists",
                "restartPrevention", true)));
        Files.setPosixFilePermissions(evidence, PosixFilePermissions.fromString("rw-------"));
        assertThat(command("complete", recovery, evidence.toString())).contains("completed");
        assertThat(command("complete", recovery, evidence.toString())).contains("completed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease WHERE binding_id = ?",
                Integer.class, binding)).isZero();
        assertThat(jdbc.queryForObject("SELECT binding_state FROM qwen_runtime_binding WHERE binding_id = ?",
                String.class, binding)).isEqualTo("RELEASED");
        var next = broker.acquire(session.get("secondarySessionId").toString(), UUID.randomUUID().toString(), "bootstrap")
                .toCompletableFuture().get(30, TimeUnit.SECONDS);
        assertThat(next.getBindingId()).isNotEqualTo(binding);
        assertThat(broker.release(next.getSession().getHarnessSessionId(), next.getRuntimeSessionId())
                .toCompletableFuture().get(30, TimeUnit.SECONDS)).isTrue();
        return Map.of("bindingId", binding, "recoveryId", recovery, "state", "completed",
                "replacementBindingId", next.getBindingId());
    }

    private void assertBusy(Map<String, Object> session) throws Exception {
        try {
            broker.acquire(session.get("secondarySessionId").toString(), UUID.randomUUID().toString(), "bootstrap")
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            throw new AssertionError("A second Session entered the uncertain Workspace");
        } catch (java.util.concurrent.ExecutionException error) {
            Throwable cause = error.getCause();
            while (cause.getCause() != null && !(cause instanceof RuntimeBrokerException)) {
                cause = cause.getCause();
            }
            assertThat(cause).isInstanceOf(RuntimeBrokerException.class);
            assertThat(((RuntimeBrokerException) cause).getCode()).isEqualTo("workspace_busy");
        }
    }

    private void assertHeld(String binding, String holder) {
        assertThat(jdbc.queryForObject("SELECT holder_key FROM managed_workspace_execution_lease WHERE binding_id = ?",
                String.class, binding)).isEqualTo(holder);
    }

    private ProcessHandle worker(String binding) {
        var owned = (Map<?, ?>) ReflectionTestUtils.getField(local, "owned");
        Object match = owned.values().stream().filter(value -> binding.equals(
                ((RuntimeProvisionSeed) ReflectionTestUtils.getField(value, "seed")).getProvisionalRuntimeId()))
                .findFirst().orElseThrow();
        var process = registeredProcess(match);
        assertThat(process).as("original durable worker with matching process identity").isNotNull();
        return process;
    }

    private ProcessHandle registeredProcess(Object owned) {
        Object registration = ReflectionTestUtils.getField(owned, "registration");
        return ReflectionTestUtils.invokeMethod(registration, "process");
    }

    private ProcessHandle escaped(Map<String, Object> session) throws Exception {
        String id = session.get("sessionId").toString();
        if (escapedProcesses.containsKey(id)) {
            return escapedProcesses.get(id);
        }
        Path directory = Path.of(session.get("directory").toString());
        Path identity = directory.resolve("escaped.pid");
        if (!Files.exists(identity)) {
            return null;
        }
        var process = ProcessHandle.of(Long.parseLong(Files.readString(identity).strip())).orElse(null);
        if (process == null || !running(process)) {
            return null;
        }
        assertThat(Files.readSymbolicLink(Path.of("/proc", Long.toString(process.pid()), "cwd"))).isEqualTo(directory);
        processes.add(process);
        escapedProcesses.put(id, process);
        return process;
    }

    private String command(String... arguments) throws Exception {
        var command = new ArrayList<String>();
        command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        for (String name : List.of("spring.datasource.url", "spring.datasource.driver-class-name",
                "spring.datasource.username", "spring.datasource.password",
                "qwen.managed-agent.runtime-broker.credential-key-id", "qwen.managed-agent.runtime-broker.credential-key")) {
            command.add("-D" + name + "=" + spring.getEnvironment().getProperty(name));
        }
        command.add("-Dqwen.managed-agent.runtime-broker.state-directory=" + state);
        command.add("-Dqwen.managed-agent.runtime-broker.durable-local-process=true");
        command.add("-Dqwen.managed-agent.runtime-broker.operator-recovery-enabled=true");
        command.add("-Dqwen.managed-agent.runtime-broker.provisioner=local-process");
        command.add("-cp");
        command.add(System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")));
        command.add(WorkspaceRecoveryCommand.class.getName());
        command.addAll(List.of(arguments));
        Path log = state.resolve("maintenance-" + UUID.randomUUID() + ".log");
        Process maintenance = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {
            assertThat(maintenance.waitFor(45, TimeUnit.SECONDS)).as("Maintenance timeout: %s", Files.readString(log)).isTrue();
            assertThat(maintenance.exitValue()).as("Maintenance output: %s", Files.readString(log)).isZero();
            return Files.readString(log);
        } finally {
            if (maintenance.isAlive()) {
                maintenance.destroyForcibly();
            }
        }
    }

    private static boolean running(ProcessHandle process) throws Exception {
        if (!process.isAlive()) {
            return false;
        }
        Path stat = Path.of("/proc", Long.toString(process.pid()), "stat");
        if (!Files.exists(stat)) {
            return false;
        }
        try {
            String value = Files.readString(stat);
            return value.charAt(value.lastIndexOf(')') + 2) != 'Z';
        } catch (NoSuchFileException exited) {
            return false;
        }
    }

    private void stopOwnedProcesses() throws Exception {
        processes.forEach(ProcessHandle::destroyForcibly);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        for (ProcessHandle process : processes) {
            while (running(process)) {
                assertThat(System.nanoTime()).as("Owned producer %s", process.pid()).isLessThan(deadline);
                Thread.sleep(20);
            }
        }
    }

    @Override
    public void close() throws Exception {
        for (var session : sessions) {
            escaped(session);
        }
        var owned = (Map<?, ?>) ReflectionTestUtils.getField(local, "owned");
        for (var value : owned.values()) {
            ProcessHandle process = registeredProcess(value);
            if (process == null) {
                continue;
            }
            processes.addAll(process.descendants().toList());
            processes.add(process);
        }
        stopOwnedProcesses();
    }
}
