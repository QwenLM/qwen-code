package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

public final class HostedProcessCrashFixtureMain {
    private HostedProcessCrashFixtureMain() {
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String node = args[1];
        String cli = args[2];
        String tenant = args[3];
        String fault = args[4];
        Path workspace = root.resolve("workspace");
        Path worker = root.resolve("fixture-worker.mjs");
        Path cliPath = Path.of(cli).toAbsolutePath().normalize();
        ObjectMapper mapper = new ObjectMapper();
        Files.writeString(worker, "await import("
                + mapper.writeValueAsString(cliPath.getParent().getParent()
                        .resolve("integration-tests/helpers/hosted-file-read-gate.mjs").toUri().toString())
                + ");\nprocess.argv[1] = " + mapper.writeValueAsString(cliPath.toString())
                + ";\nawait import(" + mapper.writeValueAsString(cliPath.toUri().toString()) + ");\n");
        var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + System.getenv("FG6C_MYSQL_URL"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getenv("FG6C_MYSQL_USER"),
                "--spring.datasource.password=" + System.getenv().getOrDefault("FG6C_MYSQL_PASSWORD", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.harness.capability-digest=sha256:" + "a".repeat(64),
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.token=hosted-tools-broker-token",
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + root,
                "--qwen.managed-agent.runtime-broker.state-directory=" + root.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + worker,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + workspace);
        Path saved = root.resolve("session-id");
        String sessionId;
        if (Files.exists(saved)) {
            sessionId = Files.readString(saved);
        } else {
            JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage',"
                    + " 'Workspace', ?, ?, 'ACTIVE')", tenant,
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES (?, 'workspace', ?, TRUE, TRUE)", tenant, "actor".getBytes(StandardCharsets.UTF_8));
            sessionId = spring.getBean(ManagedAgentStore.class).insertWorkspaceSessionCommand(tenant, "actor", "create",
                    "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                    new WorkspaceSelection("workspace", "child")).sessionId();
            Files.writeString(saved, sessionId);
        }
        Path ready = root.resolve("ready.tmp");
        new ObjectMapper().writeValue(ready.toFile(), Map.of(
                "tenantId", tenant, "sessionId", sessionId, "workspaceId", "workspace",
                "directory", workspace.resolve("child").toString(), "fault", fault,
                "storeUrl", "http://127.0.0.1:" + spring.getWebServer().getPort(),
                "brokerUrl", spring.getBean(EmbeddedRuntimeBroker.class).getBaseUri().toString()));
        Files.move(ready, root.resolve("ready.json"), StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
    }
}
