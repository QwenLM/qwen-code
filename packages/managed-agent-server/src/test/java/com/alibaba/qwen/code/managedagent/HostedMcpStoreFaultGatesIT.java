package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.FaultingExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore;
import com.alibaba.qwen.code.managedagent.store.StoreFaultGate;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

// FG12b (issue #14447): the Hosted MCP store-failure gates. A test-only
// wrapper around the Session record store rejects one step of the MCP record
// state machine inside the real commit transaction, so each case observes
// what a rejected durable write really leaves behind. The Harness, durable
// worker and stdio fixture boot the way the FG12c class boots them; this
// class runs on MySQL 8.0.46 locally and MySQL 8.4.6 in CI, and MariaDB
// cannot run it at all. FG12c's own cases stay in their class.
class HostedMcpStoreFaultGatesIT {
    private static final String PROFILE = "hosted-workspace-mcp/1";
    private static final String CASE_LETTER = "fg12b";
    private String caseLetter = CASE_LETTER;
    private static final String TOKEN = "extension-process-fixture-token";
    private static final String CAPABILITY = "sha256:" + "a".repeat(64);
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String tenant = "mcp-restart-" + UUID.randomUUID();
    private final List<ProxyCall> proxyCalls = new CopyOnWriteArrayList<>();
    private final java.util.concurrent.atomic.AtomicInteger proxySequence =
            new java.util.concurrent.atomic.AtomicInteger();
    private final java.util.concurrent.atomic.AtomicInteger wireSequence =
            new java.util.concurrent.atomic.AtomicInteger();
    private int controlBaseline;
    private int wireBaseline;
    private final List<Map<String, Object>> wire = new CopyOnWriteArrayList<>();
    private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
    private final ExecutorService caseExecutor =
            Executors.newVirtualThreadPerTaskExecutor();
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;
    private Path cli;
    private Path workspace;
    private Path evidence;
    private Path home;
    private Path configHome;
    private String node;
    private String mcpDigest;
    private int port;
    private int harnessPort;
    private int brokerPort;
    private String bootId;
    private HttpServer model;
    private ExecutorService modelExecutor;
    private HttpServer brokerProxy;
    private ServletWebServerApplicationContext spring;
    private JdbcTemplate jdbc;
    private ManagedAgentStore store;
    private Process harness;

    @BeforeEach
    void boot() throws Exception {
        StoreFaultGate.INSTANCE.clear();
        assertThat(System.getProperty("mysql.url"))
                .as("FG12b requires a disposable MySQL")
                .startsWith("jdbc:mysql:");
        node = System.getProperty("node.executable");
        assertThat(node).isNotBlank();
        cli = Path.of(System.getProperty("qwen.cli.entry",
                "../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        temporary = temporary.toRealPath();
        workspace = Files.createDirectories(
                temporary.resolve("workspace/child"));
        Files.setLastModifiedTime(workspace.getParent(),
                FileTime.fromMillis(1));
        Files.createDirectory(temporary.resolve("decoy"));
        Files.createDirectory(temporary.resolve("broker"),
                PosixFilePermissions.asFileAttribute(
                        PosixFilePermissions.fromString("rwx------")));
        evidence = temporary.resolve("processes.jsonl");
        Path program = temporary.resolve("mcp-fault.mjs");
        try (var resource = getClass().getResourceAsStream(
                "/hosted-mcp-fault-process.mjs")) {
            assertThat(resource).isNotNull();
            Files.copy(resource, program);
        }
        mcpDigest = DigestUtils.sha256Hex("mcp:" + Files.readString(program));
        List<Map<String, Object>> servers = new java.util.ArrayList<>();
        for (int revision = 1; revision <= 2; revision++) {
            servers.add(Map.of("tenantId", tenant, "workspaceId",
                    "workspace", "serverId", "fixture", "serverRevision",
                    revision, "definitionDigest",
                    DigestUtils.sha256Hex(mcpDigest + revision), "transport",
                    "stdio", "command", node, "args",
                    List.of(program.toString(), "mcp", evidence.toString(),
                            Integer.toString(revision))));
        }
        json.writeValue(temporary.resolve("mcp.json").toFile(),
                Map.of("version", 1, "servers", servers));
        Path worker = temporary.resolve("worker.mjs");
        Files.writeString(worker, "process.env.QWEN_MANAGED_MCP_CONFIG="
                + json.writeValueAsString(
                        temporary.resolve("mcp.json").toString())
                + "; process.argv[1]="
                + json.writeValueAsString(cli.toString())
                + "; await import("
                + json.writeValueAsString(cli.toUri().toString()) + ");\n");
        try (var control = new ServerSocket(0, 1,
                InetAddress.getByName("127.0.0.1"));
                var hosted = new ServerSocket(0, 1,
                        InetAddress.getByName("127.0.0.1"));
                var runtime = new ServerSocket(0, 1,
                        InetAddress.getByName("127.0.0.1"))) {
            port = control.getLocalPort();
            harnessPort = hosted.getLocalPort();
            brokerPort = runtime.getLocalPort();
        }
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        modelExecutor = Executors.newVirtualThreadPerTaskExecutor();
        model.setExecutor(modelExecutor);
        model.createContext("/v1/chat/completions", this::modelReply);
        model.start();
        startSpring();
        startBrokerProxy();
        startHarness();
    }

    // FG12b (issue #14447): an MCP record commit is rejected inside the real
    // Session store transaction. The wrapper records the attempt before it
    // throws, so every case first proves the injection fired, then asserts
    // the durable shape the failure left behind.
    @Test
    @Timeout(600)
    void storeRejectIntentLeavesNoConfigureOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String configuration = uuid();
        storeFault().arm(StoreFaultGate.Phase.INTENT, configuration);
        HttpResponse<String> refused = configure(session, configuration, 2);
        assertThat(refused.statusCode()).isIn(202, 409, 503);
        waitForRejection();
        // A rejected intent never reaches the owner or the wire; the retry
        // chain the store client runs dies at the same phase.
        Thread.sleep(1_000);
        assertThat(controls("mcp-configure")).isEmpty();
        assertThat(fixtureEvents("mcp.start"))
                .as("baseline rev 1 only")
                .hasSize(1);
        assertThat(configurationRecords(session.id()))
                .as("the rejected revision leaves the baseline record")
                .hasSize(1);
        assertThat(configuration(session.id()).path("configRevision").asInt())
                .isEqualTo(1);
        storeFault().clear();
    }

    @Test
    @Timeout(600)
    void storeRejectConfigureDispatchKeepsTheAcquiredOwnerOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String owner = ownerIdentity(session);
        String holder = holderIdentity();
        String configuration = uuid();
        storeFault().arm(StoreFaultGate.Phase.CONFIGURE_DISPATCH,
                configuration);
        HttpResponse<String> refused = configure(session, configuration, 2);
        assertThat(refused.statusCode()).isIn(202, 409, 503);
        waitForRejection();
        Thread.sleep(1_000);
        assertThat(controls("mcp-configure"))
                .as("a dispatch commit refused before the control")
                .isEmpty();
        assertThat(fixtureEvents("mcp.start")).hasSize(1);
        assertThat(owner).isNotBlank();
        assertThat(holder).isNotBlank();
        assertThat(ownerIdentity(session))
                .as("the refused dispatch keeps the exact owner generation")
                .isEqualTo(owner);
        assertThat(holderIdentity())
                .as("the detach has not run, so the same holder stays")
                .isEqualTo(holder);
        storeFault().clear();
    }

