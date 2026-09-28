package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

class HostedWorkspaceToolTurnIT {
    @TempDir
    private Path temporary;

    @Test
    @Timeout(180)
    void packagedHarnessUsesSavedWorkspacesThroughRealBrokerWorkerAndSqlStore() throws Exception {
        runDriver(List.of("alpha", "beta"), false);
    }

    @Test
    @Timeout(180)
    void lostBrokerRepliesNeverReplayEffectsOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).as("FG6a requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user")).as("FG6a requires -Dmysql.user").isNotBlank();
        String selected = System.getProperty("qwen.fg6a.case");
        List<String> cases = List.of("acquire", "prepare", "prepare-twice", "start", "status", "cancel",
                "release", "release-before-forward");
        if (selected != null) {
            assertThat(cases).contains(selected);
            cases = List.of(selected);
        }
        runDriver(cases, true);
    }

    private void runDriver(List<String> cases, boolean faults) throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        Files.createDirectory(temporary.resolve("runtime"));
        Path root = cli.getParent().getParent();
        String tenant = "hosted-tools-" + UUID.randomUUID();
        List<Path> workspaces = new ArrayList<>();
        for (String name : cases) workspaces.add(Files.createDirectory(temporary.resolve(name)));
        boolean mysql = System.getProperty("mysql.url") != null;
        var arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + System.getProperty("mysql.url",
                        "jdbc:h2:mem:hosted-tools;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"),
                "--spring.datasource.driver-class-name=" + (mysql ? "com.mysql.cj.jdbc.Driver" : "org.h2.Driver"),
                "--spring.datasource.username=" + System.getProperty("mysql.user", "sa"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.harness.capability-digest=sha256:" + "a".repeat(64),
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.token=hosted-tools-broker-token",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + temporary,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        for (int index = 0; index < workspaces.size(); index++) {
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts[" + index + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + index);
            arguments.add(prefix + "root=" + workspaces.get(index));
            Files.createDirectory(workspaces.get(index).resolve("child"));
        }
        try (var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(arguments.toArray(String[]::new))) {
            JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
            if (faults) {
                var metadata = jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine");
                System.out.println("FG6A_DATABASE " + metadata);
                assertThat(metadata.toString().toLowerCase()).containsAnyOf("mysql", "mariadb");
            }
            ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
            var sessions = new ArrayList<Map<String, Object>>();
            for (int index = 0; index < workspaces.size(); index++) {
                String workspaceId = "workspace-" + index;
                jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, ?, 1, ?,"
                        + " 'Workspace', ?, ?, 'ACTIVE')", tenant, workspaceId, "storage-" + index,
                        WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
                jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)", tenant, workspaceId, "actor".getBytes(StandardCharsets.UTF_8));
                var created = store.insertWorkspaceSessionCommand(tenant, "actor", "create-" + index,
                        "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection(workspaceId, "child"));
                sessions.add(Map.of("sessionId", created.sessionId(), "workspaceId", workspaceId,
                        "directory", workspaces.get(index).resolve("child").toString(), "fault", cases.get(index)));
                if (faults) Files.writeString(workspaces.get(index).resolve("child/proof.txt"), "x");
            }
            Path config = temporary.resolve("driver.json");
            EmbeddedRuntimeBroker broker = spring.getBean(EmbeddedRuntimeBroker.class);
            CompletableFuture<Void> statusGate = new CompletableFuture<>();
            HttpServer gateServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            gateServer.createContext("/release", exchange -> {
                statusGate.complete(null);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            });
            if (faults && cases.contains("status")) {
                String statusSession = sessions.get(cases.indexOf("status")).get("sessionId").toString();
                Object service = ReflectionTestUtils.getField(broker, "service");
                RuntimeTransport transport = (RuntimeTransport) ReflectionTestUtils.getField(service, "transport");
                RuntimeTransport gated = (RuntimeTransport) Proxy.newProxyInstance(RuntimeTransport.class.getClassLoader(),
                        new Class<?>[] {RuntimeTransport.class}, (proxy, method, args) -> {
                            Object result = method.invoke(transport, args);
                            if (method.getName().equals("execute")
                                    && ((RuntimeSession) args[1]).getHarnessSessionId().equals(statusSession)) {
                                return ((CompletionStage<?>) result).thenCombine(statusGate, (value, ignored) -> value);
                            }
                            return result;
                        });
                ReflectionTestUtils.setField(service, "transport", gated);
            }
            gateServer.start();
            try {
                new ObjectMapper().writeValue(config.toFile(), Map.of("tenantId", tenant, "sessions", sessions,
                        "storeUrl", "http://127.0.0.1:" + spring.getWebServer().getPort(),
                        "brokerUrl", broker.getBaseUri().toString(),
                        "statusGateUrl", "http://127.0.0.1:" + gateServer.getAddress().getPort() + "/release"));
                Path log = temporary.resolve("driver.log");
                Process driver = new ProcessBuilder(node, "--import", "tsx",
                        "integration-tests/helpers/hosted-" + (faults ? "broker-reply-loss" : "workspace-tool-turn")
                                + "-driver.ts", config.toString())
                        .directory(root.toFile()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
                try {
                    assertThat(driver.waitFor(130, TimeUnit.SECONDS)).as("Driver timeout: %s", Files.readString(log)).isTrue();
                    assertThat(driver.exitValue()).as("Driver output: %s", Files.readString(log)).isZero();
                    System.out.println(Files.readString(log));
                    assertThat(Files.readString(log)).contains(faults ? "HOSTED_REPLY_LOSS_OK" : "HOSTED_WORKSPACE_TOOLS_OK");
                    JsonNode reports = faults ? new ObjectMapper().readTree(
                            Files.readString(temporary.resolve("driver.json.results"))) : null;
                    if (faults && cases.contains("status")) assertThat(statusGate.isDone()).isTrue();
                    for (int index = 0; index < workspaces.size(); index++) {
                        Path workspace = workspaces.get(index);
                        if (faults) assertFaultLedger(jdbc, tenant, sessions.get(index), index, reports.get(index));
                        else assertThat(Files.readString(workspace.resolve("child/proof.txt"))).isEqualTo("after");
                        assertThat(workspace.resolve("proof.txt")).doesNotExist();
                    }
                } finally {
                    driver.descendants().forEach(process -> process.destroyForcibly());
                    if (driver.isAlive()) driver.destroyForcibly();
                }
            } finally {
                statusGate.complete(null);
                gateServer.stop(0);
            }
        }
    }

    private void assertFaultLedger(JdbcTemplate jdbc, String tenant, Map<String, Object> session, int index,
            JsonNode report) throws Exception {
        String fault = session.get("fault").toString();
        boolean started = !List.of("acquire", "prepare-twice", "cancel").contains(fault);
        assertThat(Files.readString(Path.of(session.get("directory").toString()).resolve("proof.txt")))
                .as(fault + " physical effect").isEqualTo(started ? "xx" : "x");
        List<Map<String, Object>> executions = jdbc.queryForList("SELECT execution_call_id, idempotency_key,"
                + " runtime_session_id, dispatch_generation, execution_state, execution_status"
                + " FROM qwen_tool_execution WHERE harness_session_id = ?", session.get("sessionId"));
        assertThat(executions).as(fault + " reservations").hasSize(fault.equals("acquire") ? 0 : 1);
        for (Map<String, Object> execution : executions) {
            assertThat(execution.get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
            assertThat(execution.get("idempotency_key")).isEqualTo(report.path("idempotencyKey").asText());
            assertThat(execution.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
            assertThat(((Number) execution.get("dispatch_generation")).longValue()).isEqualTo(started ? 1 : 0);
            assertThat(execution.get("execution_state")).isEqualTo(fault.equals("prepare-twice") ? "PREPARED" : "SETTLED");
            if (started) assertThat(execution.get("execution_status")).isEqualTo("success");
        }
        String storageKey = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((tenant + "\u0000storage-" + index).getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> owner = jdbc.queryForMap("SELECT holder_key, runtime_session_id"
                + " FROM managed_workspace_execution_lease WHERE storage_key = ?", storageKey);
        boolean released = List.of("prepare", "start", "release").contains(fault);
        if (released) assertThat(owner.get("holder_key")).as(fault + " released owner").isNull();
        else {
            assertThat(owner.get("holder_key")).as(fault + " retained owner").isNotNull();
            assertThat(owner.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
        }
        assertThat(jdbc.queryForObject("SELECT session_state FROM qwen_runtime_session WHERE harness_session_id = ?"
                + " AND runtime_session_id = ?", String.class, session.get("sessionId"), report.path("promptId").asText()))
                .isEqualTo(released ? "RELEASED" : "READY");
    }
}
