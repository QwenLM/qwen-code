package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.service.ManagedChannelService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.Map;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

// FG7c (issue #13802): the killable control plane of the channel crash
// gates. Reboots against the same tenant and database — a lost generation
// proves itself by the durable rows alone — and exposes a minimal control
// surface so the IT can drive the lease machinery deterministically.
public final class HostedChannelCrashFixtureMain {
    private HostedChannelCrashFixtureMain() {
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String node = args[1];
        String cli = args[2];
        String tenant = args[3];
        int internalPort = Integer.parseInt(args[4]);
        int publicPort = Integer.parseInt(args[5]);
        int brokerPort = Integer.parseInt(args[6]);
        ObjectMapper mapper = new ObjectMapper();
        Files.createDirectories(root.resolve("workspace-mount"));
        var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=" + publicPort,
                "--spring.datasource.url=" + System.getenv("FG7C_MYSQL_URL"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getenv("FG7C_MYSQL_USER"),
                "--spring.datasource.password=" + System.getenv().getOrDefault(
                        "FG7C_MYSQL_PASSWORD", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + internalPort,
                "--qwen.managed-agent.session-store.workspace-id=workspace-0",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.base-url=" + System.getenv(
                        "FG7C_HARNESS_URL"),
                "--qwen.managed-agent.harness.token=fg7-harness-token",
                "--qwen.managed-agent.harness.capability-digest=sha256:"
                        + "a".repeat(64),
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                "--qwen.managed-agent.runtime-broker.token=fg7-broker-token",
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + root.resolve("workspace-mount"),
                "--qwen.managed-agent.runtime-broker.state-directory=" + root.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage-0",
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + root.resolve("workspace-mount"),
                "--qwen.managed-agent.channels.enabled=true",
                "--qwen.managed-agent.channels.claim-lease=30m",
                "--qwen.managed-agent.channels.scan-delay=30s",
                "--qwen.managed-agent.internal-server.address=127.0.0.1",
                "--qwen.managed-agent.internal-server.port=" + internalPort);
        JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
        if (jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_registry"
                + " WHERE tenant_id = ? AND workspace_id = 'workspace-0'",
                Integer.class, tenant) == 0) {
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                    + " workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state) VALUES"
                    + " (?, 'workspace-0', 1, 'storage-0', 'Workspace', ?, ?,"
                    + " 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                    WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                    + " workspace_id, actor_id, role) VALUES (?, 'workspace-0',"
                    + " ?, 'OPERATOR')", tenant,
                    "actor".getBytes(StandardCharsets.UTF_8));
        }
        HttpServer control = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        control.createContext("/control/reconcile", exchange -> {
            spring.getBean(ManagedChannelService.class).reconcile();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        control.createContext("/control/expire", exchange -> {
            String query = exchange.getRequestURI().getQuery();
            Map<String, String> params = new HashMap<>();
            for (String entry : query.split("&")) {
                String[] pair = entry.split("=", 2);
                params.put(pair[0], pair.length > 1 ? pair[1] : "");
            }
            jdbc.update("UPDATE qwen_managed_channel_claim SET claimed_at = 0"
                    + " WHERE tenant_id = ? AND channel_id = ?",
                    params.get("tenant"), params.get("channel"));
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        control.start();
        Path ready = root.resolve("ready.tmp");
        mapper.writeValue(ready.toFile(), Map.of(
                "internalUrl", "http://127.0.0.1:" + internalPort,
                "controlUrl", "http://127.0.0.1:"
                        + control.getAddress().getPort()));
        Files.move(ready, root.resolve("ready.json"),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
    }
}
