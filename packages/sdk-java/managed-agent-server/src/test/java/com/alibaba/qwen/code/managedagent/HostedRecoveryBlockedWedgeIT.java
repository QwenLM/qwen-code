package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.managedprobes.PublicationProbeWiring;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.sql.Connection;
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

/**
 * Issue #13533 finding A2: one recovery-blocked session wedges later turns of
 * other sessions on the same hosted harness daemon.
 *
 * <p>Session α is put into the same recovery-blocked shape the A1 chain left
 * (admitted background start → failed reserve → cancel →
 * {@code close_not_started} → recovery-blocked turn, session renewing). The
 * A1 fix admitted the background Shell/Monitor families into the publication
 * contract, so the original 400-chain no longer exists at the endpoint; the
 * substitute used here is an injected reserve refusal on α's admitted
 * background start, injected once at the driver's relay with the same 400
 * {@code invalid_request} wire the pre-fix server answered — every downstream
 * step (cancel, close, recovery-block) then runs production code, and the
 * leftover shape matches what A1 produced. The substitute is documented in
 * the reproduction report for this issue.
 *
 * <p>Session β (and facultatively γ, or β as a preloaded session, per
 * -Dqwen.wedge.preloaded) then runs its turn(s) on the same daemon. The
 * regression expectation at this tree is <em>absent of wedge</em>: every
 * probe turn completes. If a probe ever wedges again, this test captures the
 * JVM thread dump (the managed-agent-server runs in-process), the MariaDB
 * transaction/lock state and the session rows, deletes session α's store
 * rows, asserts the probe recovers, and then fails as the A2 regression.
 *
 * <p>Run with the pristine bundle and -Dqwen.wedge.control=true for the
 * no-fault control run.
 */
class HostedRecoveryBlockedWedgeIT {

    @TempDir
    private Path temporary;

