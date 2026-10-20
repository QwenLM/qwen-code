package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.workspace.ChildResultRelay;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.workspace.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

// FG10 (issue #14165): multi-process fault gates for the child_run
// workflow kind #13858 enabled without a fault round. FG10a gates the
// launch envelope's digest integrity — a tampered script is refused by the
// child Turn's re-verification before any model spend, and fractional
// launch args cross the daemon/SDK admission digest byte-identically.
// Real packaged Harness, real MySQL, JDBC ground truth. The other letters,
// FG10d's process crash among them, assert the record's relay-driven
// settlement, which this driver-held parent cannot run; they live on the
// coordinator-owned lead in HostedWorkflowRelayFaultGatesIT.
class HostedWorkflowFaultGatesIT {
    private final ObjectMapper json = new ObjectMapper();

    @TempDir
    private Path temporary;

    private ServletWebServerApplicationContext spring;
    private HttpServer gateServer;

    @AfterEach
    void tearDown() {
        try {
            if (spring != null) {
                spring.close();
                spring = null;
            }
        } finally {
            // The gate server's dispatcher thread and loopback socket must
            // not survive a Spring close that throws — a kill case leaves
            // the relay mid-walk, so a throwing close is not exotic here.
            if (gateServer != null) {
                gateServer.stop(0);
                gateServer = null;
            }
        }
    }

    @Test
    @Timeout(600)
    void fg10aDigestIntegrityHoldsAcrossTamperAndFractionalArgsOnMySql()
            throws Exception {
        runLetter("fg10a", List.of("tampered-script-refused",
                "same-length-substitution-refused",
                "fractional-args-admitted",
                "substitute-script-baseline"));
    }

    private void runLetter(String letter, List<String> allCases)
            throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG10 requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user"))
                .as("FG10 requires -Dmysql.user").isNotBlank();
        assertThat(System.getProperty("node.executable"))
                .as("Pass -Dnode.executable").isNotBlank();
        String selected = System.getProperty("qwen." + letter + ".case");
        List<String> cases = allCases;
        if (selected != null) {
            assertThat(cases).contains(selected);
            cases = List.of(selected);
        }
        temporary = temporary.toRealPath();
        Path casesRoot = Path.of(System.getProperty("user.dir"), "target",
                "fg10-cases", letter);
        deleteRecursively(casesRoot);
        Files.createDirectories(casesRoot);
        String tenant = "hosted-workflow-" + UUID.randomUUID();
        Path cli = cliEntry();
        String node = System.getProperty("node.executable");
        Files.createDirectory(temporary.resolve("runtime"));
        // The publication service base-url must name the public connector
        // before boot — and so must the two loopback peers the driver
        // owns: the store proxy (the server-side session-store.base-url,
        // so the relay-created child Session's store traffic crosses it)
        // and the packaged Harness (harness.base-url). All three ports are
        // pinned before Spring boots.
        int port = freePort();
        int storeProxyPort = freePort();
        int harnessPort = freePort();

