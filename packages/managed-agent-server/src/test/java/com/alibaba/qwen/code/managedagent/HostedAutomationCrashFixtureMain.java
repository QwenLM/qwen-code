/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.automation.AutomationScanner;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.AutomationLedgerStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

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
    private static final AtomicBoolean ARMED = new AtomicBoolean();
    private static final CountDownLatch FIRE_REACHED =
            new CountDownLatch(1);
    private static final CountDownLatch FIRE_RELEASE =
            new CountDownLatch(1);
    private static final AtomicBoolean ARM_WATERMARK = new AtomicBoolean();
    private static final CountDownLatch WATERMARK_REACHED =
            new CountDownLatch(1);
    private static final CountDownLatch WATERMARK_RELEASE =
            new CountDownLatch(1);

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String node = args[1];
        String cli = args[2];
        String tenant = args[3];
        int internalPort = Integer.parseInt(args[4]);
        int brokerPort = Integer.parseInt(args[5]);
        int publicPort = Integer.parseInt(args[6]);
        int storeBasePort = Integer.parseInt(args[7]);
        ObjectMapper mapper = new ObjectMapper();
        Files.createDirectories(root.resolve("workspace-mount"));
        var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class, FireHold.class).run(
                "--server.address=127.0.0.1", "--server.port=" + publicPort,
                "--spring.datasource.url=" + System.getenv("FG11C_MYSQL_URL"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getenv("FG11C_MYSQL_USER"),
                "--spring.datasource.password=" + System.getenv().getOrDefault(
                        "FG11C_MYSQL_PASSWORD", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + storeBasePort,
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
        control.createContext("/control/arm-fire", exchange -> {
            ARMED.set(true);
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        control.createContext("/control/fire-reached", exchange -> {
            byte[] body = ("{\"reached\":"
                    + (FIRE_REACHED.getCount() == 0) + "}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        control.createContext("/control/arm-watermark", exchange -> {
            ARM_WATERMARK.set(true);
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        control.createContext("/control/watermark-reached", exchange -> {
            byte[] body = ("{\"reached\":"
                    + (WATERMARK_REACHED.getCount() == 0) + "}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
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
        Map<String, Object> advertised = new LinkedHashMap<>();
        advertised.put("publicUrl", "http://127.0.0.1:" + publicPort);
        advertised.put("controlUrl", "http://127.0.0.1:"
                + control.getAddress().getPort());
        if (internalPort > 0) {
            advertised.put("internalUrl", "http://127.0.0.1:" + internalPort);
        }
        mapper.writeValue(ready.toFile(), advertised);
        Files.move(ready, root.resolve("ready.json"),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
    }

    // FG11c slice 2: the fire window. The scanner writes the occurrence as
    // `firing` and then calls runAutomationOperation; holding that call
    // leaves the occurrence in exactly the state a Spring crash between the
    // occurrence and its answer produces, without touching the wire.
    // The watermark window: the answer is already committed as `fired`,
    // and the covered marker has not moved yet. Locking the schedule row
    // cannot express it (the settle's HELD proof reads the same row), so
    // the fixture parks the store's own advanceWatermark call instead.
    static class HoldStore extends AutomationLedgerStore {
        HoldStore(JdbcTemplate jdbc) {
            super(jdbc);
        }

        @Override
        public boolean advanceWatermark(String tenantId, String scheduleId,
                String owner, long fence, long slot, long now) {
            if (ARM_WATERMARK.get()) {
                WATERMARK_REACHED.countDown();
                try {
                    WATERMARK_RELEASE.await(180, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            return super.advanceWatermark(tenantId, scheduleId, owner, fence,
                    slot, now);
        }
    }

    @TestConfiguration
    static class FireHold {
        @Bean
        @Primary
        AutomationLedgerStore holdStore(JdbcTemplate jdbc) {
            return new HoldStore(jdbc);
        }

        @Bean
        static BeanPostProcessor holdHarnessConnector() {
            return new BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean,
                        String name) {
                    if (!(bean instanceof HarnessConnector connector)) {
                        return bean;
                    }
                    return Proxy.newProxyInstance(
                            HarnessConnector.class.getClassLoader(),
                            new Class<?>[] {HarnessConnector.class},
                            (proxy, method, args) -> {
                                Object result;
                                try {
                                    result = method.invoke(connector, args);
                                } catch (InvocationTargetException
                                        failure) {
                                    throw failure.getCause();
                                }
                                // Hold the answer after the Harness committed:
                                // Spring still sees the occurrence as `firing`,
                                // which is the ambiguous-answer window.
                                if ("runAutomationOperation".equals(
                                        method.getName())
                                        && ARMED.get()) {
                                    FIRE_REACHED.countDown();
                                    try {
                                        FIRE_RELEASE.await(180,
                                                TimeUnit.SECONDS);
                                    } catch (InterruptedException interrupted) {
                                        Thread.currentThread().interrupt();
                                    }
                                }
                                return result;
                            });
                }
            };
        }
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
