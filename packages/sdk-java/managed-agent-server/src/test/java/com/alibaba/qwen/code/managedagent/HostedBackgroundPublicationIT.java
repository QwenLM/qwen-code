package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Post-A1-fix end-to-end witness (#13533, finding A1, per
 * {@code docs/design/2026-10-09-managed-tool-publication-background-arm.md}):
 * the background Shell and Monitor payload families were admitted into the
 * publication contract, so a hosted turn's background {@code run_shell_command}
 * and {@code monitor} calls now reach a reserve instead of the removed 400.
 *
 * <p>Arms (production binaries in-process: MariaDB + embedded broker + real
 * hosted-harness daemon running the bundled CLI with the declared test
 * switch that admits {@code child_run} (kind {@code shell}) and
 * {@code monitor_run}; fake model; no cgroup v2 on this host, so the
 * ephemeral lane declines every shell-typed start {@code not_started}):
 *
 * <ul>
 * <li>background-reserve: admitted background start reserves and the grant
 * answers OPEN (200) — the pre-fix 400 no longer exists. The start is then
 * declined {@code not_started} on the ephemeral lane (no cgroup v2 root),
 * the grant closes NOT_STARTED (200), and the turn goes recovery-blocked;
 * full detached-handle settlement after turn completion remains the unlanded
 * B1 arm — pinned and named.
 * <li>monitor-reserve: after the three-layer admission chain was lifted
 * (contract payload arm; store checkpoint toolName via
 * {@code ToolPublicationContract.PUBLISHABLE_TOOL_NAMES}; turn checkpoint
 * {@code inputDigest} recording the canonical-input digest for the monitor
 * family as well), the admitted Monitor reserve answers <b>OPEN</b> like
 * the background arm, then declines {@code not_started} on the ephemeral
 * lane (no cgroup v2 root), closes NOT_STARTED (200), and the turn blocks;
 * the earlier checkpoint-refusal findings are closed by that chain.
 * <li>refusal-edges-live: per-family raw negatives replayed against the
 * running endpoint as forged-digest reserves (fresh publicationId, forged
 * requestDigest/argsDigest) — shape-level negatives can't be emitted by the
 * turn and the digest-bound protocol admits no spoofing; each replay
 * answers 400 with a live diagnostic, mirrored by the unit fixture corpus
 * for the field-shape refusals.
 * <li>foreground (v3 lane): reserve OPEN + close NOT_STARTED +
 * recovery-blocked — off-Linux the ephemeral lane declines all shell-typed
 * executions alike; byte-level foreground regression is held by
 * {@code HostedWorkspaceToolTurnIT}'s main workspace/shell lane (G5), run in
 * the same verification pass.
 * </ul>
 *
 * <p>Gated behind -Dqwen.wedge.probe=true so the hosted-harness-mysql CI
 * lane is unaffected without the probe flag. The wiring registers a
 * probe-only exception advice that surfaces the contract/store refusal
 * reasons in the 400 envelope and the test log (production's handler is
 * deliberately generic).
 */
class HostedBackgroundPublicationIT {

    @TempDir
    private Path temporary;