        var arguments = new ArrayList<>(List.of("--server.address=127.0.0.1",
                "--server.port=" + port,
                "--spring.datasource.url=" + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username="
                        + System.getProperty("mysql.user"),
                "--spring.datasource.password="
                        + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:"
                        + storeProxyPort,
                "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.harness.base-url=http://127.0.0.1:"
                        + harnessPort,
                "--qwen.managed-agent.harness.token=hosted-process-fixture-token",
                "--qwen.managed-agent.harness.capability-digest=sha256:"
                        + "a".repeat(64),
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.token=hosted-tools-broker-token",
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled="
                        + "Linux".equals(System.getProperty("os.name")),
                "--qwen.managed-agent.runtime-broker.workspace-cwd="
                        + temporary,
                "--qwen.managed-agent.runtime-broker.state-directory="
                        + temporary.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli));
        if (letter.equals("fg10a")) {
            // The tamper must land before the relay's first read of the
            // envelope: hold the scheduled scan out of the letter entirely
            // and let the probe drive the walk after the rewrite.
            arguments.add(
                    "--qwen.managed-agent.child-relay.scan-delay=3600s");
        }
        List<Path> workspaces = new ArrayList<>();
        for (int index = 0; index < cases.size(); index++) {
            // Per-case evidence lives under target/fg10-cases/ — the CI
            // artifact carries it (the FG7 lesson: evidence in @TempDir
            // evaporates before anyone can diagnose a lane failure).
            Path workspace = Files.createDirectory(
                    casesRoot.resolve(cases.get(index)));
            workspaces.add(workspace);
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts["
                    + index + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + index);
            arguments.add(prefix + "root=" + workspace);
            Files.createDirectory(workspace.resolve("child"));
            // The storage guard's fail-closed identity check refuses a
            // mount root whose mtime still equals its birth time.
            Files.setLastModifiedTime(workspace, FileTime.fromMillis(1));
        }
        var application = new SpringApplicationBuilder(
                ManagedAgentServerApplication.class);
        spring = (ServletWebServerApplicationContext) application.run(
                arguments.toArray(String[]::new));
        JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
        ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
        EmbeddedRuntimeBroker broker = spring.getBean(
                EmbeddedRuntimeBroker.class);
        if ("Linux".equals(System.getProperty("os.name"))) {
            var guard = spring.getBean(
                    com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard.class);
            for (int index = 0; index < cases.size(); index++) {
                guard.register(tenant, "storage-" + index,
                        UUID.randomUUID().toString());
            }
        }
        var sessions = new ArrayList<Map<String, Object>>();
        for (int index = 0; index < cases.size(); index++) {
            String workspaceId = "workspace-" + index;
            jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                    + " workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state) VALUES"
                    + " (?, ?, 1, ?, 'Workspace', ?, ?, 'ACTIVE')", tenant,
                    workspaceId, "storage-" + index,
                    WorkspaceExecutionProfile.CONFIG_REF,
                    WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                    + " workspace_id, actor_id, role) VALUES (?, ?, ?,"
                    + " 'OPERATOR')", tenant, workspaceId,
                    "actor".getBytes(StandardCharsets.UTF_8));
            var created = store.insertWorkspaceSessionCommand(tenant, "actor",
                    "create-" + index, "sha256:" + "a".repeat(64),
                    "qwen-code", null, null, List.of(), null,
                    new WorkspaceSelection(workspaceId, "child"));
            sessions.add(Map.of("name", cases.get(index), "sessionId",
                    created.sessionId(), "workspaceId", workspaceId,
                    "directory",
                    workspaces.get(index).resolve("child").toString()));
        }
        gateServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0),
                0);
        HostedWorkflowProbe probe = new HostedWorkflowProbe(jdbc, tenant,
                spring.getBean(ChildResultRelay.class), gateServer);
        gateServer.start();
        try (probe) {
            Path config = temporary.resolve("driver.json");
            Path resultFile = temporary.resolve("results.json");
            Map<String, Object> driverConfig = new LinkedHashMap<>();
            driverConfig.put("letter", letter);
            driverConfig.put("tenantId", tenant);
            driverConfig.put("storeUrl", "http://127.0.0.1:"
                    + spring.getWebServer().getPort());
            driverConfig.put("brokerUrl", broker.getBaseUri().toString());
            driverConfig.put("statusGateUrl", "http://127.0.0.1:"
                    + gateServer.getAddress().getPort());
            driverConfig.put("storeProxyPort", storeProxyPort);
            driverConfig.put("harnessPort", harnessPort);
            driverConfig.put("cases", sessions);
            driverConfig.put("resultFile", resultFile.toString());
            json.writeValue(config.toFile(), driverConfig);
            Path log = casesRoot.resolve("driver.log");
            Process driver = new ProcessBuilder(node, "--import", "tsx",
                    "integration-tests/helpers/hosted-workflow-fault-driver.ts",
                    config.toString()).directory(repoRoot().toFile())
                    .redirectErrorStream(true).redirectOutput(log.toFile())
                    .start();
            try {
                boolean finished = driver.waitFor(480, TimeUnit.SECONDS);
                String output = Files.exists(log) ? Files.readString(log) : "";
                if (!finished) {
                    driver.destroyForcibly();
                }
                assertThat(finished)
                        .as(letter + " driver timed out:\n%s", output)
                        .isTrue();
                assertThat(driver.exitValue())
                        .as(letter + " driver output:\n%s", output).isZero();
                assertThat(output).contains("FG10_DIGEST_GATE_OK");
                JsonNode reports = json.readTree(
                        Files.readString(resultFile));
                assertThat(reports).hasSize(cases.size());
                for (int index = 0; index < cases.size(); index++) {
                    assertCase(letter, jdbc, tenant, sessions.get(index),
                            reports.get(index));
                }
            } finally {
                driver.descendants()
                        .forEach(process -> process.destroyForcibly());
                if (driver.isAlive()) {
                    driver.destroyForcibly();
                }
            }
        }
    }

    private void assertCase(String letter, JdbcTemplate jdbc, String tenant,
            Map<String, Object> session, JsonNode report) throws Exception {
        String sessionId = session.get("sessionId").toString();
        String name = session.get("name").toString();
        assertThat(report.path("case").asText()).isEqualTo(name);
        JsonNode record = HostedGateTestSupport.extensionRecord(jdbc,
                tenant, sessionId, "child_run");
        // The workflow kind's identity: the record names the kind, and the
        // pin is the launch's own digest — computed over the script the
        // driver authored, never re-resolved from anywhere later.
        assertThat(record.path("kind").asText())
                .as(name + " record kind").isEqualTo("workflow");
        assertThat(record.path("run").path("definition")
                .path("definitionDigest").asText())
                .as(name + " pinned digest intact")
                .isEqualTo(report.path("scriptSha256").asText())
                .isEqualTo(report.path("recordDigest").asText());
        switch (name) {
            case "tampered-script-refused",
                    "same-length-substitution-refused" -> {
                // The tampered copy was refused before any child spend:
                // the child Turn failed on the digest mismatch, the child
                // made no model call, the refusal named the two digests,
                // and the record never settled a false success.
                assertThat(report.path("childTurnStatus").asText())
                        .as(name + " child Turn failed on the mismatch")
                        .isEqualTo("FAILED");
                assertThat(report.path("childModelCalls").asInt())
                        .as(name + " the child spent no model call")
                        .isZero();
                assertThat(report.path("refusalNamed").asBoolean())
                        .as(name + " the refusal names the digest mismatch")
                        .isTrue();
                assertThat(record.path("run").path("state").asText())
                        .as(name + " never settled a false success")
                        .isNotEqualTo("settled");
                JsonNode tamper = report.path("tamperProof");
                assertThat(tamper.path("shaBefore").asText())
                        .as(name + " the tamper changed the stored bytes")
                        .isNotEqualTo(tamper.path("shaAfter").asText());
            }
            case "fractional-args-admitted" -> {
                // The fractional-args launch crossed the daemon/SDK
                // admission digest byte-identically: the child Turn
                // completed, never wedging on invalid_hosted_prompt — and
                // the values provably reached the execution end: the
                // Turn's final content echoes them. The wire rendering
                // varies by hop (the store renders the subnormal
                // 4.9E-324, the sandbox echoes 5e-324, keys arrive
                // sorted), so the driver parses the echo and compares
                // values exactly; here the raw output must carry the
                // echo and each value's exact ECMAScript rendering.
                assertThat(report.path("childTurnStatus").asText())
                        .as(name + " child Turn completed")
                        .isEqualTo("COMPLETED");
                assertThat(report.path("invalidHostedPromptSeen")
                        .asBoolean())
                        .as(name + " never wedged on invalid_hosted_prompt")
                        .isFalse();
                assertThat(report.path("turnOutput").asText())
                        .as(name + " the fractional args echoed back with"
                                + " exact values")
                        .contains("FG10_ARGS_ECHO")
                        .contains("\\\"temperature\\\":0.1")
                        .contains("\\\"tiny\\\":5e-324")
                        .contains("\\\"label\\\":\\\"fg10\\\"");
            }
            case "substitute-script-baseline" -> {
                // The script the substitution tamper injects is a
                // syntactically valid, runnable workflow: launched
                // honestly it completes and returns its own sentinel.
                // This is what makes the substitution case's refusal
                // attributable to the digest mismatch alone.
                assertThat(report.path("childTurnStatus").asText())
                        .as(name + " child Turn completed")
                        .isEqualTo("COMPLETED");
                assertThat(report.path("turnOutput").asText())
                        .as(name + " the substitute script really ran")
                        .contains("FG10_SUBSTITUTED_OKAY");
            }
            default -> throw new IllegalArgumentException(name);
        }
    }

    private static void deleteRecursively(Path root) throws java.io.IOException {
        if (!Files.exists(root)) {
            return;
        }
        for (Path entry : Files.walk(root)
                .sorted((left, right) -> right.getNameCount()
                        - left.getNameCount())
                .toList()) {
            Files.delete(entry);
        }
    }

    private static Path cliEntry() {
        Path cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).as("Build and bundle the packaged CLI first")
                .isRegularFile();
        return cli;
    }

    private static int freePort() throws java.io.IOException {
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0, 0,
                java.net.InetAddress.getLoopbackAddress())) {
            return socket.getLocalPort();
        }
    }

    private static Path repoRoot() {
        return cliEntry().getParent().getParent();
    }
}
