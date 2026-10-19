/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.service.AutomationScanner;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;

// FG11c slice 2 (issue #14446): the killable control plane of the automation
// crash gates. Sibling of HostedChannelCrashFixtureMain (FG7c) with the
// scanner enabled, so the test can SIGKILL a Spring that is mid-fire and
// prove from the durable rows that no second run appears.
//
// The control surface stays minimal on purpose: one endpoint drives a
// scanner tick so the two-scanner race is deterministic, and ready.json
// carries the ports the test needs. Everything else is ordinary traffic
// through the internal server.
public final class HostedAutomationCrashFixtureMain {
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String node = args[1];
        String cli = args[2];
        String tenant = args[3];
        int internalPort = Integer.parseInt(args[4]);
        int brokerPort = Integer.parseInt(args[5]);
        int publicPort = Integer.parseInt(args[6]);
        ObjectMapper mapper = new ObjectMapper();
        Files.createDirectories(root.resolve("workspace-mount"));
        var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=" + publicPort,
                "--spring.datasource.url=" + System.getenv("FG11C_MYSQL_URL"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getenv("FG11C_MYSQL_USER"),
                "--spring.datasource.password=" + System.getenv().getOrDefault(
                        "FG11C_MYSQL_PASSWORD", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + internalPort,
                "--qwen.managed-agent.session-store.workspace-id=workspace-0",
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.base-url=" + System.getenv(
                        "FG11C_HARNESS_URL"),
                "--qwen.managed-agent.harness.token=fg11-harness-token",
                "--qwen.managed-agent.harness.capability-digest=sha256:"
                        + "a".repeat(64),
                "--qwen.managed-agent.harness.workspace-files-enabled=true",
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + brokerPort,
                "--qwen.managed-agent.runtime-broker.token=fg11-broker-token",
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + root.resolve("workspace-mount"),
                "--qwen.managed-agent.runtime-broker.state-directory=" + root.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=" + tenant,
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage-0",
                "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=" + root.resolve("workspace-mount"),
                "--qwen.managed-agent.automation.enabled=true",
                "--qwen.managed-agent.trusted-actor-header=x-qwen-actor",
                "--qwen.managed-agent.automation.scan-delay=1s",
                "--qwen.managed-agent.automation.lease=15s",
                "--qwen.managed-agent.automation.late-tolerance=30s",
                "--qwen.managed-agent.automation.lookback=10m",
                "--qwen.managed-agent.internal-server.address=127.0.0.1",
                "--qwen.managed-agent.internal-server.port=" + internalPort);
        JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace"
                + " WHERE tenant_id = ? AND workspace_id = 'workspace-0'",
                Integer.class, tenant) == 0) {
            jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                    + " workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state) VALUES"
                    + " (?, 'workspace-0', 1, 'storage-0', 'Workspace', ?, ?,"
                    + " 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                    WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                    + " workspace_id, actor_id, role) VALUES (?, 'workspace-0',"
                    + " ?, 'OPERATOR')", tenant,
                    "actor".getBytes(StandardCharsets.UTF_8));
        }
        HttpServer control = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        control.createContext("/control/scan", exchange -> {
            try {
                spring.getBean(AutomationScanner.class).scan();
                exchange.sendResponseHeaders(204, -1);
            } catch (RuntimeException failure) {
                respondFailure(exchange, failure);
            }
            exchange.close();
        });
        control.start();
        Path ready = root.resolve("ready.tmp");
        mapper.writeValue(ready.toFile(), Map.of(
                "internalUrl", "http://127.0.0.1:" + internalPort,
                "publicUrl", "http://127.0.0.1:" + publicPort,
                "controlUrl", "http://127.0.0.1:"
                        + control.getAddress().getPort()));
        Files.move(ready, root.resolve("ready.json"),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
    }

    private static void respondFailure(HttpExchange exchange,
            RuntimeException failure) throws IOException {
        byte[] body = String.valueOf(failure)
                .getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(500, body.length);
        exchange.getResponseBody().write(body);
    }

    private HostedAutomationCrashFixtureMain() {
    }
}
