package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
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

// FG8 (issue #14054): multi-process fault gates for monitor_run and the
// child_run shell kind — the capabilities #13889 enabled without a fault
// round. FG8e gates SSE continuity across abort/resume while a background
// run or a monitor watch keeps progressing; FG8f gates background output
// delivery under publisher loss. Real packaged Harness, real MySQL, JDBC
// ground truth; no production code changes. Slice 1 lands e and f; a–d
// land behind their in-flight prerequisites per the design doc.
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
                        ? "FG8_OUTPUT_DELIVERY_OK" : "FG8_STREAM_GAPS_OK");
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
                "../../../dist/cli.js")).toAbsolutePath().normalize();
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
