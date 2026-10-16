package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
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
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.IntFunction;

import static org.assertj.core.api.Assertions.assertThat;

// FG8 (issues #14054/#14163): multi-process fault gates for monitor_run
// and the child_run shell kind — the capabilities #13889 enabled without
// a fault round. FG8a gates reply loss (retries must resolve through the
// original identity); FG8b gates store failures (a rejected commit inside
// a real transaction leaves zero OS effects); FG8d gates cancellation and
// the routine/drain release split; FG8e gates SSE continuity across
// abort/resume; FG8f gates output delivery under publisher loss. Real
// packaged Harness, real MySQL, JDBC ground truth; no production code
// changes. FG8c lands with #13986 per the issue's sequencing constraint.
class HostedMonitorRunFaultGatesIT {
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
            // broker-supervised children alive, so a throwing close is not
            // exotic here.
            if (gateServer != null) {
                gateServer.stop(0);
                gateServer = null;
            }
        }
    }

    @Test
    @Timeout(600)
    void fg8eStreamGapsStayContinuousAcrossAbortAndResumeOnMySql()
            throws Exception {
        runLetter("fg8e", List.of("public-run-resume", "webshell-run-resume",
                "public-monitor-resume", "webshell-monitor-resume"));
    }

    @Test
    @Timeout(600)
    void fg8fOutputDeliveryStaysConsistentAcrossPublisherLossOnMySql()
            throws Exception {
        runLetter("fg8f", List.of("publisher-kill-mid-capture",
                "in-flight-cap", "receipt-drop-after-watermark"));
    }

    @Test
    @Timeout(600)
    void fg8aLostRepliesResolveThroughTheOriginalIdentityOnMySql()
            throws Exception {
        runLetter("fg8a", List.of("dispatch-reply", "monitor-stop-reply",
                "capture-commit-reply", "observation-advance-reply"));
    }

    @Test
    @Timeout(600)
    void fg8bStoreFailuresLeaveNoOsEffectsOnMySql() throws Exception {
        runLetter("fg8b", List.of("invocation-commit", "process-ledger-commit",
                "manifest-commit", "page-envelope-commit"));
    }

    @Test
    @Timeout(600)
    void fg8dCancellationAndDrainSettleHonestlyOnMySql() throws Exception {
        runLetter("fg8d", List.of("cancel-before-start",
                "cancel-during-capture", "cancel-status-unavailable",
                "cancel-reply-lost", "routine-release-refusal",
                "drain-release"));
    }

    /** Trigger rows this letter installed for FG8b (dropped after it). */
    private List<String> fg8bTriggers;

    private void runLetter(String letter, List<String> allCases)
            throws Exception {
        assertThat(System.getProperty("mysql.url"))
                .as("FG8 requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user"))
                .as("FG8 requires -Dmysql.user").isNotBlank();
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
                "fg8-cases", letter);
        deleteRecursively(casesRoot);
        Files.createDirectories(casesRoot);
        String tenant = "hosted-monitor-" + UUID.randomUUID();
        Path cli = cliEntry();
        String node = System.getProperty("node.executable");
        Files.createDirectory(temporary.resolve("runtime"));
        // The publication service base-url must name the public connector
        // before boot, so the port is pinned rather than ephemeral.
        int port = freePort();

        var arguments = new ArrayList<>(List.of("--server.address=127.0.0.1",
                "--server.port=" + port,
                "--spring.datasource.url=" + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username="
                        + System.getProperty("mysql.user"),
                "--spring.datasource.password="
                        + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.tool-publication.enabled=true",
                "--qwen.managed-agent.tool-publication.oss-endpoint=https://oss-cn-hangzhou.aliyuncs.com",
                "--qwen.managed-agent.tool-publication.oss-region=cn-hangzhou",
                "--qwen.managed-agent.tool-publication.oss-bucket=fg8-fixture",
                "--qwen.managed-agent.tool-publication.service-base-url=http://127.0.0.1:"
                        + port,
                "--qwen.managed-agent.tool-publication.execution-bytes=1073741824",
                "--qwen.managed-agent.tool-publication.session-bytes=1073741824",
                "--qwen.managed-agent.tool-publication.tenant-bytes=1073741824",
                "--qwen.managed-agent.tool-publication.active-captures=4",
                "--qwen.managed-agent.tool-publication.entry-concurrency=4",
                "--qwen.managed-agent.tool-publication.operation-timeout=10s",
                "--qwen.managed-agent.tool-publication.claim-timeout=5s",
                "--qwen.managed-agent.tool-publication.verification-bytes-per-second=1048576",
                "--qwen.managed-agent.tool-publication.max-verification-timeout=20m",
                "--qwen.managed-agent.tool-publication.gc-enabled=true",
                "--qwen.managed-agent.tool-publication.deletion-grace=0s",
                "--qwen.managed-agent.harness.enabled=false",
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
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                // SQL polling outside the receive window forces the live hub
                // to carry delivery, like FG6e.
                "--qwen.managed-agent.events.poll-interval=60s",
                "--qwen.managed-agent.events.heartbeat-interval=60s"));
        List<Path> workspaces = new ArrayList<>();
        for (int index = 0; index < cases.size(); index++) {
            // Per-case evidence lives under target/fg8-cases/ — the CI
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
        application.initializers(context -> {
            context.getBeanFactory().registerSingleton("fg8Authentication",
                    HostedMonitorRunProbe.authentication(tenant));
            // The publication object store is gated on a real OSS client;
            // the inline-capture fixture proves access control and never
            // touches the network (the HostedPublicWorkspaceIT pattern).
            var acl = new com.aliyun.oss.model.AccessControlList();
            acl.setCannedACL(
                    com.aliyun.oss.model.CannedAccessControlList.Private);
            var oss = org.mockito.Mockito.mock(com.aliyun.oss.OSS.class,
                    invocation -> switch (invocation.getMethod().getName()) {
                        case "getBucketVersioning" ->
                            new com.aliyun.oss.model.BucketVersioningConfiguration();
                        case "getBucketAcl" -> acl;
                        case "shutdown" -> null;
                        case "toString" -> "fg8-oss-fixture";
                        default -> throw new AssertionError(
                                "Unexpected OSS access in the FG8 fixture: "
                                        + invocation.getMethod().getName());
                    });
            context.addBeanFactoryPostProcessor(beanFactory -> beanFactory
                    .registerSingleton("toolPublicationOss", oss));
        });
        spring = (ServletWebServerApplicationContext) application.run(
                arguments.toArray(String[]::new));
        JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
        ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
        EmbeddedRuntimeBroker broker = spring.getBean(
                EmbeddedRuntimeBroker.class);
        if ("Linux".equals(System.getProperty("os.name"))) {
            var guard = spring.getBean(
                    com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard.class);
            for (int index = 0; index < cases.size(); index++) {
                guard.register(tenant, "storage-" + index,
                        UUID.randomUUID().toString());
            }
        } else {
            // register() is gated on its Linux identity probe; everywhere
            // else the fixture owes the broker the storage ledger rows a
            // finished registration leaves behind, or claim() refuses every
            // acquire as workspace_unavailable.
            for (int index = 0; index < cases.size(); index++) {
                String physical = UUID.randomUUID().toString()
                        .replace("-", "");
                jdbc.update("INSERT INTO ma_storage (alias_key,"
                        + " tenant_key, storage_key, tenant_id, storage_id,"
                        + " physical_key, storage_kind, registration_state,"
                        + " registration_revision, registration_json) VALUES"
                        + " (?, ?, ?, ?, ?, ?, 'LOCAL', 'REGISTERED', 1,"
                        + " '{}')",
                        JdbcRuntimeBindingRepository.storageAliasKey(tenant,
                                "storage-" + index),
                        JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                        JdbcRuntimeBindingRepository.storageFenceKey(
                                "storage-" + index),
                        tenant, "storage-" + index, physical);
                jdbc.update("INSERT INTO ma_storage_owner (storage_key,"
                        + " physical_key, storage_kind, tenant_id,"
                        + " storage_id, mount_state) VALUES (?, ?, 'LOCAL',"
                        + " ?, ?, 'READY')",
                        physical, physical, tenant, "storage-" + index);
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
        if (letter.equals("fg8b")) {
            installFg8bTriggers(jdbc, tenant, sessions);
        }
        gateServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0),
                0);
        HostedMonitorRunProbe probe = new HostedMonitorRunProbe(jdbc, tenant,
                broker, store, spring.getBean(HarnessEventProjector.class),
                gateServer);
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
            driverConfig.put("cases", sessions);
            driverConfig.put("resultFile", resultFile.toString());
            json.writeValue(config.toFile(), driverConfig);
            Path log = casesRoot.resolve("driver.log");
            Process driver = new ProcessBuilder(node, "--import", "tsx",
                    "integration-tests/helpers/hosted-monitor-run-fault-driver.ts",
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
                assertThat(output).contains(letter.equals("fg8f")
                        ? "FG8_OUTPUT_DELIVERY_OK"
                        : letter.equals("fg8a")
                            ? "FG8_REPLY_LOSS_OK"
                            : letter.equals("fg8b")
                                ? "FG8_STORE_FAILURE_OK"
                                : letter.equals("fg8d")
                                    ? "FG8_CANCEL_DRAIN_OK"
                                    : "FG8_STREAM_GAPS_OK");
                JsonNode reports = json.readTree(
                        Files.readString(resultFile));
                assertThat(reports).hasSize(cases.size());
                for (int index = 0; index < cases.size(); index++) {
                    assertCase(letter, jdbc, tenant, sessions.get(index),
                            reports.get(index));
                }
            } finally {
                // The triggers must go down on the failure path too: an
                // armed BEFORE INSERT survives for the rest of the fork.
                if (letter.equals("fg8b")) {
                    dropFg8bTriggers(jdbc);
                }
                driver.descendants()
                        .forEach(process -> process.destroyForcibly());
                if (driver.isAlive()) {
                    driver.destroyForcibly();
                }
            }
        }
    }

    // FG8b's fault source: a test-only trigger per case, scoped to that
    // case's session rows, permanently refusing the case's commit kind
    // inside a real transaction — a fire-once-then-disarm arm would let
    // the next commit heal over the very blocking the issue gates. Each
    // fire also writes fg8b_fire (MyISAM, so the row survives the
    // signalled rollback): the broker flattens this SQLException into
    // runtime_broker_internal_error, so unlike FG7B the marker text never
    // reaches captured output and the fire count is the attribution.
    private void installFg8bTriggers(JdbcTemplate jdbc, String tenant,
            List<Map<String, Object>> sessions) {
        fg8bTriggers = new ArrayList<>();
        jdbc.execute("CREATE TABLE fg8b_fire (case_name VARCHAR(64)"
                + " NOT NULL, fired_at TIMESTAMP(6) NOT NULL DEFAULT"
                + " CURRENT_TIMESTAMP(6)) ENGINE = MyISAM");
        for (Map<String, Object> session : sessions) {
            String name = session.get("name").toString();
            String sessionId = session.get("sessionId").toString();
            String table;
            String condition;
            String marker;
            switch (name) {
                case "invocation-commit":
                    table = "ma_tool_execution";
                    condition = "NEW.harness_session_id = '" + sessionId
                            + "' AND NEW.execution_call_id NOT LIKE"
                            + " '%:process'";
                    marker = "FG8B_INVOCATION_COMMIT";
                    break;
                case "process-ledger-commit":
                    table = "ma_tool_execution";
                    condition = "NEW.harness_session_id = '" + sessionId
                            + "' AND NEW.execution_call_id LIKE '%:process'";
                    marker = "FG8B_PROCESS_LEDGER_COMMIT";
                    break;
                case "manifest-commit":
                    table = "ma_resource";
                    // The capture's prepare publishes an initial empty
                    // manifest (executionStatus 'unknown'); it must land,
                    // or the worker never starts. The arm targets the
                    // manifest that closes the run: a settled execution.
                    condition = "NEW.session_id = '" + sessionId
                            + "' AND NEW.kind"
                            + " = 'managed-tool-result-manifest'"
                            + " AND CONVERT(NEW.inline_bytes USING utf8mb4)"
                            + " LIKE '%\"executionStatus\":\"success\"%'";
                    marker = "FG8B_MANIFEST_COMMIT";
                    break;
                case "page-envelope-commit":
                    table = "ma_resource";
                    condition = "NEW.session_id = '" + sessionId
                            + "' AND NEW.kind = 'managed-tool-result-page'";
                    marker = "FG8B_PAGE_ENVELOPE_COMMIT";
                    break;
                default:
                    throw new IllegalStateException(name);
            }
            String trigger = "fg8b_"
                    + UUID.randomUUID().toString().replace("-", "");
            fg8bTriggers.add(trigger);
            // ma_tool_execution has no tenant column: the session scope
            // inside each condition is the fence.
            jdbc.execute("CREATE TRIGGER " + trigger + " BEFORE INSERT ON "
                    + table + " FOR EACH ROW BEGIN IF " + condition
                    + " THEN INSERT INTO fg8b_fire (case_name) VALUES ('"
                    + name + "'); SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT"
                    + " = '" + marker + "'; END IF; END");
        }
    }

    private void dropFg8bTriggers(JdbcTemplate jdbc) {
        if (fg8bTriggers != null) {
            for (String trigger : fg8bTriggers) {
                jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
            }
            fg8bTriggers = null;
        }
        jdbc.execute("DROP TABLE IF EXISTS fg8b_fire");
    }

    private void assertCase(String letter, JdbcTemplate jdbc, String tenant,
            Map<String, Object> session, JsonNode report) throws Exception {
        switch (letter) {
            case "fg8a" -> assertReplyLossCase(jdbc, tenant, session, report);
            case "fg8b" -> assertStoreFailureCase(jdbc, tenant, session,
                    report);
            case "fg8d" -> assertCancelDrainCase(jdbc, tenant, session,
                    report);
            default -> assertStreamPublishCase(letter, jdbc, tenant, session,
                    report);
        }
    }

    private void assertReplyLossCase(JdbcTemplate jdbc, String tenant,
            Map<String, Object> session, JsonNode report) throws Exception {
        String sessionId = session.get("sessionId").toString();
        String name = session.get("name").toString();
        // Reply loss always resolves through the original execution
        // identity: exactly one physical process per dispatch, proven by
        // exactly one `:process` row in the execution ledger.
        assertProcessRows(jdbc, sessionId, name, 1);
        switch (name) {
            case "dispatch-reply" -> {
                assertThat(report.path("brokerDropped").asInt())
                        .as(name + " dropped exactly one :start reply")
                        .isEqualTo(1);
                assertThat(report.path("brokerStartedForwards").asInt())
                        .as(name + ": the original identity admitted once")
                        .isEqualTo(1);
                JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                        "child_run");
                // A lost :start reply must not mint a second identity: the
                // run is settled either from real exit evidence (a cgroup
                // runtime) or as an honest not-start where no process could
                // be isolated (this Runtime is not a Linux + cgroup v2
                // host). What is forbidden is a fabricated outcome.
                String stopReason = record.path("stopReason").asText();
                if ("start_failed".equals(stopReason)) {
                    assertThat(record.path("run").path("state").asText())
                            .isEqualTo("failed");
                    assertThat(record.path("run").path("execution").asText())
                            .isEqualTo("not_started_proven");
                    assertThat(record.path("startReceiptRef").isNull())
                            .isTrue();
                } else {
                    assertThat(record.path("run").path("state").asText())
                            .as(name + " settled from real exit evidence")
                            .isEqualTo("settled");
                    assertThat(stopReason).isEqualTo("exited");
                    assertThat(record.path("exitCode").asInt()).isZero();
                    assertThat(record.path("startReceiptRef").isNull())
                            .isFalse();
                }
            }
            case "monitor-stop-reply" -> {
                assertThat(report.path("brokerDropped").asInt())
                        .as(name + " dropped exactly one monitor-stop reply")
                        .isEqualTo(1);
                assertThat(report.path("brokerMonitorStopForwards")
                        .asInt()).as(name + ": exactly one physical stop")
                        .isEqualTo(1);
                JsonNode watch = extensionRecord(jdbc, tenant, sessionId,
                        "monitor_run");
                assertThat(watch.path("stopReason").asText())
                        .as(name + " settled from real exit evidence")
                        .isEqualTo("max_events");
                assertThat(watch.path("observationSequence").asInt())
                        .isEqualTo(watch.path("maxEvents").asInt());
                assertThat(watch.path("notifiedThrough").asInt())
                        .isEqualTo(watch.path("observationSequence").asInt());
            }
            case "capture-commit-reply" -> {
                assertThat(report.path("droppedPagePublishes").asInt())
                        .as(name + " dropped exactly one page publish reply")
                        .isEqualTo(1);
                JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                        "child_run");
                assertThat(record.path("run").path("state").asText())
                        .as(name + " settled from real exit evidence")
                        .isEqualTo("settled");
                assertThat(record.path("stopReason").asText())
                        .isEqualTo("exited");
                assertThat(record.path("exitCode").asInt()).isZero();
                // The re-driven publish is idempotent: the existing chain
                // walk already refuses duplicated pages or revisions.
                verifyOutputChain(jdbc, tenant, sessionId, true);
            }
            case "observation-advance-reply" -> {
                var droppedOps = new ArrayList<String>();
                report.path("droppedCommitOps")
                        .forEach(node -> droppedOps.add(node.asText()));
                assertThat(droppedOps)
                        .as(name + " dropped exactly one observation commit")
                        .containsExactly("commitMonitorRun");
                JsonNode watch = extensionRecord(jdbc, tenant, sessionId,
                        "monitor_run");
                assertThat(watch.path("observationSequence").asInt())
                        .as(name + " stayed behind, then landed")
                        .isEqualTo(watch.path("maxEvents").asInt());
                assertThat(watch.path("notifiedThrough").asInt())
                        .isEqualTo(watch.path("observationSequence").asInt());
                assertThat(watch.path("stopReason").asText())
                        .isEqualTo("max_events");
            }
            default -> throw new IllegalStateException(name);
        }
    }

    private void assertStoreFailureCase(JdbcTemplate jdbc, String tenant,
            Map<String, Object> session, JsonNode report) throws Exception {
        String sessionId = session.get("sessionId").toString();
        String name = session.get("name").toString();
        // Attribution first: the rejections this case watched must come
        // from this case's own trigger. A trigger that silently never
        // armed goes red here, not on an outcome (the broker's flattened
        // runtime_broker_internal_error carries no marker text).
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM fg8b_fire WHERE case_name = ?",
                Integer.class, name))
                .as(name + ": the case trigger really fired").isPositive();
        switch (name) {
            case "invocation-commit" -> {
                // The admission's INSERT was rejected inside a real
                // transaction: there can be no invocation row, no `:process`
                // row, and no physical process.
                assertThat(report.path("bgStarted").asBoolean())
                        .as(name + ": a physical process never existed")
                        .isFalse();
                assertThat(report.path("executions").size())
                        .as(name + ": no invocation row either").isZero();
            }
            case "process-ledger-commit" -> {
                assertThat(report.path("bgStarted").asBoolean())
                        .as(name + ": a physical process never existed")
                        .isFalse();
                // The reservation committed before the rejected ledger
                // insert, so an invocation row may exist; what must never
                // exist is its `:process` suffix.
            }
            case "manifest-commit", "page-envelope-commit" -> {
                assertThat(report.path("bgStarted").asBoolean())
                        .as(name + ": the admitted run exists").isTrue();
                assertThat(report.path("brokerStartAttempts").asInt())
                        .as(name + ": never re-executed to recover")
                        .isEqualTo(1);
            }
            default -> throw new IllegalStateException(name);
        }
        if (name.equals("invocation-commit")
                || name.equals("process-ledger-commit")) {
            assertProcessRows(jdbc, sessionId, name, 0);
            return;
        }
        // What a refused publication commit does to the run depends on
        // which commit the arm targets. A refused OUTPUT MANIFEST commit
        // is the settle transaction's own head — the fused settle commit
        // rolls back whole, so the run stays blocked open with the
        // process long gone and its exit evidence unjournaled (the
        // issue's "blocks the run" cell, measured on lane run
        // 38868090681: three refused settle commits, then silence —
        // including through a drain release). A refused page-envelope
        // commit poisons the capture alone: the record settles from real
        // exit evidence with the envelope degraded — never cancelled,
        // never re-executed.
        assertProcessRows(jdbc, sessionId, name, 1);
        JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                "child_run");
        if (name.equals("manifest-commit")) {
            assertThat(report.path("recovered").asBoolean())
                    .as(name + ": a refused settle commit never recovers")
                    .isFalse();
            assertThat(record.path("run").path("state").asText())
                    .as(name + ": the blocked commit keeps the run open")
                    .isEqualTo("running");
            assertThat(record.path("stopReason").isNull())
                    .as(name + ": no stop proof was ever journaled")
                    .isTrue();
            assertThat(record.path("stopRequested").asBoolean(false))
                    .as(name + ": nothing ever asked it to stop")
                    .isFalse();
            // The finalize manifest (executionStatus 'success') is the
            // arm's target and never persisted; the initial empty
            // manifest is what keeps the read chain honest.
            var settleManifests = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM ma_resource WHERE tenant_id = ?"
                            + " AND session_id = ? AND kind ="
                            + " 'managed-tool-result-manifest' AND"
                            + " CONVERT(inline_bytes USING utf8mb4) LIKE"
                            + " '%\"executionStatus\":\"success\"%'",
                    Integer.class, tenant, sessionId);
            assertThat(settleManifests).as(name
                    + ": the settle-manifest commit was rejected")
                    .isZero();
        } else {
            assertThat(report.path("recovered").asBoolean())
                    .as(name + ": the producer exited naturally").isTrue();
            assertThat(record.path("run").path("state").asText())
                    .as(name + ": settles from real exit evidence")
                    .isEqualTo("settled");
            assertThat(record.path("stopReason").asText())
                    .isEqualTo("exited");
            assertThat(record.path("exitCode").asInt()).isZero();
            assertThat(record.path("stopRequested").asBoolean(false))
                    .as(name + ": nothing ever asked it to stop")
                    .isFalse();
            assertThat(jdbc.queryForObject(
                    "SELECT COUNT(*) FROM ma_resource WHERE tenant_id = ?"
                            + " AND session_id = ? AND kind ="
                            + " 'managed-tool-result-page'",
                    Integer.class, tenant, sessionId))
                    .as(name + ": every page-envelope commit was rejected")
                    .isZero();
        }
        // Whatever manifests did commit (the initial empty one, and in
        // the process-ledger variant reserved ones) may never name a
        // page envelope that is not persisted — the read chain's own
        // refusal, asserted here over JDBC rather than on outcomes.
        var dangling = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource m WHERE m.tenant_id = ?"
                        + " AND m.session_id = ? AND m.kind ="
                        + " 'managed-tool-result-manifest' AND"
                        + " CONVERT(m.inline_bytes USING utf8mb4) LIKE"
                        + " '%\"pages\":[{%' AND NOT EXISTS (SELECT 1"
                        + " FROM ma_resource p WHERE p.tenant_id ="
                        + " m.tenant_id AND p.session_id = m.session_id"
                        + " AND p.kind = 'managed-tool-result-page')",
                Integer.class, tenant, sessionId);
        assertThat(dangling).as(name
                + ": no manifest names an unpersisted page").isZero();
    }

    private void assertCancelDrainCase(JdbcTemplate jdbc, String tenant,
            Map<String, Object> session, JsonNode report) throws Exception {
        String sessionId = session.get("sessionId").toString();
        String name = session.get("name").toString();
        JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                "child_run");
        switch (name) {
            case "cancel-before-start" -> {
                assertProcessRows(jdbc, sessionId, name, 0);
                assertThat(report.path("bgStarted").asBoolean())
                        .as(name + ": zero OS effects").isFalse();
                assertThat(record.path("run").path("state").asText())
                        .as(name + " settles cancelled, never exited")
                        .isNotEqualTo("settled");
            }
            case "routine-release-refusal" -> {
                assertProcessRows(jdbc, sessionId, name, 1);
                assertThat(record.path("run").path("state").asText())
                        .as(name
                                + ": the refusal stopped nothing, natural exit")
                        .isEqualTo("settled");
                assertThat(record.path("stopReason").asText())
                        .isEqualTo("exited");
                assertThat(record.path("exitCode").asInt()).isZero();
            }
            case "drain-release", "cancel-during-capture",
                    "cancel-status-unavailable" -> {
                assertProcessRows(jdbc, sessionId, name, 1);
                assertThat(record.path("stopRequested").asBoolean())
                        .as(name + " carried the stop marker").isTrue();
                assertThat(record.path("run").path("state").asText())
                        .as(name + " settles cancelled").isEqualTo(
                                "cancelled");
                assertThat(record.path("stopReason").asText())
                        .isEqualTo("stop_requested");
            }
            case "cancel-reply-lost" -> {
                assertProcessRows(jdbc, sessionId, name, 1);
                assertThat(report.path("droppedCancelReply").asBoolean())
                        .as(name + " dropped exactly one cancel reply")
                        .isTrue();
                assertThat(record.path("stopRequested").asBoolean())
                        .isTrue();
                assertThat(record.path("run").path("state").asText())
                        .isEqualTo("cancelled");
                assertThat(record.path("stopReason").asText())
                        .isEqualTo("stop_requested");
            }
            default -> throw new IllegalStateException(name);
        }
        // A run the platform stopped is never settled as `exited` — and a
        // natural exit only ever records its own exit, which is why this
        // invariant is letter-wide rather than per-case wording.
        if (record.path("run").path("state").asText().equals("cancelled")) {
            assertThat(record.path("stopReason").asText())
                    .as(name + ": a platform stop never reads as exited")
                    .isNotEqualTo("exited");
        }
    }

    private void assertProcessRows(JdbcTemplate jdbc, String sessionId,
            String name, int expected) {
        Integer processes = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_tool_execution WHERE"
                        + " harness_session_id = ? AND execution_call_id LIKE"
                        + " '%:process'",
                Integer.class, sessionId);
        assertThat(processes).as(name + " :process rows")
                .isEqualTo(expected);
    }

    private void assertStreamPublishCase(String letter, JdbcTemplate jdbc,
            String tenant, Map<String, Object> session, JsonNode report)
            throws Exception {
        String sessionId = session.get("sessionId").toString();
        String name = session.get("name").toString();
        assertThat(report.path("case").asText()).isEqualTo(name);
        boolean monitor = name.contains("monitor");
        // The capability's own identity: exactly one physical process was
        // ever admitted for the dispatch. The broker's `:process` row is
        // PREPARED for the process's whole life and settles only on the next
        // observation — never synchronously with the run's own settle — so
        // the settled assertion here belongs to the record, not the row.
        var processes = jdbc.queryForList(
                "SELECT execution_call_id, execution_state, execution_status"
                        + " FROM ma_tool_execution WHERE harness_session_id"
                        + " = ? AND execution_call_id LIKE '%:process'",
                sessionId);
        assertThat(processes).as(name + " process rows").hasSize(1);
        if (letter.equals("fg8f")) {
            assertPublishCase(jdbc, tenant, sessionId, name, report);
            return;
        }
        // The public projection is complete: every stream frame the client
        // saw is a committed row, and the row count matches exactly. The
        // SESSION-stream filter mirrors the serving query — a child task's
        // state_changed audit rows share the sequence space but are never
        // streamed.
        Integer events = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_public_event WHERE stream_kind ="
                        + " 'SESSION' AND stream_id = X'' AND tenant_id = ?"
                        + " AND session_id = ?", Integer.class, tenant,
                sessionId);
        assertThat(events).as(name + " projected events").isNotNull();
        assertThat(report.path("frames").size())
                .as(name + " stream frames == ledger rows")
                .isEqualTo(events.intValue());
        if (monitor) {
            JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                    "monitor_run");
            assertThat(record.path("stopReason").asText())
                    .as(name + " watch settled at its quota")
                    .isEqualTo("max_events");
            assertThat(record.path("observationSequence").asInt())
                    .isEqualTo(record.path("maxEvents").asInt());
            assertThat(record.path("notifiedThrough").asInt())
                    .as(name + " every observation was notified")
                    .isEqualTo(record.path("observationSequence").asInt());
        } else {
            // The background run settled from real exit evidence: the record
            // carries the physical exit, the process is provably gone.
            JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                    "child_run");
            JsonNode run = record.path("run");
            assertThat(run.path("state").asText())
                    .as(name + " child_run record settled").isEqualTo("settled");
            assertThat(record.path("stopReason").asText())
                    .as(name + " settled as a real exit, never a fabricated one")
                    .isEqualTo("exited");
            assertThat(record.path("exitCode").asInt()).isZero();
            assertThat(record.path("startReceiptRef").isNull())
                    .as(name + " start receipt persisted").isFalse();
        }
    }

    // FG8f per-case ground truth over JDBC: the output chain (manifest →
    // pages → segments) is re-proved envelope by envelope, and every
    // segment's byte-identity is pinned against the producer's
    // deterministic block pattern by digest — no bytes move gate-side.
    private void assertPublishCase(JdbcTemplate jdbc, String tenant,
            String sessionId, String name, JsonNode report)
            throws Exception {
        if (name.equals("publisher-kill-mid-capture")) {
            JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                    "child_run");
            // Nothing may fabricate a settle for a run whose publisher
            // died: the record stays running, and the manifest the record
            // quotes is a committed one.
            assertThat(record.path("run").path("state").asText())
                    .as(name + " record never fabricated a settle")
                    .isEqualTo("running");
            assertThat(record.path("outputRef").isNull())
                    .as(name + " forwarded a manifest").isFalse();
            assertThat(report.path("recordState").asText())
                    .isEqualTo("running");
            assertThat(report.path("committedSegments").asInt())
                    .as(name + " committed segments at the kill")
                    .isGreaterThanOrEqualTo(3);
            verifyOutputChain(jdbc, tenant, sessionId, false);
            return;
        }
        JsonNode record = extensionRecord(jdbc, tenant, sessionId,
                "child_run");
        JsonNode run = record.path("run");
        assertThat(run.path("state").asText())
                .as(name + " child_run record settled").isEqualTo("settled");
        assertThat(record.path("stopReason").asText())
                .as(name + " settled as a real exit").isEqualTo("exited");
        assertThat(record.path("exitCode").asInt()).isZero();
        if (name.equals("in-flight-cap")) {
            assertThat(report.path("stallBlocks").asInt())
                    .as(name + " pause watermark stall point")
                    .isBetween(15, 18);
            // Resume re-arms at the 4 MiB watermark: the producer moves
            // again while the stalled backlog is still draining. A
            // resume-at-empty regression would read == stallBlocks.
            assertThat(report.path("committedAtResume").asInt())
                    .as(name + " resume re-armed before the drain emptied")
                    .isLessThan(report.path("stallBlocks").asInt());
        } else {
            assertThat(report.path("droppedCommits").asInt())
                    .as(name + " dropped exactly one commit reply")
                    .isEqualTo(1);
            // Not just *a* commit: the drop must have hit the settle
            // cascade's manifest commit — the child_run record's settle
            // commit carries the output manifest. A positional misdrop
            // into an unrelated journal commit goes red here instead of
            // passing on the count alone.
            assertThat(report.path("droppedOp").asText())
                    .as(name + " the dropped reply is the manifest commit")
                    .isEqualTo("commitChildRunRecord");
            // The re-drive resolving by the original identity is proven by
            // the Session's writer still committing: a post-drop turn ran
            // to its settleTurn commit. A re-drive minting a fresh
            // identity would wedge the writer against the landed original
            // and no later commit would land.
            assertThat(report.path("postDropSettled").asBoolean())
                    .as(name + " writer still commits after the drop")
                    .isTrue();
        }
        verifyOutputChain(jdbc, tenant, sessionId, true);
    }

    /** The committed tool-result rows of one Session, loaded once. */
    private record OutputRows(Map<String, Map<String, Object>> byId,
            Map<String, JsonNode> bodies, List<JsonNode> manifests) {}

    private record CaptureOutcome(int segments, int fullRows, int seals) {}

    private OutputRows loadOutputRows(JdbcTemplate jdbc, String tenant,
            String sessionId) throws Exception {
        var byId = new HashMap<String, Map<String, Object>>();
        for (var row : jdbc.queryForList(
                "SELECT resource_id, kind, byte_length, sha256 FROM"
                        + " ma_resource WHERE tenant_id = ?"
                        + " AND session_id = ? AND kind LIKE"
                        + " 'managed-tool-result-%'", tenant, sessionId)) {
            byId.put(row.get("resource_id").toString(), row);
        }
        var bodies = new HashMap<String, JsonNode>();
        for (var row : jdbc.queryForList(
                "SELECT resource_id, CONVERT(inline_bytes USING utf8mb4) AS"
                        + " body FROM ma_resource WHERE"
                        + " tenant_id = ? AND session_id = ? AND (kind IN"
                        + " ('managed-tool-result-manifest',"
                        + " 'managed-tool-result-page') OR (kind ="
                        + " 'managed-tool-result-content' AND byte_length <"
                        + " 1024))", tenant, sessionId)) {
            String body = row.get("body").toString();
            // The producers' short tail segment is raw bytes, not JSON;
            // only envelopes (manifest, page, seal) are parsed here — the
            // tail's byte-identity is proven by its digest in the prefix
            // walk below.
            if (!body.startsWith("{")) {
                continue;
            }
            bodies.put(row.get("resource_id").toString(),
                    json.readTree(body));
        }
        return new OutputRows(byId, bodies, bodies.values().stream()
                .filter(node -> node.path("type").asText().equals("manifest"))
                .toList());
    }

    private void verifyOutputChain(JdbcTemplate jdbc, String tenant,
            String sessionId, boolean complete) throws Exception {
        OutputRows rows = loadOutputRows(jdbc, tenant, sessionId);
        assertThat(rows.manifests()).as("manifest revisions").isNotEmpty();
        // One run is one capture: group the manifest revisions by theirs.
        var byCapture = new LinkedHashMap<String, List<JsonNode>>();
        for (JsonNode manifest : rows.manifests()) {
            byCapture.computeIfAbsent(manifest.path("captureId").asText(),
                    key -> new ArrayList<>()).add(manifest);
        }
        assertThat(byCapture.keySet()).as("one capture").hasSize(1);
        var outcome = verifyCapture(rows,
                byCapture.values().iterator().next(), "capture",
                complete
                        ? HostedMonitorRunFaultGatesIT::runOneDigest
                        : HostedMonitorRunFaultGatesIT::blockDigest,
                complete, 24L * SEGMENT_BYTES + 18, complete ? 25 : -1,
                complete ? 24 : -1);
        if (!complete) {
            // The killed capture never sealed: every committed content row
            // is a full block of the paced producer.
            assertThat(outcome.fullRows())
                    .as("contiguous full-segment prefix")
                    .isEqualTo(outcome.segments());
        }
        // Nothing unaccounted: every content row of the Session is either a
        // segment reachable from the contiguous prefix walk or a seal (a
        // complete capture seals stdout and the empty stderr alike).
        long contentRows = rows.byId().values().stream()
                .filter(row -> row.get("kind")
                        .equals("managed-tool-result-content"))
                .count();
        assertThat(contentRows).as("no unaccounted content rows")
                .isEqualTo(outcome.segments() + outcome.seals());
    }

    private CaptureOutcome verifyCapture(OutputRows rows,
            List<JsonNode> manifests, String label,
            IntFunction<String> expectedDigest, boolean complete,
            long expectedTotalBytes, int expectedSegments,
            int expectedFullRows) {
        String captureId = manifests.getFirst().path("captureId").asText();
        // One capture identity: no revision number repeats — a re-drive
        // never mints a second manifest for one slot.
        var revisions = new HashSet<Integer>();
        for (JsonNode manifest : manifests) {
            assertThat(revisions.add(manifest.path("revision").asInt()))
                    .as(label + ": one manifest per revision").isTrue();
            // A manifest never names an unpersisted page.
            for (JsonNode content : manifest.path("contents")) {
                for (JsonNode page : content.path("body").path("pages")) {
                    JsonNode ref = page.path("ref");
                    var pageRow = rows.byId().get(
                            ref.path("resourceId").asText());
                    assertThat(pageRow)
                            .as(label
                                    + ": manifest names only persisted pages")
                            .isNotNull();
                    assertThat(pageRow.get("kind"))
                            .isEqualTo("managed-tool-result-page");
                    assertThat(pageRow.get("sha256").toString())
                            .isEqualTo(ref.path("digest").asText());
                    assertThat(((Number) pageRow.get("byte_length"))
                            .longValue())
                            .isEqualTo(ref.path("byteLength").asLong());
                }
            }
        }
        // Every committed segment is byte-identical to the producer's
        // pattern at its ordinal: the content-addressed resourceId fixes
        // the ordinal, so a gap or a reordering cannot hide.
        int segments = 0;
        int fullRows = 0;
        while (rows.byId().containsKey(
                segmentId(captureId, "stdout", segments))) {
            var row = rows.byId().get(
                    segmentId(captureId, "stdout", segments));
            assertThat(row.get("kind"))
                    .isEqualTo("managed-tool-result-content");
            assertThat(row.get("sha256").toString())
                    .as(label + ": segment %d is byte-identical", segments)
                    .isEqualTo(expectedDigest.apply(segments));
            if (((Number) row.get("byte_length")).intValue()
                    == SEGMENT_BYTES) {
                fullRows++;
            }
            segments++;
        }
        if (expectedSegments >= 0) {
            assertThat(segments).as(label + ": segments")
                    .isEqualTo(expectedSegments);
        }
        if (expectedFullRows >= 0) {
            assertThat(fullRows).as(label + ": full segments")
                    .isEqualTo(expectedFullRows);
        }
        // The latest revision's descriptors walk their own pages: the
        // envelopes chain in ordinal order and every named segment is a
        // persisted row with the manifest's digest. A complete capture
        // seals every stream — stdout and the empty stderr alike.
        JsonNode latest = manifests.stream()
                .max(Comparator.comparingInt(
                        node -> node.path("revision").asInt()))
                .orElseThrow();
        var seenPages = new HashSet<String>();
        int seals = 0;
        for (JsonNode content : latest.path("contents")) {
            String streamId = content.path("streamId").asText();
            if (!streamId.equals("stdout")) {
                assertThat(content.path("byteLength").asLong()).isZero();
                if (complete) {
                    assertThat(content.path("state").asText())
                            .isEqualTo("sealed");
                    assertThat(rows.byId().containsKey(
                            segmentId(captureId, streamId, "seal")))
                            .as(label + ": the empty stream sealed too")
                            .isTrue();
                    seals++;
                }
                continue;
            }
            int expectedOrdinal = 0;
            long total = 0;
            for (JsonNode page : content.path("body").path("pages")) {
                assertThat(seenPages.add(streamId + ":"
                        + page.path("firstOrdinal").asInt()))
                        .as(label + ": no duplicated pages").isTrue();
                JsonNode pageBody = rows.bodies().get(
                        page.path("ref").path("resourceId").asText());
                assertThat(pageBody.path("captureId").asText())
                        .isEqualTo(captureId);
                assertThat(pageBody.path("streamId").asText())
                        .isEqualTo(streamId);
                assertThat(pageBody.path("firstOrdinal").asInt())
                        .as(label + ": pages chain in ordinal order")
                        .isEqualTo(expectedOrdinal);
                for (JsonNode segment : pageBody.path("segments")) {
                    int ordinal = expectedOrdinal++;
                    var segmentRow = rows.byId().get(
                            segmentId(captureId, streamId, ordinal));
                    assertThat(segmentRow)
                            .as(label
                                    + ": page names only persisted segments")
                            .isNotNull();
                    assertThat(segmentRow.get("sha256").toString())
                            .isEqualTo(segment.path("digest").asText());
                    total += segment.path("byteLength").asLong();
                }
            }
            assertThat(content.path("byteLength").asLong())
                    .isEqualTo(total);
            if (complete) {
                assertThat(content.path("state").asText())
                        .isEqualTo("sealed");
                assertThat(total).isEqualTo(expectedTotalBytes);
                var seal = rows.byId().get(
                        segmentId(captureId, streamId, "seal"));
                assertThat(seal).as(label + ": seal resource").isNotNull();
                JsonNode sealBody = rows.bodies().get(
                        seal.get("resource_id").toString());
                assertThat(sealBody.path("byteLength").asLong())
                        .isEqualTo(total);
                assertThat(sealBody.path("digest").asText())
                        .isEqualTo(content.path("digest").asText());
                seals++;
            }
        }
        if (complete) {
            assertThat(latest.path("executionStatus").asText())
                    .isEqualTo("success");
            assertThat(latest.path("exitCode").asInt()).isZero();
            assertThat(latest.path("captureStatus").asText())
                    .isEqualTo("complete");
        }
        return new CaptureOutcome(segments, fullRows, seals);
    }

    private static final int SEGMENT_BYTES = 1024 * 1024;
    private static final int PRODUCER_BLOCKS = 24;

    // The driver's producer pattern, gate-side: block i is one segment of
    // the cyclically repeated index line (Buffer.alloc fill semantics).
    private static String blockDigest(int ordinal) {
        byte[] unit = String.format("FG8B%08d;", ordinal)
                .getBytes(StandardCharsets.UTF_8);
        byte[] block = new byte[SEGMENT_BYTES];
        for (int index = 0; index < block.length; index++) {
            block[index] = unit[index % unit.length];
        }
        return sha256Hex(block);
    }

    // Run 1's finite producers append the done line as the tail segment.
    private static String runOneDigest(int ordinal) {
        if (ordinal == PRODUCER_BLOCKS) {
            return sha256Hex("FG8_PRODUCER_DONE\n"
                    .getBytes(StandardCharsets.UTF_8));
        }
        return blockDigest(ordinal);
    }

    // The store's content-addressed segment resourceId: sha256 of the JSON
    // triple [captureId, streamId, ordinal-or-"seal"].
    private static String segmentId(String captureId, String streamId,
            Object ordinal) {
        String suffix = ordinal instanceof String
                ? "\"" + ordinal + "\"" : ordinal.toString();
        return sha256Hex(("[\"" + captureId + "\",\"" + streamId + "\","
                + suffix + "]").getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private JsonNode extensionRecord(JdbcTemplate jdbc, String tenant,
            String sessionId, String domain) throws Exception {
        var rows = jdbc.queryForList(
                "SELECT record_resource_id FROM"
                        + " ma_session_record WHERE"
                        + " tenant_id = ? AND session_id = ? AND domain = ?",
                tenant, sessionId, domain);
        assertThat(rows).as(domain + " records").hasSize(1);
        var resources = jdbc.queryForList(
                "SELECT CONVERT(inline_bytes USING utf8mb4) AS body FROM"
                        + " ma_resource WHERE tenant_id = ?"
                        + " AND session_id = ? AND resource_id = ?", tenant,
                sessionId, rows.getFirst().get("record_resource_id"));
        assertThat(resources).hasSize(1);
        return json.readTree(resources.getFirst().get("body").toString());
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
