package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

class HostedWorkspaceToolTurnIT {
    @TempDir
    private Path temporary;

    @Test
    @Timeout(360)
    void packagedHarnessUsesSavedWorkspacesThroughRealBrokerWorkerAndSqlStore() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        Files.createDirectory(temporary.resolve("runtime"));
        Path root = cli.getParent().getParent();
        String tenant = "hosted-tools-" + UUID.randomUUID();
        List<Path> workspaces = List.of(Files.createDirectory(temporary.resolve("alpha")),
                Files.createDirectory(temporary.resolve("beta")),
                Files.createDirectory(temporary.resolve("shell")),
                Files.createDirectory(temporary.resolve("storage-failure")),
                Files.createDirectory(temporary.resolve("raw-reply-loss")),
                Files.createDirectory(temporary.resolve("cancel")));
        var arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=jdbc:h2:mem:hosted-tools;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
                "--spring.datasource.driver-class-name=org.h2.Driver", "--spring.datasource.username=sa",
                "--spring.datasource.password=", "--qwen.managed-agent.session-store.enabled=true",
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
                        "toolProfile", index < 2 ? "hosted-workspace-files/1" : "hosted-workspace-shell/1",
                        "directory", workspaces.get(index).resolve("child").toString()));
            }
            Path config = temporary.resolve("driver.json");
            Path resultFile = temporary.resolve("shell-output.json");
            new ObjectMapper().writeValue(config.toFile(), Map.of("tenantId", tenant, "sessions", sessions,
                    "resultFile", resultFile.toString(),
                    "storeUrl", "http://127.0.0.1:" + spring.getWebServer().getPort(),
                    "brokerUrl", spring.getBean(EmbeddedRuntimeBroker.class).getBaseUri().toString()));
            Path log = temporary.resolve("driver.log");
            Process driver = new ProcessBuilder(node, "--import", "tsx",
                    "integration-tests/helpers/hosted-workspace-tool-turn-driver.ts", config.toString())
                    .directory(root.toFile()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            try {
                assertThat(driver.waitFor(270, TimeUnit.SECONDS)).as("Driver timeout: %s", Files.readString(log)).isTrue();
                assertThat(driver.exitValue()).as("Driver output: %s", Files.readString(log)).isZero();
                assertThat(Files.readString(log)).contains("HOSTED_WORKSPACE_TOOLS_OK");
                for (Path workspace : workspaces.subList(0, 2)) {
                    assertThat(Files.readString(workspace.resolve("child/proof.txt"))).isEqualTo("after");
                    assertThat(workspace.resolve("proof.txt")).doesNotExist();
                }
                List<ProcessHandle> producers = ProcessHandle.current().descendants().toList();
                assertThat(producers).as("Runtime producers before Broker shutdown").isNotEmpty();
                spring.getBean(EmbeddedRuntimeBroker.class).close();
                for (ProcessHandle producer : producers) {
                    producer.onExit().get(10, TimeUnit.SECONDS);
                    assertThat(producer.isAlive()).as("Producer %s before retained read", producer.pid()).isFalse();
                }
                System.out.println("HOSTED_SHELL_PRODUCERS_EXITED: " + producers.size());
                Path readerLog = temporary.resolve("reader.log");
                Process reader = new ProcessBuilder(node, "--import", "tsx",
                        "integration-tests/helpers/hosted-shell-result-reader.ts", resultFile.toString())
                        .directory(root.toFile()).redirectErrorStream(true).redirectOutput(readerLog.toFile()).start();
                try {
                    assertThat(reader.waitFor(60, TimeUnit.SECONDS)).as("Reader timeout: %s", Files.readString(readerLog)).isTrue();
                    assertThat(reader.exitValue()).as("Reader output: %s", Files.readString(readerLog)).isZero();
                    assertThat(Files.readString(readerLog)).contains("HOSTED_SHELL_RETAINED_OUTPUT_OK");
                } finally {
                    if (reader.isAlive()) reader.destroyForcibly();
                }
            } finally {
                driver.descendants().forEach(process -> process.destroyForcibly());
                if (driver.isAlive()) driver.destroyForcibly();
            }
        }
    }
}