    @Test
    @Timeout(600)
    void recoveryBlockedSessionMustNotWedgeOtherSessionTurns() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(
                "true".equals(System.getProperty("qwen.wedge.probe")),
                "A2 reproduction probe: skipped unless -Dqwen.wedge.probe=true");
        assertThat(System.getProperty("mysql.url")).as("A2 reproduction requires -Dmysql.url")
                .startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user")).as("A2 reproduction requires -Dmysql.user").isNotBlank();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js"))
                .toAbsolutePath().normalize();
        assertThat(cli).as("CLI entry -Dqwen.cli.entry=%s", cli).isRegularFile();
        boolean control = "true".equals(System.getProperty("qwen.wedge.control"));
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

        String tenant = "wedge-" + UUID.randomUUID();
        List<Path> workspaces = new ArrayList<>();
        List<String> workspaceIds = List.of("workspace-a", "workspace-b", "workspace-c");
        for (String name : List.of("alpha", "beta", "gamma")) {
            Path dir = Files.createDirectory(temporary.resolve(name));
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
                // The conditional OSS-backed publication stack cannot boot
                // outside a provisioned rig, so the real controller and
                // stores are registered programmatically below with a stub
                // object store (A1's reserve is refused before any object
                // call), with only the entry-concurrency property bound.
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
                PublicationProbeWiring.class);
        try (var spring = (ServletWebServerApplicationContext) application.run(arguments.toArray(String[]::new))) {
            JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
            var metadata = jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine");
            System.out.println("A2_DATABASE " + metadata);
            assertThat(metadata.toString().toLowerCase())
                    .as("A2 reproduction requires MariaDB/MySQL, got %s", metadata)
                    .containsAnyOf("mysql", "mariadb");
            ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
            var sessions = new ArrayList<Map<String, Object>>();
            String[] profiles = {"hosted-workspace-shell/1", "hosted-workspace-files/1",
                    "hosted-workspace-files/1"};
            for (int index = 0; index < 3; index++) {
                String workspaceId = workspaceIds.get(index);
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
                sessions.add(Map.of(
                        "sessionId", created.sessionId(),
                        "workspaceId", workspaceId,
                        "directory", workspaces.get(index).resolve("child").toString(),
                        "toolProfile", profiles[index],
                        // α's admitted background start is quick-exit, so the
                        // leftover execution is cheap to leave unresolved.
                        "shellCommand", index == 0 ? "sleep 2" : "printf PROBE_OK\\n"));
            }
            EmbeddedRuntimeBroker broker = spring.getBean(EmbeddedRuntimeBroker.class);
            Path phaseFile = temporary.resolve("phase");
            Path clearedFile = temporary.resolve("cleared");
            Path config = temporary.resolve("driver.json");
            var driverConfig = new java.util.LinkedHashMap<String, Object>();
            driverConfig.put("tenantId", tenant);
            driverConfig.put("storeUrl", "http://127.0.0.1:" + spring.getWebServer().getPort());
            driverConfig.put("brokerUrl", broker.getBaseUri().toString());
            driverConfig.put("cliEntry", cli.toString());
            driverConfig.put("driveFault", !control);
            driverConfig.put("control", control);
            if (!control) {
                driverConfig.put("injectReserveDenyForSessionId",
                        sessions.get(0).get("sessionId").toString());
            }
            driverConfig.put("bPreloaded", "true".equals(System.getProperty("qwen.wedge.preloaded")));
            driverConfig.put("bCaptureBytes", Long.getLong("qwen.wedge.bCaptureBytes", 0L));
            driverConfig.put("bToolProfile", System.getProperty("qwen.wedge.bToolProfile", ""));
            driverConfig.put("holdAfterBlockMs", Long.getLong("qwen.wedge.holdMs", 0L));
            driverConfig.put("phaseFile", phaseFile.toString());
            driverConfig.put("clearedFile", clearedFile.toString());
            driverConfig.put("wireFile", temporary.resolve("wire.jsonl").toString());
            driverConfig.put("evidenceDir", evidence.toString());
            driverConfig.put("reportsDir", reportsDir.toString());
            driverConfig.put("sessions", sessions);
            new ObjectMapper().writeValue(config.toFile(), driverConfig);
            Path driverLog = temporary.resolve("driver.log");
            Process driver = new ProcessBuilder(node, "--import", "tsx",
                    "integration-tests/helpers/hosted-recovery-blocked-wedge-driver.ts",
                    config.toString())
                    .directory(repoRoot.toFile())
                    .redirectErrorStream(true).redirectOutput(driverLog.toFile()).start();
            Files.writeString(evidence.resolve("sessions.txt"),
                    "tenant=" + tenant + "\nalpha=" + sessions.get(0).get("sessionId")
                            + "\nbeta=" + sessions.get(1).get("sessionId")
                            + "\ngamma=" + sessions.get(2).get("sessionId") + "\n");
            if (control) {
                assertThat(driver.waitFor(300, TimeUnit.SECONDS))
                        .as("Control driver timeout:\n%s", Files.readString(driverLog)).isTrue();
                Files.copy(driverLog, evidence.resolve("driver-final.log"),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                String controlLog = Files.readString(driverLog);
                System.out.println(controlLog);
                assertThat(driver.exitValue()).as("Control driver output:\n%s", controlLog).isZero();
                assertThat(controlLog).contains("HOSTED_WEDGE_CONTROL_OK");
                return;
            }
            boolean wedged = false;
            long watchDeadline = System.currentTimeMillis() + 420_000;
            while (System.currentTimeMillis() < watchDeadline) {
                if (Files.exists(phaseFile)
                        && Files.readString(phaseFile).trim().equals("B_WEDGED_CONFIRMED")) {
                    wedged = true;
                    break;
                }
                if (!driver.isAlive()) break;
                Thread.sleep(400);
            }
            Files.copy(driverLog, evidence.resolve("driver.log"),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            if (!wedged) {
                String log = Files.readString(driverLog);
                if (!driver.isAlive()) {
                    assertThat(driver.waitFor(60, TimeUnit.SECONDS))
                            .as("Driver exit wait:\n%s", log).isTrue();
                    if (log.contains("HOSTED_WEDGE_ABSENT") && driver.exitValue() == 0) {
                        // Regression expectation: with α recovery-blocked, the
                        // probes' turns complete. Anything else is the A2
                        // wedge returning.
                        dumpAll(jdbc, evidence, sessions, tenant, "not-wedged");
                        return;
                    }
                    if (log.contains("HOSTED_RECOVERY_WEDGE_OK")) {
                        dumpAll(jdbc, evidence, sessions, tenant, "wedge-regression");
                        throw new AssertionError(
                                "A2 REGRESSION: a probe turn wedged with α recovery-blocked"
                                        + " and only completed after α's rows were cleared."
                                        + " See " + evidence + " and driver log:\n" + log);
                    }
                }
                throw new AssertionError("Driver exited unexpectedly (wedged=" + wedged
                        + ", alive=" + driver.isAlive() + "). Log:\n" + log);
            }

            // --- A2 reproduced: capture the full park-point evidence --------
            Files.writeString(evidence.resolve("java-threads.txt"), threadDump());
            dumpAll(jdbc, evidence, sessions, tenant, "before-clear");

            // --- Clear session α's store rows, like the rig operator did ---
            String alpha = sessions.get(0).get("sessionId").toString();
            String clearReport = clearSessionRows(jdbc, alpha);
            Files.writeString(evidence.resolve("clear-alpha.txt"), clearReport);
            Files.writeString(clearedFile, clearReport);
            dumpAll(jdbc, evidence, sessions, tenant, "after-clear");

            assertThat(driver.waitFor(300, TimeUnit.SECONDS))
                    .as("Driver timeout:\n%s", Files.readString(driverLog)).isTrue();
            Files.copy(driverLog, evidence.resolve("driver-final.log"),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            String log = Files.readString(driverLog);
            System.out.println(log);
            assertThat(driver.exitValue()).as("Driver output:\n%s", log).isZero();
            throw new AssertionError(
                    "A2 REGRESSION: a probe turn wedged with α recovery-blocked and only"
                            + " completed after α's rows were cleared. See " + evidence
                            + " and driver log:\n" + log);
        }
    }

    private static String threadDump() {
        ThreadMXBean bean = ManagementFactory.getThreadMXBean();
        StringBuilder out = new StringBuilder();
        out.append("threadCount=").append(bean.getThreadCount()).append('\n');
        for (ThreadInfo info : bean.dumpAllThreads(true, true)) {
            out.append('\n').append('"').append(info.getThreadName()).append('"')
                    .append(" id=").append(info.getThreadId())
                    .append(" state=").append(info.getThreadState())
                    .append(" lock=").append(info.getLockName())
                    .append(" lockOwner=").append(info.getLockOwnerName())
                    .append('\n');
            for (StackTraceElement frame : info.getStackTrace()) {
                out.append("    at ").append(frame).append('\n');
            }
            for (var monitor : info.getLockedMonitors()) {
                out.append("    - locked ").append(monitor).append('\n');
            }
            for (var ownable : info.getLockedSynchronizers()) {
                out.append("    - sync ").append(ownable).append('\n');
            }
        }
        return out.toString();
    }

    private void dumpAll(JdbcTemplate jdbc, Path evidence, List<Map<String, Object>> sessions,
            String tenant, String tag) throws Exception {
        StringBuilder out = new StringBuilder();
        query(out, jdbc, "PROCESSLIST",
                "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 400) AS INFO"
                        + " FROM information_schema.PROCESSLIST ORDER BY ID");
        query(out, jdbc, "INNODB_TRX",
                "SELECT TRX_ID, TRX_STATE, TRX_STARTED, TRX_MYSQL_THREAD_ID, TRX_ROWS_LOCKED,"
                        + " TRX_ISOLATION_LEVEL, LEFT(TRX_QUERY, 400) AS TRX_QUERY"
                        + " FROM information_schema.INNODB_TRX");
        query(out, jdbc, "DATA_LOCKS",
                "SELECT ENGINE, ENGINE_LOCK_ID, ENGINE_TRANSACTION_ID, THREAD_ID, OBJECT_SCHEMA,"
                        + " OBJECT_NAME, LOCK_TYPE, LOCK_MODE, LOCK_STATUS, LEFT(LOCK_DATA, 120) AS LOCK_DATA"
                        + " FROM performance_schema.data_locks");
        query(out, jdbc, "INNODB_LOCKS_LEGACY", "SELECT * FROM information_schema.INNODB_LOCKS");
        query(out, jdbc, "INNODB_LOCK_WAITS_LEGACY", "SELECT * FROM information_schema.INNODB_LOCK_WAITS");
        query(out, jdbc, "METADATA_LOCKS",
                "SELECT OBJECT_SCHEMA, OBJECT_NAME, LOCK_TYPE, LOCK_DURATION, LOCK_STATUS,"
                        + " SOURCE, OWNER_THREAD_ID FROM performance_schema.metadata_locks");
        try {
            var status = jdbc.queryForMap("SHOW ENGINE INNODB STATUS");
            out.append("=== SHOW ENGINE INNODB STATUS ===\n").append(status.get("Status")).append('\n');
        } catch (Exception error) {
            out.append("INNODB STATUS failed: ").append(error).append('\n');
        }
        for (Map<String, Object> session : sessions) {
            String id = session.get("sessionId").toString();
            query(out, jdbc, "journal_head " + id,
                    "SELECT tenant_id, session_id, workspace_id, state, recovery_status,"
                            + " recovery_detail_code, writer_id, writer_generation,"
                            + " journal_revision, committed_sequence, activation_epoch,"
                            + " writer_lease_until, updated_at FROM"
                            + " qwen_managed_session_journal_head WHERE tenant_id = ? AND"
                            + " session_id = ?", tenant, id);
            query(out, jdbc, "journal_tx " + id,
                    "SELECT session_id, operation, command_id, journal_revision, first_sequence,"
                            + " last_sequence, created_at FROM qwen_managed_session_journal_tx"
                            + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision"
                            + " DESC LIMIT 25", tenant, id);
            query(out, jdbc, "publications " + id,
                    "SELECT publication_id, tenant_id, session_id, retention_state, state,"
                            + " capture_used_bytes FROM qwen_tool_publication WHERE tenant_id = ?"
                            + " AND session_id = ?", tenant, id);
        }
        dumpSessionRows(jdbc, out, sessions);
        Files.writeString(evidence.resolve("db-" + tag + ".txt"), out.toString());
    }

    private static void query(StringBuilder out, JdbcTemplate jdbc, String label, String sql,
            Object... args) {
        out.append("=== ").append(label).append(" ===\n");
        try {
            for (Map<String, Object> row : jdbc.queryForList(sql, args)) {
                out.append(row).append('\n');
            }
        } catch (Exception error) {
            out.append("query failed: ").append(error.getMessage()).append('\n');
        }
    }

    /** Every table row keyed by either session id, through any session-ish column. */
    private static void dumpSessionRows(JdbcTemplate jdbc, StringBuilder out,
            List<Map<String, Object>> sessions) throws Exception {
        String alpha = sessions.get(0).get("sessionId").toString();
        String beta = sessions.get(1).get("sessionId").toString();
        for (String table : sessionTables(jdbc)) {
            for (String column : sessionColumns(jdbc, table)) {
                out.append("=== rows ").append(table).append('.').append(column).append(" ===\n");
                try {
                    List<Map<String, Object>> rows = jdbc.queryForList(
                            "SELECT * FROM " + table + " WHERE " + column + " IN (?, ?) LIMIT 40",
                            alpha, beta);
                    for (Map<String, Object> row : rows) out.append(row).append('\n');
                    out.append("(count=").append(rows.size()).append(")\n");
                } catch (Exception error) {
                    out.append("query failed: ").append(error.getMessage()).append('\n');
                }
            }
        }
    }

    private static List<String> sessionTables(JdbcTemplate jdbc) {
        return jdbc.queryForList(
                "SELECT DISTINCT table_name FROM information_schema.columns"
                        + " WHERE table_schema = DATABASE() AND (column_name = 'session_id'"
                        + " OR column_name = 'harness_session_id') ORDER BY table_name",
                String.class);
    }

    private static List<String> sessionColumns(JdbcTemplate jdbc, String table) {
        return jdbc.queryForList(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE()"
                        + " AND table_name = ? AND (column_name = 'session_id'"
                        + " OR column_name = 'harness_session_id') ORDER BY column_name",
                String.class, table);
    }

    private static String clearSessionRows(JdbcTemplate jdbc, String sessionId) throws Exception {
        StringBuilder out = new StringBuilder();
        String database;
        try (Connection connection = jdbc.getDataSource().getConnection()) {
            database = connection.getCatalog();
        }
        out.append("clearing session ").append(sessionId).append(" in ").append(database).append('\n');
        for (int round = 0; round < 8; round++) {
            int errors = 0;
            out.append("--- round ").append(round).append(" ---\n");
            for (String table : sessionTables(jdbc)) {
                for (String column : sessionColumns(jdbc, table)) {
                    try {
                        int deleted = jdbc.update("DELETE FROM " + table + " WHERE " + column + " = ?",
                                sessionId);
                        if (deleted > 0)
                            out.append("deleted ").append(deleted).append(" from ").append(table)
                                    .append('.').append(column).append('\n');
                    } catch (Exception error) {
                        errors++;
                        out.append("FAILED ").append(table).append('.').append(column).append(' ')
                                .append(error.getMessage()).append('\n');
                    }
                }
            }
            if (errors == 0) {
                out.append("clear complete in round ").append(round).append('\n');
                return out.toString();
            }
            Thread.sleep(500);
        }
        out.append("CLEAR INCOMPLETE after 8 rounds\n");
        return out.toString();
    }
}