    @Test
    @Timeout(600)
    void backgroundAndMonitorReservesAnswerOpen() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(
                "true".equals(System.getProperty("qwen.wedge.probe")),
                "background publication witness: skipped unless -Dqwen.wedge.probe=true");
        assertThat(System.getProperty("mysql.url")).as("witness requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user")).as("witness requires -Dmysql.user").isNotBlank();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js"))
                .toAbsolutePath().normalize();
        assertThat(cli).as("CLI entry -Dqwen.cli.entry=%s", cli).isRegularFile();
        Path moduleDir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        Path repoRoot = moduleDir.resolve("../../..").normalize();
        assertThat(repoRoot.resolve("integration-tests/helpers/hosted-recovery-blocked-wedge-driver.ts"))
                .isRegularFile();
        Path evidence = System.getProperty("qwen.wedge.evidence") != null
                ? Path.of(System.getProperty("qwen.wedge.evidence")).toAbsolutePath()
                : moduleDir.resolve("target/wedge-evidence");
        Files.createDirectories(evidence);
        Path reportsDir = evidence.resolve("node-reports");
        Files.createDirectories(reportsDir);
        temporary = temporary.toRealPath();
        Files.createDirectory(temporary.resolve("runtime"));

        String tenant = "publication-" + UUID.randomUUID();
        record SessionSpec(String name, String role, String shellCommand) {}
        List<SessionSpec> specs = List.of(
                new SessionSpec("alpha", "background",
                        "mkdir -p probe && echo BG_OK > probe/bg.txt"),
                new SessionSpec("mu", "monitor", "printf MON_OK\\n; sleep 1"),
                new SessionSpec("sigma", "foreground", "echo FG_OK > fg-proof.txt"));
        List<Path> workspaces = new ArrayList<>();
        for (SessionSpec spec : specs) {
            Path dir = Files.createDirectory(temporary.resolve(spec.name()));
            Files.createDirectory(dir.resolve("child"));
            Files.setLastModifiedTime(dir, FileTime.fromMillis(1));
            workspaces.add(dir);
        }
        Path wrapper = temporary.resolve("node-report-wrapper.sh");
        Files.writeString(wrapper, "#!/bin/sh\nexec " + node
                + " --report-on-signal --report-signal=SIGUSR2 --report-directory="
                + reportsDir + " \"$@\"\n");
        wrapper.toFile().setExecutable(true);

        var arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getProperty("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.tool-publication.entry-concurrency=32",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.harness.capability-digest=sha256:" + "a".repeat(64),
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.token=hosted-tools-broker-token",
                "--qwen.managed-agent.runtime-broker.durable-local-process=false",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + temporary,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + wrapper,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled=false",
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        for (int index = 0; index < workspaces.size(); index++) {
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts[" + index + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + index);
            arguments.add(prefix + "root=" + workspaces.get(index));
        }
        var application = new SpringApplicationBuilder(ManagedAgentServerApplication.class,
                PublicationProbeWiring.class, ProbeAdvice.class);
        try (var spring = (ServletWebServerApplicationContext) application.run(arguments.toArray(String[]::new))) {
            JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
            var metadata = jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine");
            System.out.println("PUBLICATION_DATABASE " + metadata);
            assertThat(metadata.toString().toLowerCase())
                    .as("witness requires MariaDB/MySQL, got %s", metadata)
                    .containsAnyOf("mysql", "mariadb");
            ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
            var sessions = new ArrayList<Map<String, Object>>();
            for (int index = 0; index < specs.size(); index++) {
                String workspaceId = "workspace-" + index;
                jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id,"
                        + " workspace_generation, storage_id, display_name, config_ref, policy_ref,"
                        + " state) VALUES (?, ?, 1, ?, 'Workspace', ?, ?, 'ACTIVE')",
                        tenant, workspaceId, "storage-" + index,
                        WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
                jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id,"
                        + " role) VALUES (?, ?, ?, 'OPERATOR')",
                        tenant, workspaceId, "actor".getBytes(StandardCharsets.UTF_8));
                var created = store.insertWorkspaceSessionCommand(tenant, "actor", "create-" + index,
                        "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection(workspaceId, "child"));
                var entry = new LinkedHashMap<String, Object>();
                entry.put("sessionId", created.sessionId());
                entry.put("workspaceId", workspaceId);
                entry.put("directory", workspaces.get(index).resolve("child").toString());
                entry.put("toolProfile", "hosted-workspace-shell/1");
                entry.put("role", specs.get(index).role());
                if (specs.get(index).shellCommand() != null)
                    entry.put("shellCommand", specs.get(index).shellCommand());
                sessions.add(entry);
            }
            EmbeddedRuntimeBroker broker = spring.getBean(EmbeddedRuntimeBroker.class);
            Path phaseFile = temporary.resolve("phase");
            Path config = temporary.resolve("driver.json");
            var driverConfig = new LinkedHashMap<String, Object>();
            driverConfig.put("tenantId", tenant);
            driverConfig.put("storeUrl", "http://127.0.0.1:" + spring.getWebServer().getPort());
            driverConfig.put("brokerUrl", broker.getBaseUri().toString());
            driverConfig.put("cliEntry", cli.toString());
            driverConfig.put("arm", "publication");
            driverConfig.put("driveFault", true);
            driverConfig.put("control", false);
            driverConfig.put("phaseFile", phaseFile.toString());
            driverConfig.put("clearedFile", temporary.resolve("cleared").toString());
            driverConfig.put("wireFile", temporary.resolve("wire.jsonl").toString());
            driverConfig.put("evidenceDir", evidence.toString());
            driverConfig.put("reportsDir", reportsDir.toString());
            driverConfig.put("sessions", sessions);
            new ObjectMapper().writeValue(config.toFile(), driverConfig);
            Files.writeString(evidence.resolve("sessions.txt"),
                    sessions.stream().map(s -> s.get("role") + "=" + s.get("sessionId"))
                            .reduce(tenant, (out, line) -> out + "\n" + line) + "\n");
            Path driverLog = temporary.resolve("driver.log");
            Process driver = new ProcessBuilder(node, "--import", "tsx",
                    "integration-tests/helpers/hosted-recovery-blocked-wedge-driver.ts",
                    config.toString())
                    .directory(repoRoot.toFile())
                    .redirectErrorStream(true).redirectOutput(driverLog.toFile()).start();
            assertThat(driver.waitFor(480, TimeUnit.SECONDS))
                    .as("Driver timeout:\n%s", Files.readString(driverLog)).isTrue();
            if (Files.exists(temporary.resolve("wire.jsonl"))) {
                Files.copy(temporary.resolve("wire.jsonl"), evidence.resolve("wire.jsonl"),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            Files.copy(driverLog, evidence.resolve("driver-final.log"),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            String log = Files.readString(driverLog);
            System.out.println(log);
            assertThat(driver.exitValue()).as("Driver output:\n%s", log).isZero();
            assertThat(log).contains("HOSTED_BACKGROUND_PUBLICATION_OK");
        }
    }

    /**
     * Probe-lane diagnosis: the production 400 handler answers with a
     * deliberately generic envelope and no log, so contract refusals are
     * unreadable on the wire. This advice — registered only by this IT's
     * wiring — logs the full cause and embeds it in the envelope.
     */
    @org.springframework.web.bind.annotation.RestControllerAdvice
    @org.springframework.core.annotation.Order(
            org.springframework.core.Ordered.HIGHEST_PRECEDENCE)
    static final class ProbeAdvice {
        @org.springframework.web.bind.annotation.ExceptionHandler(
                IllegalArgumentException.class)
        org.springframework.http.ResponseEntity<Map<String, Object>> probeInvalid(
                IllegalArgumentException error, jakarta.servlet.http.HttpServletRequest request) {
            System.out.println("PROBE_CONTRACT_REFUSAL " + request.getMethod() + " "
                    + request.getRequestURI() + " query=" + request.getQueryString());
            error.printStackTrace(System.out);
            return org.springframework.http.ResponseEntity.status(
                    org.springframework.http.HttpStatus.BAD_REQUEST).body(Map.of(
                    "error", Map.of(
                            "code", "invalid_request",
                            "message", "The request body is invalid.",
                            "diagnostic", String.valueOf(error.getMessage()))));
        }
    }
}