    @Test
    @Timeout(600)
    void storeRejectOperationDispatchKeepsTheAcquiredOwnerOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String owner = ownerIdentity(session);
        String holder = holderIdentity();
        String operation = uuid();
        storeFault().arm(StoreFaultGate.Phase.OPERATION_DISPATCH, operation);
        HttpResponse<String> refused = rawRequest("POST", "/session/"
                + session.id() + "/mcp/operations", json.writeValueAsString(
                        operationBody(operation)), session.clientId());
        assertThat(refused.statusCode()).isIn(202, 409, 503);
        waitForRejection();
        Thread.sleep(1_000);
        assertThat(controls("mcp-invoke")).isEmpty();
        assertThat(effects("resource_read")).isEmpty();
        assertThat(owner).isNotBlank();
        assertThat(holder).isNotBlank();
        assertThat(ownerIdentity(session))
                .as("the refused dispatch keeps the exact owner generation")
                .isEqualTo(owner);
        assertThat(holderIdentity())
                .as("the detach has not run, so the same holder stays")
                .isEqualTo(holder);
        storeFault().clear();
    }

    @Test
    @Timeout(600)
    void storeRejectSettledLeavesOneLookupAndAnOrphanResponseOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        JsonNode configuration = configuration(session.id());
        String runtimeSessionId = configuration.path("runtimeSessionId").asText();
        JsonNode configurationPin = configuration.path("run").path("runtime");
        String operation = uuid();
        storeFault().arm(StoreFaultGate.Phase.SETTLED, operation);
        Future<HttpResponse<String>> pending = caseExecutor.submit(
                () -> rawRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", json.writeValueAsString(
                                Map.of("operationId", operation, "serverId",
                                        "fixture", "request", Map.of("kind",
                                                "resource_read", "uri",
                                                "ext://hold"))),
                        session.clientId()));
        waitFor(() -> assertThat(fixtureEvents("mcp.hold")).hasSize(1));
        writeRelease();
        waitFor(() -> assertThat(effects("resource_read"))
                .containsExactly("ext://hold"));
        HttpResponse<String> refused = pending.get(30, TimeUnit.SECONDS);
        assertThat(refused.statusCode()).isIn(202, 409, 503);
        JsonNode held = operations(session.id()).getLast();
        JsonNode operationPin = held.path("run").path("runtime");
        assertThat(held.path("run").path("execution").asText())
                .as("the failed commit leaves the record at dispatch_started")
                .isEqualTo("dispatch_started");
        assertThat(held.path("run").path("state").asText())
                .isNotEqualTo("settled");
        assertThat(held.path("resultRef").isNull())
                .as("the rejected settled commit has no result ref")
                .isTrue();
        // HttpManagedSessionResourceStore.publish only stages bytes; the
        // resource rows are inserted by commitResources inside the rejected
        // transaction, so the response is rolled back. The arguments
        // resource committed at intent survives.
        assertThat(publishedResponses(session.id()))
                .as("the staged response rows roll back with the commit")
                .isZero();
        assertThat(published(session.id(), held.path("argsRef")))
                .as("the arguments committed at intent survive")
                .isNotNull();
        waitForRejection();
        // A persistent 500 latches ManagedSessionAuthority's write failure;
        // a fresh Harness reopens it from the durable store and carries the
        // original operation/runtime pins into the recovery lookup.
        storeFault().clear();
        killHarness();
        SessionRef reopened = reloadPinned(session, runtimeSessionId,
                operation);
        assertThat(configuration(session.id()).path("runtimeSessionId").asText())
                .as("the reopened configuration keeps its runtime session pin")
                .isEqualTo(runtimeSessionId);
        assertThat(configuration(session.id()).path("run").path("runtime"))
                .as("the reopened configuration keeps its runtime generation")
                .isEqualTo(configurationPin);
        assertThat(operations(session.id()).getLast().path("run")
                .path("runtime"))
                .as("the reopened operation keeps its runtime generation")
                .isEqualTo(operationPin);
        long wireBefore = wireSequence.get();
        HttpResponse<String> status = rawStatus(reopened, operation);
        assertThat(status.statusCode()).isIn(200, 503);
        await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            JsonNode settled = operations(session.id()).getLast();
            assertThat(settled.path("run").path("state").asText())
                    .isEqualTo("settled");
            assertThat(settled.path("resultRef").isNull()).isFalse();
        });
        assertThat(controls("mcp-invoke"))
                .as("the follow-up lookup never invokes a second read")
                .hasSize(1);
        assertThat(wire.stream().filter(entry -> ((Number) entry.get("seq"))
                .intValue() > wireBefore).filter(entry -> {
                    JsonNode request = (JsonNode) entry.get("request");
                    return request != null && "mcp-status".equals(request.at(
                            "/operation/kind").asText()) && operation.equals(
                                    request.at("/operation/operationId")
                                            .asText());
                }).count())
                .as("exactly one lookup on the original id")
                .isEqualTo(1);
        assertThat(effects("resource_read")).containsExactly("ext://hold");
        storeFault().clear();
    }

    @Test
    @Timeout(600)
    void storeRejectReleasingResumesTheOriginalReleaseOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String configurationId = configuration(session.id())
                .path("configurationId").asText();
        String releaseId = configurationId + ":release";
        CloseRef close = prepareClose(session);
        storeFault().arm(StoreFaultGate.Phase.RELEASING, configurationId);
        HttpResponse<String> refused = rawLifecycle(session, close.operationId(),
                close.claimGeneration(), "settle_resources");
        assertThat(refused.statusCode()).as("releasing refusal: %s",
                refused.body()).isEqualTo(503);
        waitForRejection();
        assertThat(configuration(session.id()).path("releaseState").asText())
                .as("the rejected releasing commit leaves the record active")
                .isEqualTo("active");
        assertThat(controls("mcp-release"))
                .as("no release is dispatched before its commit")
                .isEmpty();
        storeFault().clear();
        killHarness();
        SessionRef reloaded = reload(session, close.operationId(),
                close.claimGeneration());
        HttpResponse<String> settled = settle(reloaded, close);
        assertThat(settled.statusCode()).as("settle: %s", settled.body())
                .isEqualTo(200);
        assertThat(configuration(session.id()).path("releaseState").asText())
                .isEqualTo("released");
        assertThat(controls("mcp-release")).hasSize(1);
        assertThat(control("mcp-release").operationId()).isEqualTo(releaseId);
        assertThat(controls("mcp-configure")).isEmpty();
        assertThat(controls("mcp-invoke")).isEmpty();
    }

    @Test
    @Timeout(600)
    void storeRejectDrainedKeepsTheOwnerAndHasNoDrainReceiptOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String owner = ownerIdentity(session);
        String holder = holderIdentity();
        String configurationId = configuration(session.id())
                .path("configurationId").asText();
        CloseRef close = prepareClose(session);
        storeFault().arm(StoreFaultGate.Phase.DRAINED, configurationId);
        HttpResponse<String> refused = rawLifecycle(session, close.operationId(),
                close.claimGeneration(), "settle_resources");
        assertThat(refused.statusCode()).as("drained refusal: %s",
                refused.body()).isEqualTo(503);
        waitForRejection();
        assertThat(configuration(session.id()).path("releaseState").asText())
                .isEqualTo("releasing");
        assertThat(owner).isNotBlank();
        assertThat(holder).isNotBlank();
        assertThat(ownerIdentity(session))
                .as("the broker owner stays after a rejected drain")
                .isEqualTo(owner);
        assertThat(holderIdentity())
                .as("the storage holder stays after a rejected drain")
                .isEqualTo(holder);
        assertThat(drainReceipts(session))
                .as("no drain receipt is fabricated")
                .isZero();
        storeFault().clear();
        killHarness();
        SessionRef reloaded = reload(session, close.operationId(),
                close.claimGeneration());
        HttpResponse<String> settled = settle(reloaded, close);
        assertThat(settled.statusCode()).as("settle: %s", settled.body())
                .isEqualTo(200);
        assertThat(configuration(session.id()).path("releaseState").asText())
                .isEqualTo("released");
    }

    // Green on MySQL 8.x: markReleased commits after broker.release(), so a
    // rejected released commit leaves the records drained and the owner
    // already released, and the next detach re-sends that same release once.
    // The cell pins that ordering; a regression that skips the resend, sends
    // it twice, or answers a 409 reddens it.
    @Test
    @Timeout(600)
    void storeRejectReleasedResendsTheOwnerReleaseOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        JsonNode configuration = configuration(session.id());
        String configurationId = configuration.path("configurationId").asText();
        String runtimeSessionId = configuration.path("runtimeSessionId").asText();
        String ownerReleasePath = "/internal/runtime-broker/v1/tool-sessions/"
                + runtimeSessionId + ":release";
        CloseRef close = prepareClose(session);
        storeFault().arm(StoreFaultGate.Phase.RELEASED, configurationId);
        HttpResponse<String> refused = null;
        for (int attempt = 0; attempt < 30
                && storeFault().attempts() == 0; attempt++) {
            refused = rawLifecycle(session, close.operationId(),
                    close.claimGeneration(), "settle_resources");
            if (storeFault().attempts() == 0) {
                Thread.sleep(1_000);
            }
        }
        assertThat(refused).isNotNull();
        waitForRejection();
        assertThat(configuration(session.id()).path("releaseState").asText())
                .as("the records stay drained")
                .isEqualTo("drained");
        assertThat(storageHolds())
                .as("broker.release() already cleared the holder")
                .isZero();
        long wireBefore = wireSequence.get();
        storeFault().clear();
        killHarness();
        SessionRef reloaded = reload(session, close.operationId(),
                close.claimGeneration());
        HttpResponse<String> settled = settle(reloaded, close);
        assertThat(settled.statusCode()).as("settle: %s", settled.body())
                .isEqualTo(200);
        assertThat(configuration(session.id()).path("releaseState").asText())
                .isEqualTo("released");
        List<Map<String, Object>> ownerReleases = wire.stream()
                .filter(entry -> "POST".equals(entry.get("method")))
                .filter(entry -> ownerReleasePath.equals(entry.get("path")))
                .toList();
        assertThat(ownerReleases).as("the first detach released the owner")
                .hasSize(2);
        assertThat(ownerReleases).allSatisfy(entry -> {
            assertThat(entry.get("status")).isEqualTo(200);
            JsonNode answer = (JsonNode) entry.get("answer");
            assertThat(answer.path("released").asBoolean())
                    .as("the owner release is confirmed and idempotent")
                    .isTrue();
        });
        List<Map<String, Object>> resends = ownerReleases.stream()
                .filter(entry -> ((Number) entry.get("seq")).intValue()
                        > wireBefore)
                .toList();
        assertThat(resends)
                .as("the next detach re-sends the same owner release once")
                .hasSize(1);
        assertThat(resends.getFirst().get("status"))
                .as("a 409 or a lost resend must fail")
                .isEqualTo(200);
        assertThat(((JsonNode) resends.getFirst().get("answer")).path(
                "released").asBoolean()).isTrue();
    }

    @Test
    @Timeout(600)
    void storeRejectReloadChainKeepsOneRecordPerIdOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String configuration = uuid();
        storeFault().arm(StoreFaultGate.Phase.INTENT, configuration);
        HttpResponse<String> refused = configure(session, configuration, 2);
        assertThat(refused.statusCode()).isIn(202, 409, 503);
        waitForRejection();
        storeFault().clear();
        // A rejected intent leaves no record, so the same id can be retried;
        // a fresh Harness also clears the write-failure latch.
        killHarness();
        SessionRef reopened = reload(session);
        HttpResponse<String> retried = configure(reopened, configuration, 2);
        assertThat(retried.statusCode()).as("retry: %s", retried.body())
                .isEqualTo(202);
        waitFor(() -> assertThat(configuration(session.id())
                .path("run").path("state").asText()).isEqualTo("settled"));
        JsonNode retriedRecord = configuration(session.id());
        assertThat(retriedRecord.path("configurationId").asText())
                .isEqualTo(configuration);
        assertThat(retriedRecord.path("configRevision").asInt())
                .as("the retried revision is the settled rev 2, not the"
                        + " rejected intent")
                .isEqualTo(2);
        assertThat(retriedRecord.path("run").path("state").asText())
                .isEqualTo("settled");
        assertThat(retriedRecord.path("run").path("execution").asText())
                .isEqualTo("settled");
        List<JsonNode> records = configurationRecords(session.id());
        assertThat(records).hasSize(2);
        assertThat(records).extracting(record -> record.path(
                "configurationId").asText()).doesNotHaveDuplicates();
        Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_session_record WHERE record_kind = 'DOMAIN' AND"
                + " tenant_id = ? AND session_id = ? AND"
                + " domain = 'mcp_configuration' AND record_id = ?",
                Integer.class, tenant, session.id(), configuration);
        assertThat(rows).as("one logical chain per id").isEqualTo(1);
        Integer keys = jdbc.queryForObject("SELECT COUNT(DISTINCT"
                + " record_key) FROM ma_session_record WHERE record_kind ="
                + " 'DOMAIN' AND tenant_id = ? AND session_id = ? AND"
                + " domain = 'mcp_configuration'", Integer.class, tenant,
                session.id());
        assertThat(keys).as("no duplicate configuration chain").isEqualTo(2);
    }

    private HttpResponse<String> configure(SessionRef session,
            String configuration, int revision) throws Exception {
        Map<String, Object> body = Map.of("operationId", configuration,
                "expectedRevision", revision - 1, "server", mcpPin(revision));
        return rawRequest("POST", "/session/" + session.id()
                + "/mcp/configurations", json.writeValueAsString(body),
                session.clientId());
    }

    private Map<String, Object> operationBody(String operation) {
        return Map.of("operationId", operation, "serverId", "fixture",
                "request", Map.of("kind", "resource_read", "uri",
                        "ext://proof"));
    }

    private StoreFaultGate storeFault() {
        return StoreFaultGate.INSTANCE;
    }

    private void waitForRejection() {
        waitFor(() -> assertThat(storeFault().attempts())
                .as("the store wrapper fired")
                .isPositive());
    }

    private List<JsonNode> configurationRecords(String session) {
        return HostedGateTestSupport.extensionRecords(jdbc, tenant, session,
                "mcp_configuration");
    }

    /**
     * The exact owner the baseline acquired: a positive count alone would
     * accept a fresh generation the refused commit could have minted.
     */
    private String ownerIdentity(SessionRef session) {
        List<String> rows = jdbc.query("SELECT CONCAT(CONVERT("
                + "runtime_session_id USING utf8mb4), ':', runtime_generation)"
                + " FROM ma_runtime_session WHERE tenant_id = ? AND"
                + " harness_session_id = ? AND session_state IN"
                + " ('ACQUIRING', 'READY') ORDER BY runtime_generation DESC",
                (row, index) -> row.getString(1), tenant, session.id());
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private String holderIdentity() {
        List<String> rows = jdbc.queryForList("SELECT CONVERT(holder_key"
                + " USING utf8mb4) FROM ma_storage_owner WHERE tenant_id = ?"
                + " AND holder_key IS NOT NULL", String.class, tenant);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private int storageHolds() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_storage_owner WHERE tenant_id = ? AND holder_key IS"
                + " NOT NULL", Integer.class, tenant);
        return count == null ? 0 : count;
    }

    private int drainReceipts(SessionRef session) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_runtime_binding WHERE tenant_id = ? AND"
                + " drain_receipt_json IS NOT NULL", Integer.class, tenant);
        return count == null ? 0 : count;
    }

    private int publishedResponses(String session) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_resource WHERE tenant_id = ? AND session_id = ? AND"
                + " kind = 'managed-mcp-response'", Integer.class, tenant,
                session);
        return count == null ? 0 : count;
    }

    private record CloseRef(String operationId, long claimGeneration) {
    }

    private CloseRef prepareClose(SessionRef session) throws Exception {
        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id ="
                + " ? AND session_id = ?", PROFILE, tenant, session.id());
        OperationRecord close = admitClose(session);
        driveLifecycle(session, close.operationId(), close.claimGeneration(),
                "effects");
        jdbc.update("UPDATE ma_session_head SET phase = 'DRAINING' WHERE"
                + " tenant_id = ? AND harness_session_id = ? AND"
                + " operation_id = ?", tenant, session.id(),
                close.operationId());
        driveLifecycle(session, close.operationId(), close.claimGeneration(),
                "prepare_resources");
        return new CloseRef(close.operationId(), close.claimGeneration());
    }

    private HttpResponse<String> settle(SessionRef session, CloseRef close)
            throws Exception {
        HttpResponse<String> settled = null;
        for (int attempt = 0; attempt < 60; attempt++) {
            settled = rawLifecycle(session, close.operationId(),
                    close.claimGeneration(), "settle_resources");
            if (settled.statusCode() == 200) {
                return settled;
            }
            if (settled.statusCode() == 409) {
                JsonNode refusal = json.readTree(settled.body());
                String code = refusal.path("error").asText(
                        refusal.path("code").asText());
                if ("hosted_turn_active".equals(code)) {
                    Thread.sleep(1_000);
                    continue;
                }
            }
            assertThat(settled.statusCode()).as("settle: %s", settled.body())
                    .isEqualTo(503);
            Thread.sleep(1_000);
        }
        assertThat(settled).isNotNull();
        return settled;
    }

    private void killHarness() throws Exception {
        Process dead = harness;
        dead.destroyForcibly();
        assertThat(dead.waitFor(10, TimeUnit.SECONDS))
                .as("the Harness must die before the replacement starts")
                .isTrue();
    }

    private String writeRelease() throws IOException {
        Path release = Path.of(evidence + ".release");
        Files.createFile(release);
        return release.toString();
    }

    private Map<String, Object> mcpPin(int revision) {
        return Map.of("serverId", "fixture", "serverRevision", revision,
                "definitionDigest", DigestUtils.sha256Hex(mcpDigest + revision));
    }

    private void baseline(SessionRef session) throws Exception {
        List<Map<String, Object>> prompt = List.of(
                Map.of("type", "text", "text", "FG12C_BASE"));
        String payload = json.writeValueAsString(prompt);
        harnessRequest("POST", "/session/" + session.id() + "/prompt",
                Map.of("promptId", uuid(), "prompt", prompt, "payloadDigest",
                        "sha256:" + DigestUtils.sha256Hex(payload)),
                session.clientId(), 202);
        waitFor(() -> assertThat(HostedGateTestSupport.extensionRecords(jdbc,
                tenant, session.id(), "mcp_configuration")).hasSize(1));
        waitFor(() -> assertThat(harnessRequest("GET", "/session/"
                + session.id() + "/status", null, session.clientId(), 200)
                        .path("hasActivePrompt").asBoolean()).isFalse());
        // The MCP configure settles inside the turn; a lifecycle close that
        // starts before it does answers turn_active/unsettled instead of
        // reaching the release.
        waitFor(() -> {
            JsonNode record = configuration(session.id());
            assertThat(record.path("run").path("state").asText())
                    .isEqualTo("settled");
            assertThat(record.path("run").path("execution").asText())
                    .isEqualTo("settled");
        });
        // The baseline's own configure is not part of the case under test;
        // sequence marks avoid clearing a list an in-flight relay is still
        // completing.
        controlBaseline = proxySequence.get();
        wireBaseline = wireSequence.get();
    }

    private JsonNode configuration(String session) {
        List<JsonNode> records = HostedGateTestSupport.extensionRecords(jdbc,
                tenant, session, "mcp_configuration");
        assertThat(records).isNotEmpty();
        return records.getLast();
    }

    private List<JsonNode> operations(String session) {
        return HostedGateTestSupport.extensionRecords(jdbc, tenant, session,
                "mcp_operation");
    }

    private List<JsonNode> fixtureEvents(String kind) {
        if (evidence == null || !Files.exists(evidence)) {
            return List.of();
        }
        try {
            return Files.readAllLines(evidence).stream().map(line -> {
                try {
                    return json.readTree(line);
                } catch (IOException error) {
                    throw new IllegalStateException(error);
                }
            }).filter(event -> kind.equals(event.path("event").asText()))
                    .toList();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private List<String> effects(String kind) {
        return fixtureEvents("mcp.effect").stream()
                .filter(event -> kind.equals(event.path("kind").asText()))
                .map(event -> event.path("value").asText()).toList();
    }

    private JsonNode published(String session, JsonNode ref) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String body = jdbc.queryForObject(
                "SELECT CONVERT(inline_bytes USING utf8mb4) FROM ma_resource"
                        + " WHERE session_scope_key = ? AND resource_id = ?"
                        + " AND tenant_id = ? AND session_id = ?",
                String.class, scope, ref.path("resourceId").asText(), tenant,
                session);
        assertThat(body).as("published response body").isNotBlank();
        try {
            return json.readTree(body);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private List<ProxyCall> controls(String kind) {
        return proxyCalls.stream().filter(call -> kind.equals(call.kind()))
                .filter(call -> call.seq() > controlBaseline).toList();
    }

    private ProxyCall control(String kind) {
        List<ProxyCall> found = controls(kind);
        assertThat(found).isNotEmpty();
        return found.getLast();
    }

    private HttpResponse<String> rawStatus(SessionRef session,
            String operationId) throws Exception {
        return rawRequest("GET", "/session/" + session.id()
                + "/mcp/operations/" + operationId, null, session.clientId());
    }

    private OperationRecord admitClose(SessionRef session) {
        String key = "close-" + uuid();
        RuntimeException last = null;
        for (int attempt = 0; attempt < 60; attempt++) {
            try {
                var admission = store.beginWorkspaceLifecycle(tenant,
                        session.id(), OperationKind.CLOSE, "actor",
                        DigestUtils.sha256Hex("actor"), key,
                        "sha256:" + DigestUtils.sha256Hex(key), true, 2);
                return store.claimOperation(tenant, session.id(),
                        admission.operation().operationId(), "fg12d-close",
                        Duration.ofMinutes(10)).orElseThrow();
            } catch (RuntimeException failure) {
                last = failure;
                String message = String.valueOf(failure.getMessage());
                if (!message.contains("turn_active")
                        && !message.contains("journal_unverified")) {
                    throw failure;
                }
                try {
                    Thread.sleep(500);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw failure;
                }
            }
        }
        throw new AssertionError("close admission never became idle", last);
    }

    private Map<String, Object> lifecycleBody(SessionRef session,
            String operationId, long claimGeneration, String phase) {
        return Map.of(
                "protocolVersion", 2,
                "phase", phase,
                "kind", "close",
                "toolProfile", PROFILE,
                "sessionKey", Map.of("tenantId", tenant,
                        "workspaceId", "workspace",
                        "sessionId", session.id()),
                "authority", Map.of("operationId", operationId,
                        "claimGeneration", claimGeneration));
    }

    private JsonNode driveLifecycle(SessionRef session, String operationId,
            long claimGeneration, String phase) throws Exception {
        return privateRequest("POST", "/session/" + session.id()
                + "/lifecycle", lifecycleBody(session, operationId,
                claimGeneration, phase), session, 200);
    }

    private HttpResponse<String> rawLifecycle(SessionRef session,
            String operationId, long claimGeneration, String phase)
            throws Exception {
        return rawRequest("POST", "/session/" + session.id() + "/lifecycle",
                json.writeValueAsString(lifecycleBody(session, operationId,
                        claimGeneration, phase)), session.clientId());
    }

    private String uuid() {
        return UUID.randomUUID().toString();
    }

    private record SessionRef(String id, String clientId) {
    }

    private Map<String, Object> storeDescriptor() {
        Map<String, Object> store = new LinkedHashMap<>();
        store.put("baseUrl", "http://127.0.0.1:" + port);
        store.put("tenantId", tenant);
        store.put("workspaceId", "workspace");
        store.put("writerId", bootId);
        // A killed Harness cannot release its writer lease, so the
        // replacement waits out a short lease rather than the 60 s default.
        store.put("leaseDurationMs", 3_000);
        return store;
    }

    private SessionRef createSession() throws Exception {
        String key = uuid();
        String session = store.insertWorkspaceSessionCommand(tenant, "actor",
                "create-" + key, "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null,
                new WorkspaceSelection("workspace", "child")).sessionId();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", session);
        body.put("sessionScope", "thread");
        body.put("toolProfile", PROFILE);
        body.put("approvalMode", "yolo");
        body.put("mcpServers", List.of(mcpPin(1)));
        body.put("managedSessionStore", storeDescriptor());
        JsonNode created = harnessRequest("POST", "/session", body, null, 200);
        assertThat(created.path("sessionId").asText()).isEqualTo(session);
        String clientId = created.path("clientId").asText();
        assertThat(clientId).isNotBlank();
        return new SessionRef(session, clientId);
    }

    private SessionRef reload(SessionRef session) throws Exception {
        return reload(session, null, 0, null, null);
    }

    private SessionRef reload(SessionRef session, String lifecycleOperation,
            long claimGeneration) throws Exception {
        return reload(session, lifecycleOperation, claimGeneration, null,
                null);
    }

    /**
     * FG12b: reopen the stopped authority with the original operation and
     * runtime pins. The durable record is the authority; the body carries the
     * same pins a takeover-shaped load presents, so the reopened Session can
     * never drift to a fresh Runtime generation.
     */
    private SessionRef reloadPinned(SessionRef session, String runtimeSessionId,
            String operationId) throws Exception {
        return reload(session, null, 0, runtimeSessionId, operationId);
    }

    private SessionRef reload(SessionRef session, String lifecycleOperation,
            long claimGeneration, String runtimeSessionId,
            String operationId) throws Exception {
        startHarness();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionScope", "thread");
        body.put("toolProfile", PROFILE);
        body.put("approvalMode", "yolo");
        body.put("mcpServers", List.of(mcpPin(1)));
        body.put("managedSessionStore", storeDescriptor());
        if (runtimeSessionId != null) {
            body.put("runtimeSessionId", runtimeSessionId);
        }
        if (operationId != null) {
            body.put("operationId", operationId);
        }
        if (lifecycleOperation != null) {
            body.put("lifecycleProtocolVersion", 2);
            body.put("lifecycleAuthority", Map.of("operationId",
                    lifecycleOperation, "claimGeneration", claimGeneration));
        }
        String payload = json.writeValueAsString(body);
        JsonNode loaded = null;
        for (int attempt = 0; attempt < 60 && loaded == null; attempt++) {
            HttpResponse<String> response = rawRequest("POST",
                    "/session/" + session.id() + "/load", payload);
            if (response.statusCode() == 200) {
                loaded = json.readTree(response.body());
                break;
            }
            // The killed Harness still holds the writer lease; wait for it
            // to lapse instead of treating the conflict as a failed load.
            assertThat(response.statusCode()).as("load: %s",
                    response.body()).isEqualTo(409);
            JsonNode refusal = json.readTree(response.body());
            assertThat(refusal.path("error").asText(
                    refusal.path("code").asText()))
                    .as("only the dead writer lease is retryable: %s",
                            response.body())
                    .isEqualTo("managed_session_writer_conflict");
            Thread.sleep(1_000);
        }
        assertThat(loaded).as("the replacement Harness must load the Session")
                .isNotNull();
        String clientId = loaded.path("clientId").asText("");
        return new SessionRef(session.id(), clientId.isBlank()
                ? session.clientId() : clientId);
    }

    private HttpResponse<String> rawRequest(String method, String path,
            String payload) throws Exception {
        return rawRequest(method, path, payload, null);
    }

    private HttpResponse<String> rawRequest(String method, String path,
            String payload, String clientId) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + harnessPort + path))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + TOKEN)
                .header("X-Qwen-Harness-Protocol-Version", "1")
                .header("X-Qwen-Harness-Boot-Id", bootId)
                .header("Content-Type", "application/json")
                .method(method, payload == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(payload));
        if (clientId != null) {
            builder.header("X-Qwen-Client-Id", clientId);
        }
        return http.send(builder.build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private JsonNode privateRequest(String method, String path, Object body,
            SessionRef session, int expected) throws Exception {
        return harnessRequest(method, path, body, session.clientId(), expected);
    }

    private JsonNode harnessRequest(String method, String path, Object body,
            String clientId, int expected) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(
                "http://127.0.0.1:" + harnessPort + path))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + TOKEN)
                .header("X-Qwen-Harness-Protocol-Version", "1")
                .header("X-Qwen-Harness-Boot-Id", bootId)
                .header("Content-Type", "application/json")
                .method(method, body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers
                                .ofString(json.writeValueAsString(body)));
        if (clientId != null) {
            builder.header("X-Qwen-Client-Id", clientId);
        }
        HttpResponse<String> response = http.send(builder.build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("%s %s: %s", method, path,
                response.body()).isEqualTo(expected);
        return response.body().isEmpty() ? json.createObjectNode()
                : json.readTree(response.body());
    }

    private void startSpring() {
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class)
                .sources(StoreFaultConfiguration.class)
                .run("--server.address=127.0.0.1", "--server.port=" + port,
                        "--spring.datasource.url="
                                + System.getProperty("mysql.url"),
                        "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                        "--spring.datasource.username="
                                + System.getProperty("mysql.user"),
                        "--spring.datasource.password="
                                + System.getProperty("mysql.password", ""),
                        "--qwen.managed-agent.trusted-actor-header=X-Qwen-Actor-Id",
                        "--qwen.managed-agent.definition-tool-profiles="
                                + PROFILE,
                        "--qwen.managed-agent.session-store.enabled=true",
                        "--qwen.managed-agent.session-store.base-url=http://127.0.0.1:"
                                + port,
                        "--qwen.managed-agent.session-store.workspace-id=unused-global-workspace",
                        "--qwen.managed-agent.session-store.writer-lease-duration=3s",
                        "--qwen.managed-agent.harness.enabled=false",
                        "--qwen.managed-agent.harness.capability-digest="
                                + CAPABILITY,
                        "--qwen.managed-agent.runtime-broker.enabled=true",
                        "--qwen.managed-agent.runtime-broker.port="
                                + brokerPort,
                        "--qwen.managed-agent.runtime-broker.token=" + TOKEN,
                        "--qwen.managed-agent.runtime-broker.durable-local-process=true",
                        "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                        "--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled=true",
                        "--qwen.managed-agent.runtime-broker.workspace-cwd="
                                + temporary.resolve("decoy"),
                        "--qwen.managed-agent.runtime-broker.state-directory="
                                + temporary.resolve("broker"),
                        "--qwen.managed-agent.runtime-broker.credential-key-id=restart",
                        "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                        "--qwen.managed-agent.runtime-broker.node-executable="
                                + node,
                        "--qwen.managed-agent.runtime-broker.worker-entry="
                                + temporary.resolve("worker.mjs"),
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id="
                                + tenant,
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                        "--qwen.managed-agent.runtime-broker.workspace-mounts[0].root="
                                + workspace.getParent());
        jdbc = spring.getBean(JdbcTemplate.class);
        store = spring.getBean(ManagedAgentStore.class);
        WorkspaceStorageGuard guard = spring
                .getBean(WorkspaceStorageGuard.class);
        guard.register(tenant, "storage", UUID.randomUUID().toString());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES (?, 'workspace',"
                + " 1, 'storage', 'Restart', ?, ?, 'ACTIVE')", tenant,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'workspace',"
                + " ?, 'OPERATOR')", tenant,
                "actor".getBytes(StandardCharsets.UTF_8));
    }

    private void modelReply(HttpExchange exchange) throws IOException {
        try {
            json.readTree(exchange.getRequestBody());
            var chunk = json.createObjectNode().put("id", "fg12c")
                    .put("object", "chat.completion.chunk").put("created", 0)
                    .put("model", "restart-fixture");
            var choice = chunk.putArray("choices").addObject()
                    .put("index", 0);
            choice.putObject("delta").put("role", "assistant")
                    .put("content", "FG12C_DONE");
            choice.putNull("finish_reason");
            String first = "data: " + json.writeValueAsString(chunk) + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", "stop");
            byte[] response = (first + "data: "
                    + json.writeValueAsString(chunk)
                    + "\n\ndata: [DONE]\n\n")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "text/event-stream");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
        } catch (Exception | AssertionError failure) {
            modelFailure.compareAndSet(null, failure);
        } finally {
            exchange.close();
        }
    }

    private void startBrokerProxy() throws IOException {
        brokerProxy = HttpServer.create(new InetSocketAddress("127.0.0.1", 0),
                0);
        brokerProxy.createContext("/", this::relay);
        brokerProxy.start();
    }

    private void relay(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readAllBytes();
        String path = exchange.getRequestURI().getPath();
        String query = exchange.getRequestURI().getQuery();
        JsonNode parsed = null;
        if (body.length > 0) {
            try {
                parsed = json.readTree(body);
            } catch (IOException ignored) {
                parsed = null;
            }
        }
        String kind = parsed == null ? null
                : parsed.at("/operation/kind").isTextual()
                        ? parsed.at("/operation/kind").asText()
                        : null;
        String operationId = parsed == null ? null
                : parsed.at("/operation/operationId").isTextual()
                        ? parsed.at("/operation/operationId").asText()
                        : null;
        ProxyCall call = new ProxyCall(exchange.getRequestMethod(), path, kind,
                0, operationId, proxySequence.incrementAndGet());
        int index;
        synchronized (proxyCalls) {
            index = proxyCalls.size();
            proxyCalls.add(call);
        }
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("method", exchange.getRequestMethod());
        entry.put("path", path);
        entry.put("seq", wireSequence.incrementAndGet());
        if (parsed != null) {
            entry.put("request", parsed);
        }
        URI upstream = URI.create("http://127.0.0.1:" + brokerPort + path
                + (query == null ? "" : "?" + query));
        HttpRequest.Builder builder = HttpRequest.newBuilder(upstream)
                .timeout(Duration.ofSeconds(120));
        for (var header : exchange.getRequestHeaders().entrySet()) {
            String name = header.getKey();
            if (List.of("host", "connection", "content-length",
                    "transfer-encoding", "upgrade", "expect", "keep-alive",
                    "proxy-connection").contains(name.toLowerCase(
                            java.util.Locale.ROOT))) {
                continue;
            }
            for (String value : header.getValue()) {
                builder.header(name, value);
            }
        }
        HttpRequest request = builder.method(exchange.getRequestMethod(),
                body.length == 0 ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        try {
            HttpResponse<byte[]> response = http.send(request,
                    HttpResponse.BodyHandlers.ofByteArray());
            proxyCalls.set(index, call.complete(response.statusCode()));
            entry.put("status", response.statusCode());
            try {
                entry.put("answer", json.readTree(response.body()));
            } catch (IOException unparsable) {
                entry.put("answer", new String(response.body(),
                        StandardCharsets.UTF_8));
            }
            wire.add(entry);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(response.statusCode(),
                    response.body().length);
            exchange.getResponseBody().write(response.body());
        } catch (IOException failure) {
            proxyCalls.set(index, call.complete(502));
            exchange.sendResponseHeaders(502, -1);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            exchange.sendResponseHeaders(502, -1);
        } finally {
            exchange.close();
        }
    }

    private void startHarness() throws Exception {
        if (home == null) {
            home = Files.createDirectory(temporary.resolve("home"));
            configHome = Files.createDirectory(home.resolve(".qwen"));
            String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort()
                    + "/v1";
            json.writeValue(configHome.resolve("settings.json").toFile(), Map.of(
                    "security", Map.of("auth", Map.of("selectedType", "openai")),
                    "telemetry", Map.of("enabled", false),
                    "model", Map.of("name", "restart-fixture"),
                    "modelProviders", Map.of("openai",
                            List.of(Map.of("id", "restart-fixture", "envKey",
                                    "OPENAI_API_KEY", "baseUrl", modelUrl)))));
        }
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort()
                + "/v1";
        ProcessBuilder builder = new ProcessBuilder(node, cli.toString(),
                "serve", "--profile", "hosted-harness", "--http-bridge",
                "--hostname", "127.0.0.1", "--port",
                Integer.toString(harnessPort), "--require-auth", "--no-web",
                "--workspace", temporary.resolve("decoy").toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:"
                        + brokerProxy.getAddress().getPort(),
                "--managed-runtime-broker-token", TOKEN)
                .directory(temporary.resolve("decoy").toFile())
                .redirectErrorStream(true)
                .redirectOutput(temporary.resolve("harness.log").toFile());
        var env = builder.environment();
        env.clear();
        env.put("PATH", System.getenv("PATH"));
        env.putAll(Map.of("HOME", home.toString(), "QWEN_HOME",
                configHome.toString(), "QWEN_RUNTIME_DIR",
                home.resolve("runtime").toString(), "OPENAI_API_KEY",
                "fixture-only", "OPENAI_BASE_URL", modelUrl,
                "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", CAPABILITY,
                "QWEN_HOSTED_LIFECYCLE_V2_PROFILES", PROFILE,
                "QWEN_CODE_MODELS_DEV_REFRESH", "off"));
        for (String key : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH",
                "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
                "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            env.put(key, home.resolve(key + ".json").toString());
        }
        harness = builder.start();
        waitFor(() -> {
            assertThat(harness.isAlive())
                    .as("Harness log: %s", temporary.resolve("harness.log"))
                    .isTrue();
            JsonNode capabilities = json.readTree(http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                            + harnessPort + "/capabilities"))
                            .timeout(Duration.ofSeconds(2))
                            .header("Authorization", "Bearer " + TOKEN)
                            .build(),
                    HttpResponse.BodyHandlers.ofString()).body());
            bootId = capabilities.at("/hostedHarness/bootId").asText();
            assertThat(bootId).isNotBlank();
        });
    }

    private void waitFor(org.junit.jupiter.api.function.Executable assertion) {
        await().atMost(Duration.ofSeconds(120)).ignoreException(
                java.net.ConnectException.class).failFast(() -> {
                    if (modelFailure.get() != null) {
                        throw new AssertionError("Model fixture: "
                                + modelFailure.get(), modelFailure.get());
                    }
                }).untilAsserted(assertion::execute);
    }

    @AfterEach
    void stop() {
        StoreFaultGate.INSTANCE.clear();
        try {
            caseExecutor.close();
        } catch (Exception ignored) {
            // The case's own failure is the meaningful one.
        }
        try {
            if (spring != null) {
                spring.close();
            }
        } finally {
            if (brokerProxy != null) {
                brokerProxy.stop(0);
            }
            if (model != null) {
                model.stop(0);
            }
            if (modelExecutor != null) {
                modelExecutor.close();
            }
            if (harness != null) {
                harness.destroyForcibly();
                try {
                    harness.waitFor(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            http.close();
            try {
                HostedDurableWorkers.stop(temporary.resolve("broker"), json);
            } catch (Exception ignored) {
                // Best-effort teardown.
            }
            try {
                for (JsonNode event : fixtureEvents("mcp.start")) {
                    ProcessHandle.of(event.path("pid").asLong())
                            .filter(handle -> handle.info().commandLine()
                                    .map(command -> command
                                            .contains("mcp-fault.mjs"))
                                    .orElse(false))
                            .ifPresent(handle -> {
                                handle.destroyForcibly();
                                try {
                                    handle.onExit().get(10, TimeUnit.SECONDS);
                                } catch (Exception ignored) {
                                    // Best-effort teardown.
                                }
                            });
                }
            } catch (Exception ignored) {
                // Best-effort teardown for the stdio fixture.
            }
            saveEvidence();
        }
    }

    private void saveEvidence() {
        try {
            Path destination = Files.createDirectories(Path.of(
                    "target/fg12-cases", caseLetter, tenant));
            System.out
                    .println("FG12_EVIDENCE " + destination.toAbsolutePath());
            json.writeValue(destination.resolve("proxy.json").toFile(),
                    proxyCalls);
            json.writeValue(destination.resolve("wire.json").toFile(), wire);
            for (String name : List.of("harness.log", "processes.jsonl")) {
                Path source = temporary.resolve(name);
                if (Files.exists(source)) {
                    Files.copy(source, destination.resolve(source.getFileName()));
                }
            }
        } catch (Exception ignored) {
            // Evidence collection must not hide the case's own failure.
        }
    }

    // Test-only: replaces the record store bean with the faulting wrapper.
    // The store's own constructor wiring is unchanged, so every commit still
    // runs in the real transaction.
    @Configuration(proxyBeanMethods = false)
    static class StoreFaultConfiguration {
        @Bean
        @Primary
        ManagedExtensionRecordStore faultingExtensionRecordStore(
                JdbcTemplate jdbc, AgentStateStore sessions,
                ManagedTaskEventStore taskEvents) {
            return new FaultingExtensionRecordStore(jdbc, sessions, taskEvents,
                    StoreFaultGate.INSTANCE);
        }
    }

    private record ProxyCall(String method, String path, String kind,
            int status, String operationId, int seq) {
        ProxyCall complete(int value) {
            return new ProxyCall(method, path, kind, value, operationId, seq);
        }
    }
}
