package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInfo;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

// FG12c (issue #14447): the Hosted MCP restart matrix. Each case kills one
// process — the packaged Harness, the durable Runtime worker or the stdio MCP
// server — and proves that the surviving generation never mints a second
// owner, never resends a control and never fabricates a settled result. The
// control hold at the Broker proxy keeps the record at `dispatch_started`
// until the kill, so the injection is deterministic rather than a race
// against a fast Runtime. Real Harness, worker, fixtures and MySQL.
// FG12d adds the release-state cell deferred by FG12c: the Harness dies
// after `releaseState: releasing`, and the replacement finishes the
// original `${configurationId}:release` operation instead of minting one.
// Its pre-dispatch cancel cell parks the owner acquire between `intent` and
// `dispatch_started` instead of killing a process.
// Its R1-1 cell refuses the owner release after `drained` and replaces
// Spring, and with it the embedded Broker, before the retry.
class HostedMcpRestartFaultGatesIT {
    private static final String PROFILE = "hosted-workspace-mcp/1";
    // Per-case evidence letter: FG12c keeps its directory, FG12d's release
    // cell lands under its own so the two letters' artefacts never mix.
    private String caseLetter;
    private static final Map<String, String> CASE_LETTERS = Map.of(
            "harnessKillDuringConfigureResolvesThroughStatusOnMySql",
            "fg12c",
            "harnessKillDuringOperationLooksUpTheOriginalInvokeOnMySql",
            "fg12c",
            "workerKillWhileIdleNeverMintsAFreshOwnerOnMySql", "fg12c",
            "workerKillDuringOperationSettlesOutcomeUnknownOnMySql", "fg12c",
            "stdioKillDuringRequestSettlesOutcomeUnknownOnMySql", "fg12c",
            "harnessKillDuringReleaseResumesTheOriginalReleaseOnMySql",
            "fg12d",
            "firstReleaseRefusedBeforeForwardingResumesUnderTheSameId",
            "fg12d",
            "cancelBeforeDispatchIsNotStartedProvenOnMySql", "fg12d",
            "ownerReleaseRefusedThenSpringRestartReleasesTheHolderOnMySql",
            "fg12d");
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
    private volatile CountDownLatch controlHold;
    private volatile String controlHoldKind;
    private volatile CountDownLatch replyHold;
    private volatile String replyHoldKind;
    private volatile String replyHoldTarget;
    private volatile CountDownLatch replyParked;
    private volatile String refuseNextKind;
    private final java.util.concurrent.atomic.AtomicBoolean refuseArmed =
            new java.util.concurrent.atomic.AtomicBoolean();
    private final java.util.concurrent.atomic.AtomicBoolean
            ownerReleaseRefuseArmed =
                    new java.util.concurrent.atomic.AtomicBoolean();
    private boolean springSeeded;
    private volatile String acquireHoldSession;
    private volatile String acquireHoldOperation;
    private volatile CountDownLatch acquireHold;
    private volatile CountDownLatch acquireParked;
    private volatile int acquireParkedSeq;
    private volatile Throwable acquireProbeFailure;
    private final java.util.concurrent.atomic.AtomicBoolean acquireArmed =
            new java.util.concurrent.atomic.AtomicBoolean();
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
    private ExecutorService brokerExecutor;
    private ServletWebServerApplicationContext spring;
    private JdbcTemplate jdbc;
    private ManagedAgentStore store;
    private Process harness;

    @BeforeEach
    void boot(TestInfo info) throws Exception {
        caseLetter = info.getTestMethod()
                .map(method -> CASE_LETTERS.get(method.getName()))
                .orElse(null);
        assertThat(System.getProperty("mysql.url"))
                .as("FG12c requires a disposable MySQL")
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

    @Test
    @Timeout(600)
    void harnessKillDuringConfigureResolvesThroughStatusOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String configuration = uuid();
        holdNextControl("mcp-configure");
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/configurations", Map.of("operationId",
                        configuration, "expectedRevision", 1, "server",
                        mcpPin(2)), session, 202));
        waitFor(() -> {
            JsonNode record = configuration(session.id());
            assertThat(record.path("configRevision").asInt()).isEqualTo(2);
            assertThat(record.path("run").path("execution").asText())
                    .as("configure must be in dispatch_started")
                    .isEqualTo("dispatch_started");
            assertThat(controls("mcp-configure")).anyMatch(call ->
                    configuration.equals(call.operationId())
                            && call.status() == 0);
        });
        JsonNode identity = configuration(session.id()).path("run")
                .path("runtime");
        assertThat(identity.isObject()).isTrue();
        killHarness();
        releaseControl();
        await().atMost(Duration.ofSeconds(60))
                .ignoreExceptions()
                .until(() -> control("mcp-configure").status() != 0);
        SessionRef reloaded = reload(session);
        pending.cancel(true);
        Map<String, Object> statusEntry = null;
        for (int attempt = 0; attempt < 10 && statusEntry == null; attempt++) {
            triggerTurn(reloaded);
            long deadline = System.nanoTime()
                    + Duration.ofSeconds(5).toNanos();
            while (System.nanoTime() < deadline && statusEntry == null) {
                statusEntry = terminalStatus(configuration);
                if (statusEntry == null) {
                    Thread.sleep(100);
                }
            }
        }
        assertThat(statusEntry).as("a terminal status lookup").isNotNull();
        JsonNode statusAnswer = (JsonNode) statusEntry.get("answer");
        String answerState = statusAnswer.path("result").path("state")
                .asText();
        assertThat(answerState).isIn("settled", "outcome_unknown");
        String recordState = configuration(session.id()).path("run")
                .path("state").asText();
        if ("settled".equals(answerState)) {
            assertThat(recordState).isEqualTo("settled");
        } else {
            assertThat(recordState).isIn("outcome_unknown",
                    "recovery_blocked");
        }
        assertThat(configuration(session.id()).path("run").path("runtime"))
                .as("the replacement keeps the original generation")
                .isEqualTo(identity);
        assertThat(controls("mcp-configure")).hasSize(1);
        assertThat(controls("mcp-status")).anyMatch(call -> configuration
                .equals(call.operationId()));
        assertThat(configuration(session.id()).path("configRevision").asInt())
                .isEqualTo(2);
        assertThat(configuration(session.id()).path("run").path("state")
                .asText()).isIn("settled", "outcome_unknown");
        assertThat(fixtureEvents("mcp.start"))
                .as("baseline rev 1 plus this case's rev 2; no third server")
                .hasSize(2);
    }

    @Test
    @Timeout(600)
    void harnessKillDuringOperationLooksUpTheOriginalInvokeOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String operation = uuid();
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", Map.of("operationId", operation,
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://hold")),
                        session, 202));
        waitFor(() -> assertThat(fixtureEvents("mcp.hold")).hasSize(1));
        assertThat(operations(session.id()).getLast().path("run")
                .path("execution").asText()).isEqualTo("dispatch_started");
        killHarness();
        SessionRef reloaded = reload(session);
        pending.cancel(true);
        HttpResponse<String> held = rawStatus(reloaded, operation);
        assertThat(held.statusCode()).isIn(200, 503);
        if (held.statusCode() == 200) {
            JsonNode body = json.readTree(held.body());
            assertThat(body.path("state").asText())
                    .as("a held read must never look settled")
                    .isIn("running", "recovery_blocked", "outcome_unknown");
        }
        JsonNode heldRecord = operations(session.id()).getLast();
        assertThat(heldRecord.path("run").path("execution").asText())
                .isIn("dispatch_started", "outcome_unknown");
        assertThat(heldRecord.path("run").path("state").asText())
                .isNotEqualTo("settled");
        assertThat(controls("mcp-invoke")).hasSize(1);
        assertThat(controls("mcp-status")).anyMatch(call -> operation
                .equals(call.operationId()));
        assertThat(effects("resource_read")).doesNotContain("ext://hold");
        writeRelease();
        waitFor(() -> assertThat(effects("resource_read"))
                .containsExactly("ext://hold"));
        await().atMost(Duration.ofSeconds(60)).untilAsserted(() -> {
            HttpResponse<String> settled = rawStatus(reloaded, operation);
            assertThat(settled.statusCode()).isEqualTo(200);
            assertThat(json.readTree(settled.body()).path("state").asText())
                    .isEqualTo("settled");
        });
        JsonNode finalRecord = operations(session.id()).getLast();
        assertThat(finalRecord.path("run").path("state").asText())
                .isEqualTo("settled");
        assertThat(finalRecord.path("resultRef").isNull()).isFalse();
        JsonNode result = published(session.id(),
                finalRecord.path("resultRef"));
        assertThat(result.path("response").path("contents").get(0)
                .path("text").asText()).isEqualTo("EXT_HELD");
    }

    // FG12d (issue #14447): the release-state cell FG12c deferred. The close
    // sequence commits `releasing` before it dispatches mcp-release, so the
    // proxy holds that dispatch and the Harness dies with the record on
    // disk. The replacement loads the same Runtime Session and finishes the
    // same `${configurationId}:release` operation; it never configures or
    // invokes again, and it can only reach `released` through the dispatch
    // that the original generation already issued.
    @Test
    @Timeout(600)
    void harnessKillDuringReleaseResumesTheOriginalReleaseOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        JsonNode configuration = configuration(session.id());
        String configurationId = configuration.path("configurationId")
                .asText();
        String releaseId = configurationId + ":release";
        JsonNode identity = configuration.path("run").path("runtime");
        assertThat(identity.isObject()).isTrue();
        assertThat(configuration.path("releaseState").asText())
                .isEqualTo("active");
        // The Harness create route pins the session's MCP profile; this
        // fixture seeds the row directly, so admit the lifecycle close under
        // the same profile the Harness actually runs.
        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id ="
                + " ? AND session_id = ?", PROFILE, tenant, session.id());

        OperationRecord close = admitClose(session);
        String closeId = close.operationId();
        long claimGeneration = close.claimGeneration();
        driveLifecycle(session, closeId, claimGeneration, "effects");
        // The Java lifecycle coordinator moves the fence to DRAINING after
        // it accepts the Harness effects; driving the route directly plays
        // that half, exactly as the store's saveEffects does.
        jdbc.update("UPDATE ma_session_head SET phase = 'DRAINING' WHERE"
                + " tenant_id = ? AND harness_session_id = ? AND"
                + " operation_id = ?", tenant, session.id(), closeId);
        driveLifecycle(session, closeId, claimGeneration,
                "prepare_resources");

        holdNextControl("mcp-release");
        Future<HttpResponse<String>> settle = caseExecutor.submit(
                () -> rawLifecycle(session, closeId, claimGeneration,
                        "settle_resources"));
        waitFor(() -> {
            assertThat(settle.isDone())
                    .as("settle finished before the hold: %s",
                            earlyBody(settle))
                    .isFalse();
            assertThat(configuration(session.id()).path("releaseState")
                    .asText())
                    .as("the release must be committed before its dispatch: %s",
                            earlyBody(settle))
                    .isEqualTo("releasing");
            assertThat(controls("mcp-release")).anyMatch(call ->
                    releaseId.equals(call.operationId())
                            && call.status() == 0);
        });
        assertThat(configuration(session.id()).path("run").path("execution")
                .asText()).isEqualTo("settled");
        killHarness();
        releaseControl();
        Map<String, Object> dispatched = awaitWireControl("mcp-release",
                releaseId, "running");
        JsonNode dispatchRequest = (JsonNode) dispatched.get("request");
        String runtimeSessionId = dispatchRequest.path("runtimeSessionId")
                .asText();
        assertThat(runtimeSessionId).isNotBlank();
        settle.cancel(true);

        SessionRef reloaded = reload(session, closeId, claimGeneration);
        // The conclusive answer is the settled `mcp-status`, not the release
        // dispatch, which legally answers `running`. Park that reply inside
        // the proxy: the record must stay `releasing` and the close route
        // must stay unanswered until the Harness receives it.
        holdSettledReply("mcp-status", releaseId);
        HttpResponse<String> settled = null;
        for (int attempt = 0; attempt < 60 && settled == null; attempt++) {
            Future<HttpResponse<String>> pending = caseExecutor.submit(
                    () -> rawLifecycle(reloaded, closeId, claimGeneration,
                            "settle_resources"));
            await().atMost(Duration.ofSeconds(60)).until(() ->
                    replyParked.getCount() == 0 || pending.isDone());
            if (replyParked.getCount() == 0) {
                try {
                    assertThat(pending.isDone())
                            .as("settle must wait for the held status reply")
                            .isFalse();
                    assertThat(configuration(session.id()).path("releaseState")
                            .asText())
                            .as("released must not be committed before the "
                                    + "settled answer reaches the Harness")
                            .isEqualTo("releasing");
                } finally {
                    releaseReply();
                }
                settled = pending.get(30, TimeUnit.SECONDS);
                break;
            }
            HttpResponse<String> response = pending.get(30,
                    TimeUnit.SECONDS);
            if (response.statusCode() == 200) {
                settled = response;
                break;
            }
            if (response.statusCode() == 409) {
                JsonNode refusal = json.readTree(response.body());
                String code = refusal.path("error").asText(
                        refusal.path("code").asText());
                if ("hosted_turn_active".equals(code)) {
                    Thread.sleep(1_000);
                    continue;
                }
            }
            assertThat(response.statusCode()).as("settle: %s",
                    response.body()).isEqualTo(503);
            Thread.sleep(1_000);
        }
        assertThat(settled).as("settle must complete").isNotNull();
        assertThat(settled.statusCode()).as("settle: %s", settled.body())
                .isEqualTo(200);
        assertThat(replyParked.getCount())
                .as("the settled status reply must be parked, or the ordering "
                        + "witness never ran")
                .isZero();

        JsonNode released = configuration(session.id());
        assertThat(released.path("releaseState").asText())
                .isEqualTo("released");
        assertThat(released.path("run").path("runtime"))
                .as("the replacement keeps the original generation")
                .isEqualTo(identity);
        assertThat(controls("mcp-release"))
                .as("the resumption looks the original release up; it does "
                        + "not mint a second release")
                .hasSize(1);
        assertThat(controls("mcp-configure")).isEmpty();
        assertThat(controls("mcp-invoke")).isEmpty();
        assertThat(wire.stream()
                .filter(entry -> ((Number) entry.get("seq")).intValue()
                        > wireBaseline)
                .filter(entry -> {
                    JsonNode request = (JsonNode) entry.get("request");
                    return request != null
                            && "mcp-status".equals(request.at(
                                    "/operation/kind").asText())
                            && releaseId.equals(request.at(
                                    "/operation/targetOperationId").asText())
                            && runtimeSessionId.equals(request.path(
                                    "runtimeSessionId").asText());
                })
                .filter(entry -> Integer.valueOf(200)
                        .equals(entry.get("status")))
                .filter(entry -> {
                    JsonNode answer = (JsonNode) entry.get("answer");
                    return answer != null && "settled".equals(
                            answer.path("result").path("state").asText());
                })
                .count())
                .as("a settled status lookup for the original release")
                .isPositive();
        assertThat(fixtureEvents("mcp.start"))
                .as("the release does not start a second server")
                .hasSize(1);
        assertThat(fixtureEvents("mcp.exit"))
                .as("the released stdio server exits once")
                .hasSize(1);
        ProcessHandle.of(fixturePid()).ifPresent(handle -> {
            try {
                handle.onExit().get(10, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // The fixture records mcp.exit just before it exits.
            }
        });
        assertThat(ProcessHandle.of(fixturePid()).map(
                ProcessHandle::isAlive).orElse(false))
                .as("the released stdio server is gone")
                .isFalse();
        assertThat(controlRequests("mcp-status").stream()
                .filter(request -> releaseId.equals(request.at(
                        "/operation/operationId").asText()))
                .map(request -> request.path("runtimeSessionId").asText())
                .filter(runtimeSessionId::equals).count())
                .as("the replacement addresses the original Runtime Session")
                .isPositive();
    }

    @Test
    @Timeout(600)
    void workerKillWhileIdleNeverMintsAFreshOwnerOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        JsonNode identity = configuration(session.id()).path("run")
                .path("runtime");
        assertThat(identity.isObject())
                .as("the baseline must record a Runtime identity").isTrue();
        kill(awaitWorkerPid());
        waitFor(() -> assertThat(fixtureEvents("mcp.exit"))
                .as("the stdio fixture exits on worker stdin EOF")
                .hasSize(1));
        ProcessHandle.of(fixturePid()).ifPresent(handle -> {
            try {
                handle.onExit().get(10, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // The fixture records mcp.exit just before it exits.
            }
        });
        assertThat(ProcessHandle.of(fixturePid()).map(
                ProcessHandle::isAlive).orElse(false)).isFalse();
        // A 202 only admits the prompt; the MCP refresh/acquire runs later
        // in the turn's declarations. Require the recovery acquire itself
        // to be refused by the dead generation before reading the identity,
        // or a fast assertion would only observe the pre-crash state.
        assertThat(harnessRequest("GET", "/session/" + session.id()
                + "/status", null, session.clientId(), 200)
                .path("recoveryBlocked").asBoolean()).isFalse();
        int wireBefore = wireSequence.get();
        HttpResponse<String> recovery = promptRaw(session,
                "FG12C_RECOVER_IDLE");
        assertThat(recovery.statusCode()).isIn(202, 409, 503);
        if (recovery.statusCode() == 202) {
            assertThat(json.readTree(recovery.body()).path("promptId")
                    .asText()).isNotBlank();
            waitFor(() -> {
                assertThat(wire.stream()
                        .filter(entry -> ((Number) entry.get("seq"))
                                .intValue() > wireBefore)
                        .anyMatch(this::deadAcquireRefused))
                        .as("the recovery acquire must be refused by the "
                                + "dead generation")
                        .isTrue();
                assertThat(harnessRequest("GET", "/session/" + session.id()
                        + "/status", null, session.clientId(), 200)
                        .path("hasActivePrompt").asBoolean()).isFalse();
            });
        } else {
            JsonNode refused = json.readTree(recovery.body());
            String code = refused.path("error").asText(
                    refused.path("code").asText());
            assertThat(code).as("a refusal must name the recovery failure")
                    .isIn("hosted_mcp_recovery_required",
                            "hosted_turn_recovery_required");
        }
        JsonNode after = configuration(session.id());
        assertThat(after.path("run").path("runtime"))
                .as("the replacement keeps the original generation")
                .isEqualTo(identity);
        assertThat(after.path("run").path("state").asText())
                .isEqualTo("settled");
        assertThat(fixtureEvents("mcp.start"))
                .as("no fresh Runtime generation starts a second server")
                .hasSize(1);
    }

    @Test
    @Timeout(600)
    void workerKillDuringOperationSettlesOutcomeUnknownOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String operation = uuid();
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", Map.of("operationId", operation,
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://hold")),
                        session, 202));
        waitFor(() -> assertThat(fixtureEvents("mcp.hold")).hasSize(1));
        kill(awaitWorkerPid());
        waitFor(() -> assertThat(fixtureEvents("mcp.exit")).hasSize(1));
        waitFor(() -> assertThat(operations(session.id()).getLast()
                .path("run").path("execution").asText())
                .isEqualTo("outcome_unknown"));
        assertThat(operations(session.id()).getLast().path("run").path("state")
                .asText()).isEqualTo("recovery_blocked");
        assertThat(effects("resource_read")).doesNotContain("ext://hold");
        assertThat(controls("mcp-invoke")).hasSize(1);
        assertThat(fixtureEvents("mcp.start")).hasSize(1);
        pending.cancel(true);
    }

    @Test
    @Timeout(600)
    void stdioKillDuringRequestSettlesOutcomeUnknownOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String operation = uuid();
        Future<JsonNode> pending = caseExecutor.submit(
                () -> privateRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", Map.of("operationId", operation,
                        "serverId", "fixture", "request", Map.of("kind",
                                "resource_read", "uri", "ext://hold")),
                        session, 202));
        waitFor(() -> assertThat(fixtureEvents("mcp.hold")).hasSize(1));
        kill(fixturePid());
        waitFor(() -> assertThat(operations(session.id()).getLast()
                .path("run").path("execution").asText())
                .isEqualTo("outcome_unknown"));
        assertThat(operations(session.id()).getLast().path("run").path("state")
                .asText()).isEqualTo("recovery_blocked");
        assertThat(effects("resource_read")).doesNotContain("ext://hold");
        assertThat(controls("mcp-invoke")).hasSize(1);
        assertThat(fixtureEvents("mcp.start")).hasSize(1);
        pending.cancel(true);
    }

    private long fixturePid() {
        return fixtureEvents("mcp.start").getFirst().path("pid").asLong();
    }

    private long workerPid() throws IOException {
        try (var files = Files.list(temporary.resolve("broker"))) {
            for (Path file : files.filter(path -> path.getFileName()
                    .toString().endsWith(".json")).toList()) {
                long pid = json.readTree(Files.readString(file))
                        .path("pid").asLong();
                if (pid > 0 && ProcessHandle.of(pid)
                        .map(ProcessHandle::isAlive).orElse(false)) {
                    return pid;
                }
            }
        }
        throw new AssertionError("No durable Runtime worker registered");
    }

    private long awaitWorkerPid() {
        java.util.concurrent.atomic.AtomicLong pid =
                new java.util.concurrent.atomic.AtomicLong();
        await().atMost(Duration.ofSeconds(30)).ignoreExceptions()
                .untilAsserted(() -> pid.set(workerPid()));
        return pid.get();
    }

    private void kill(long pid) throws Exception {
        ProcessHandle handle = ProcessHandle.of(pid)
                .orElseThrow(() -> new AssertionError("pid " + pid));
        handle.destroyForcibly();
        handle.onExit().get(10, TimeUnit.SECONDS);
    }

    private void killHarness() throws Exception {
        Process dead = harness;
        dead.destroyForcibly();
        assertThat(dead.waitFor(10, TimeUnit.SECONDS))
                .as("the Harness must die before the replacement starts")
                .isTrue();
    }

    private void refuseNextControl(String kind) {
        refuseNextKind = kind;
        refuseArmed.set(true);
    }

    private void holdNextControl(String kind) {
        controlHoldKind = kind;
        controlHold = new CountDownLatch(1);
    }

    private void releaseControl() {
        CountDownLatch latch = controlHold;
        controlHold = null;
        controlHoldKind = null;
        if (latch != null) {
            latch.countDown();
        }
    }

    // A release dispatch answers `running`; only the later `mcp-status`
    // lookup is conclusive. Parking that answer inside the proxy separates
    // "the Broker settled it" from "the Harness received it", which is what
    // proves `released` cannot be committed before it.
    private void holdSettledReply(String kind, String targetOperationId) {
        replyHoldKind = kind;
        replyHoldTarget = targetOperationId;
        replyParked = new CountDownLatch(1);
        replyHold = new CountDownLatch(1);
    }

    // invoke() commits `intent`, acquires the owner and only then commits
    // `dispatch_started`. Parking the first acquire that arrives while the
    // durable record is still `intent` opens the pre-dispatch window without
    // seeding a row; later acquires pass, so a cancel that needs the Broker
    // still reaches it.
    private void holdAcquireAtIntent(SessionRef session, String operationId) {
        acquireHoldSession = session.id();
        acquireHoldOperation = operationId;
        acquireParked = new CountDownLatch(1);
        acquireHold = new CountDownLatch(1);
        acquireArmed.set(true);
    }

    private void releaseAcquire() {
        acquireArmed.set(false);
        CountDownLatch latch = acquireHold;
        if (latch != null) {
            latch.countDown();
        }
    }

    private boolean operationAtIntent(String session, String operationId) {
        try {
            return operations(session).stream().anyMatch(record ->
                    operationId.equals(record.path("operationId").asText())
                            && "intent".equals(record.path("run")
                                    .path("execution").asText()));
        } catch (RuntimeException | AssertionError unreadable) {
            // A missing record reads as an empty list, so a throw here is a
            // broken read; keep it for the park assertion's message.
            acquireProbeFailure = unreadable;
            return false;
        }
    }

    private void releaseReply() {
        CountDownLatch latch = replyHold;
        replyHold = null;
        replyHoldKind = null;
        replyHoldTarget = null;
        if (latch != null) {
            latch.countDown();
        }
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

    @Test
    @Timeout(600)
    void firstReleaseRefusedBeforeForwardingResumesUnderTheSameId()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        JsonNode configuration = configuration(session.id());
        String configurationId = configuration.path("configurationId")
                .asText();
        String releaseId = configurationId + ":release";
        assertThat(configuration.path("run").path("runtime").isObject())
                .isTrue();
        assertThat(configuration.path("releaseState").asText())
                .isEqualTo("active");
        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id ="
                + " ? AND session_id = ?", PROFILE, tenant, session.id());
        OperationRecord close = admitClose(session);
        String closeId = close.operationId();
        long claimGeneration = close.claimGeneration();
        driveLifecycle(session, closeId, claimGeneration, "effects");
        jdbc.update("UPDATE ma_session_head SET phase = 'DRAINING' WHERE"
                + " tenant_id = ? AND harness_session_id = ? AND"
                + " operation_id = ?", tenant, session.id(), closeId);
        driveLifecycle(session, closeId, claimGeneration,
                "prepare_resources");
        refuseNextControl("mcp-release");
        HttpResponse<String> settled = null;
        for (int attempt = 0; attempt < 60 && settled == null; attempt++) {
            HttpResponse<String> response = rawLifecycle(session, closeId,
                    claimGeneration, "settle_resources");
            if (response.statusCode() == 200) {
                settled = response;
                break;
            }
            JsonNode refusal = json.readTree(response.body());
            String code = refusal.path("error").asText(
                    refusal.path("code").asText());
            if (response.statusCode() == 409
                    && "hosted_turn_active".equals(code)) {
                Thread.sleep(500);
                continue;
            }
            assertThat(response.statusCode())
                    .as("settle: %s", response.body()).isEqualTo(503);
            Thread.sleep(500);
        }
        assertThat(settled).as("settle must complete").isNotNull();
        List<ProxyCall> releases = controls("mcp-release");
        assertThat(releases).hasSize(2);
        assertThat(releases).allMatch(call ->
                releaseId.equals(call.operationId()));
        assertThat(releases.getFirst().status()).isEqualTo(503);
        assertThat(releases.getLast().status()).isEqualTo(200);
        List<Map<String, Object>> releaseWire = wire.stream()
                .filter(entry -> ((Number) entry.get("seq")).intValue()
                        > wireBaseline)
                .filter(entry -> {
                    JsonNode request = (JsonNode) entry.get("request");
                    return request != null
                            && "mcp-release".equals(request.at(
                                    "/operation/kind").asText());
                })
                .toList();
        assertThat(releaseWire).hasSize(2);
        assertThat(releaseWire.getFirst().get("status")).isEqualTo(503);
        assertThat(((JsonNode) releaseWire.getFirst().get("answer"))
                .path("result").isMissingNode()).isTrue();
        assertThat(releaseWire.getLast().get("status")).isEqualTo(200);
        assertThat(releaseWire).allMatch(entry -> {
            JsonNode request = (JsonNode) entry.get("request");
            return releaseId.equals(request.at(
                    "/operation/operationId").asText());
        });
        assertThat(configuration(session.id()).path("releaseState").asText())
                .isEqualTo("released");
        assertThat(controls("mcp-configure")).isEmpty();
        assertThat(controls("mcp-invoke")).isEmpty();
    }

    // FG12d (issue #14447, #14880 item 2): a cancel that lands before the raw
    // operation is dispatched. The proxy parks invoke()'s owner acquire, so
    // the durable record is still `intent` when the cancel arrives through
    // the supported Harness route. The cancel proves the operation never
    // started; the resumed invoke and a same-id retry read that proof, and
    // nothing after the parked acquire reaches the Broker as an MCP control.
    @Test
    @Timeout(600)
    void cancelBeforeDispatchIsNotStartedProvenOnMySql() throws Exception {
        SessionRef session = createSession();
        baseline(session);
        String operation = uuid();
        String invoke = json.writeValueAsString(Map.of("operationId",
                operation, "serverId", "fixture", "request", Map.of("kind",
                        "resource_read", "uri", "ext://proof")));
        holdAcquireAtIntent(session, operation);
        Future<HttpResponse<String>> pending = caseExecutor.submit(
                () -> rawRequest("POST", "/session/" + session.id()
                        + "/mcp/operations", invoke, session.clientId()));
        assertThat(acquireParked.await(60, TimeUnit.SECONDS))
                .as("the owner acquire after the intent commit is parked"
                        + " (last record read failure: %s)",
                        acquireProbeFailure)
                .isTrue();
        JsonNode intent = operations(session.id()).getLast();
        assertThat(intent.path("operationId").asText()).isEqualTo(operation);
        assertThat(intent.path("run").path("execution").asText())
                .isEqualTo("intent");
        assertThat(intent.path("cancelRequested").asBoolean()).isFalse();
        assertThat(pending.isDone())
                .as("the invoke waits on the parked acquire").isFalse();

        JsonNode cancelled = privateRequest("POST", "/session/" + session.id()
                + "/mcp/operations/" + operation + "/cancel", Map.of(),
                session, 202);
        assertThat(cancelled.path("state").asText()).isEqualTo("settled");
        assertThat(cancelled.path("error").path("code").asText())
                .isEqualTo("managed_mcp_cancelled");
        JsonNode proven = operations(session.id()).getLast();
        assertThat(proven.path("run").path("state").asText())
                .isEqualTo("cancelled");
        assertThat(proven.path("run").path("execution").asText())
                .isEqualTo("not_started_proven");
        assertThat(proven.path("cancelRequested").asBoolean()).isTrue();
        assertThat(proven.path("resultRef").isNull()).isTrue();
        assertThat(pending.isDone())
                .as("the cancel did not need the parked acquire").isFalse();

        releaseAcquire();
        HttpResponse<String> resumed = pending.get(60, TimeUnit.SECONDS);
        assertThat(resumed.statusCode()).as(resumed.body()).isEqualTo(202);
        JsonNode resumedView = json.readTree(resumed.body());
        assertThat(resumedView.path("state").asText()).isEqualTo("settled");
        assertThat(resumedView.path("error").path("code").asText())
                .as("the resumed invoke reads the proof, not the Runtime")
                .isEqualTo("managed_mcp_cancelled");
        HttpResponse<String> retried = rawRequest("POST", "/session/"
                + session.id() + "/mcp/operations", invoke,
                session.clientId());
        assertThat(retried.statusCode()).as(retried.body()).isEqualTo(202);
        assertThat(json.readTree(retried.body()).path("error").path("code")
                .asText()).isEqualTo("managed_mcp_cancelled");
        HttpResponse<String> status = rawStatus(session, operation);
        assertThat(status.statusCode()).as(status.body()).isEqualTo(200);
        assertThat(json.readTree(status.body()).path("error").path("code")
                .asText()).isEqualTo("managed_mcp_cancelled");

        JsonNode settled = operations(session.id()).getLast();
        assertThat(settled.path("run").path("state").asText())
                .isEqualTo("cancelled");
        assertThat(settled.path("run").path("execution").asText())
                .isEqualTo("not_started_proven");
        assertThat(settled.path("resultRef").isNull()).isTrue();
        int parkedSeq = acquireParkedSeq;
        assertThat(proxyCalls).filteredOn(call -> call.seq() == parkedSeq)
                .singleElement()
                .satisfies(call -> assertThat(call.status()).isEqualTo(200));
        assertThat(proxyCalls.stream().filter(call -> call.seq() > parkedSeq)
                .filter(call -> call.kind() != null).toList())
                .as("no MCP control reaches the Broker after the parked"
                        + " acquire")
                .isEmpty();
        assertThat(controls("mcp-invoke")).isEmpty();
        assertThat(controls("mcp-cancel"))
                .as("an undispatched operation needs no native cancel")
                .isEmpty();
        assertThat(effects("resource_read")).isEmpty();
        assertThat(fixtureEvents("mcp.start"))
                .as("baseline rev 1 only").hasSize(1);
    }

    // FG12d R1-1 (issue #14447, #14880 item 3): the owner release of a
    // lifecycle v2 close is refused before it reaches the Broker, after every
    // configuration is `drained`; then Spring, and with it the embedded
    // Broker, is replaced. The new Broker holds no local context for the
    // Session, so the Harness's retry lands on the persisted-Session release
    // path. Detach must recover with that one owner release: no acquire and
    // no MCP control, and the storage holder clears.
    @Test
    @Timeout(600)
    void ownerReleaseRefusedThenSpringRestartReleasesTheHolderOnMySql()
            throws Exception {
        SessionRef session = createSession();
        baseline(session);
        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id ="
                + " ? AND session_id = ?", PROFILE, tenant, session.id());
        OperationRecord close = admitClose(session);
        String closeId = close.operationId();
        long claimGeneration = close.claimGeneration();
        driveLifecycle(session, closeId, claimGeneration, "effects");
        jdbc.update("UPDATE ma_session_head SET phase = 'DRAINING' WHERE"
                + " tenant_id = ? AND harness_session_id = ? AND"
                + " operation_id = ?", tenant, session.id(), closeId);
        driveLifecycle(session, closeId, claimGeneration,
                "prepare_resources");

        refuseNextOwnerRelease();
        HttpResponse<String> refused = rawLifecycle(session, closeId,
                claimGeneration, "settle_resources");
        assertThat(refused.statusCode()).as(refused.body()).isEqualTo(503);
        assertThat(json.readTree(refused.body()).path("code").asText())
                .isEqualTo("workspace_lifecycle_resources_unsettled");
        assertThat(ownerReleaseCalls()).extracting(ProxyCall::status)
                .as("the only owner release is refused before forwarding")
                .containsExactly(503);
        assertThat(configuration(session.id()).path("releaseState").asText())
                .as("the drain receipt is committed before the owner release")
                .isEqualTo("drained");
        assertThat(storageHolders(session))
                .as("the refused release keeps the storage holder")
                .isEqualTo(1);
        List<Map<String, Object>> runtimeBefore = runtimeState(session);
        assertThat(runtimeBefore).extracting(row -> row.get("session_state"))
                .containsExactly("READY");

        restartSpring();
        int restartSeq = proxySequence.get();
        assertThat(runtimeState(session))
                .as("the restart settles nothing on its own")
                .isEqualTo(runtimeBefore);
        assertThat(storageHolders(session)).isEqualTo(1);

        // The Harness's Session writer lease may lapse while Spring is down;
        // the lifecycle route answers unsettled until the writer is active
        // again, and that attempt sends nothing to the Broker.
        HttpResponse<String> settled = null;
        for (int attempt = 0; attempt < 30 && settled == null; attempt++) {
            HttpResponse<String> response = rawLifecycle(session, closeId,
                    claimGeneration, "settle_resources");
            if (response.statusCode() == 200) {
                settled = response;
                break;
            }
            String code = json.readTree(response.body()).path("code")
                    .asText();
            assertThat(code).as("settle: %s", response.body())
                    .isIn("workspace_lifecycle_resources_unsettled",
                            "hosted_turn_active");
            Thread.sleep(1_000);
        }
        assertThat(settled).as("detach recovers after the Spring restart")
                .isNotNull();
        assertThat(proxyCalls.stream()
                .filter(call -> call.seq() > restartSeq).toList())
                .as("after the restart the Harness resends only the owner"
                        + " release: no acquire and no MCP control")
                .singleElement()
                .satisfies(call -> {
                    assertThat(call.path()).endsWith(":release");
                    assertThat(call.kind()).isNull();
                    assertThat(call.status()).isEqualTo(200);
                });
        assertThat(ownerReleaseCalls()).extracting(ProxyCall::status)
                .containsExactly(503, 200);
        assertThat(storageHolders(session))
                .as("the replaced Broker releases the original owner")
                .isZero();
        assertThat(configuration(session.id()).path("releaseState").asText())
                .isEqualTo("released");
        assertThat(runtimeState(session)).extracting(
                row -> row.get("session_state")).containsExactly("RELEASED");
        assertThat(controls("mcp-configure")).isEmpty();
        assertThat(controls("mcp-invoke")).isEmpty();
        assertThat(controls("mcp-release"))
                .as("the release was dispatched once, before the restart")
                .hasSize(1);
        assertThat(fixtureEvents("mcp.start")).hasSize(1);
        assertThat(fixtureEvents("mcp.exit")).hasSize(1);
    }

    private void refuseNextOwnerRelease() {
        ownerReleaseRefuseArmed.set(true);
    }

    // A whole-Spring restart replaces the embedded Broker. The Broker's close
    // writes nothing, and the durable local provisioner leaves the worker
    // running, so this stands in for a Broker that died between the drain
    // receipt and the owner release.
    private void restartSpring() {
        spring.close();
        startSpring();
    }

    private List<ProxyCall> ownerReleaseCalls() {
        return proxyCalls.stream().filter(call -> "POST".equals(call.method())
                && call.path().endsWith(":release")).toList();
    }

    private int storageHolders(SessionRef session) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session s"
                + " JOIN ma_runtime_binding b ON s.binding_id = b.binding_id"
                + " AND s.runtime_generation = b.runtime_generation"
                + " WHERE s.tenant_id = ? AND b.tenant_id = ? AND"
                + " s.harness_session_id = ? AND"
                + " s.execution_storage_key IS NOT NULL", Integer.class,
                tenant, tenant, session.id());
    }

    private List<Map<String, Object>> runtimeState(SessionRef session) {
        return jdbc.queryForList("SELECT b.binding_id, b.binding_state,"
                + " b.runtime_generation AS binding_generation,"
                + " s.runtime_session_id, s.session_state,"
                + " s.runtime_generation FROM ma_runtime_session s JOIN"
                + " ma_runtime_binding b ON s.binding_id = b.binding_id WHERE"
                + " s.tenant_id = ? AND s.harness_session_id = ?", tenant,
                session.id());
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

    private void triggerTurn(SessionRef session) {
        try {
            assertThat(promptRaw(session, "FG12C_RECOVER").statusCode())
                    .isIn(202, 409, 503);
        } catch (Exception failed) {
            throw new IllegalStateException(failed);
        }
    }

    private HttpResponse<String> promptRaw(SessionRef session, String text)
            throws Exception {
        List<Map<String, Object>> prompt = List.of(
                Map.of("type", "text", "text", text));
        String payload = json.writeValueAsString(prompt);
        Map<String, Object> body = Map.of("promptId", uuid(), "prompt", prompt,
                "payloadDigest", "sha256:" + DigestUtils.sha256Hex(payload));
        return rawRequest("POST", "/session/" + session.id() + "/prompt",
                json.writeValueAsString(body), session.clientId());
    }

    private HttpResponse<String> rawStatus(SessionRef session,
            String operationId) throws Exception {
        return rawRequest("GET", "/session/" + session.id()
                + "/mcp/operations/" + operationId, null, session.clientId());
    }

    private boolean deadAcquireRefused(Map<String, Object> entry) {
        if (!"POST".equals(entry.get("method"))
                || !String.valueOf(entry.get("path")).endsWith(":acquire")) {
            return false;
        }
        JsonNode answer = (JsonNode) entry.get("answer");
        if (answer == null) {
            return false;
        }
        int status = ((Number) entry.get("status")).intValue();
        String error = answer.path("error").asText();
        return (status == 409
                && ("Runtime generation is no longer live".equals(error)
                        || "Runtime Session is not ready".equals(error)))
                || (status == 503
                        && "Managed Runtime process is not alive."
                                .equals(error));
    }

    private Map<String, Object> terminalStatus(String configuration) {
        return wire.stream()
                .filter(entry -> ((Number) entry.get("seq")).intValue()
                        > wireBaseline)
                .filter(entry -> {
                    JsonNode request = (JsonNode) entry.get("request");
                    return request != null
                            && "mcp-status".equals(request.at(
                                    "/operation/kind").asText())
                            && configuration.equals(request.at(
                                    "/operation/targetOperationId").asText());
                })
                .filter(entry -> Integer.valueOf(200)
                        .equals(entry.get("status")))
                .filter(entry -> {
                    JsonNode answer = (JsonNode) entry.get("answer");
                    String state = answer == null ? ""
                            : answer.path("result").path("state").asText();
                    return "settled".equals(state)
                            || "outcome_unknown".equals(state);
                })
                .findFirst().orElse(null);
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

    private List<JsonNode> controlRequests(String kind) {
        return wire.stream()
                .filter(entry -> ((Number) entry.get("seq")).intValue()
                        > wireBaseline)
                .map(entry -> (JsonNode) entry.get("request"))
                .filter(request -> request != null
                        && kind.equals(request.at("/operation/kind").asText()))
                .toList();
    }

    private String earlyBody(Future<HttpResponse<String>> future) {
        if (!future.isDone()) {
            return "";
        }
        try {
            HttpResponse<String> response = future.get();
            return response.statusCode() + " " + response.body();
        } catch (Exception failure) {
            return String.valueOf(failure);
        }
    }

    private Map<String, Object> awaitWireControl(String kind,
            String operationId, String state) {
        AtomicReference<Map<String, Object>> found = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(60)).ignoreExceptions()
                .untilAsserted(() -> {
                    wire.stream()
                            .filter(entry -> ((Number) entry.get("seq"))
                                    .intValue() > wireBaseline)
                            .filter(entry -> {
                                JsonNode request = (JsonNode) entry.get("request");
                                return request != null
                                        && kind.equals(request.at(
                                                "/operation/kind").asText())
                                        && operationId.equals(request.at(
                                                "/operation/operationId")
                                                .asText());
                            })
                            .filter(entry -> Integer.valueOf(200)
                                    .equals(entry.get("status")))
                            .filter(entry -> {
                                if (state == null) {
                                    return true;
                                }
                                JsonNode answer = (JsonNode) entry.get("answer");
                                return answer != null && state.equals(answer
                                        .path("result").path("state").asText());
                            })
                            .findFirst().ifPresent(found::set);
                    assertThat(found.get())
                            .as("%s %s must settle before the replacement",
                                    kind, operationId)
                            .isNotNull();
                });
        return found.get();
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
        return reload(session, null, 0);
    }

    private SessionRef reload(SessionRef session, String lifecycleOperation,
            long claimGeneration) throws Exception {
        startHarness();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionScope", "thread");
        body.put("toolProfile", PROFILE);
        body.put("approvalMode", "yolo");
        body.put("mcpServers", List.of(mcpPin(1)));
        body.put("managedSessionStore", storeDescriptor());
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
        // The storage registration and the Workspace rows are durable, so a
        // restarted context reuses them. Registering again is an operator
        // action, and the guard refuses it while the holder is booked.
        if (springSeeded) {
            return;
        }
        springSeeded = true;
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
        brokerExecutor = Executors.newVirtualThreadPerTaskExecutor();
        brokerProxy.setExecutor(brokerExecutor);
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
        if ("POST".equals(exchange.getRequestMethod())
                && path.endsWith(":release")
                && ownerReleaseRefuseArmed.compareAndSet(true, false)) {
            proxyCalls.set(index, call.complete(503));
            entry.put("status", 503);
            entry.put("answer", json.createObjectNode()
                    .put("error", "injected_refusal"));
            wire.add(entry);
            byte[] refusal = json.writeValueAsString(
                    Map.of("error", "injected_refusal"))
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(503, refusal.length);
            exchange.getResponseBody().write(refusal);
            exchange.close();
            return;
        }
        if (refuseNextKind != null && refuseNextKind.equals(kind)
                && refuseArmed.compareAndSet(true, false)) {
            proxyCalls.set(index, call.complete(503));
            entry.put("status", 503);
            entry.put("answer", json.createObjectNode()
                    .put("error", "injected_refusal"));
            wire.add(entry);
            byte[] refusal = json.writeValueAsString(
                    Map.of("error", "injected_refusal"))
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(503, refusal.length);
            exchange.getResponseBody().write(refusal);
            exchange.close();
            return;
        }
        // The owner acquire carries no control kind, so it is matched by
        // path; the durable record decides which acquire is the one invoke()
        // issues between its `intent` and `dispatch_started` commits.
        if (path.endsWith("/tool-sessions:acquire") && acquireArmed.get()
                && operationAtIntent(acquireHoldSession,
                        acquireHoldOperation)
                && acquireArmed.compareAndSet(true, false)) {
            acquireParkedSeq = call.seq();
            acquireParked.countDown();
            try {
                acquireHold.await(120, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        CountDownLatch hold = controlHold;
        if (hold != null && controlHoldKind != null
                && controlHoldKind.equals(kind)) {
            try {
                hold.await(120, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
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
            JsonNode answer;
            try {
                answer = json.readTree(response.body());
            } catch (IOException unparsable) {
                answer = null;
            }
            entry.put("answer", answer != null ? answer
                    : new String(response.body(), StandardCharsets.UTF_8));
            wire.add(entry);
            CountDownLatch reply = replyHold;
            if (reply != null && parsed != null && replyHoldKind != null
                    && replyHoldKind.equals(kind)
                    && replyHoldTarget != null
                    && replyHoldTarget.equals(parsed.at(
                            "/operation/targetOperationId").asText())
                    && answer != null
                    && "settled".equals(answer.path("result").path("state")
                            .asText())) {
                CountDownLatch parked = replyParked;
                if (parked != null) {
                    parked.countDown();
                }
                try {
                    reply.await(120, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
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
        // A case that fails while the owner acquire is parked would otherwise
        // leave its pending invoke waiting, and caseExecutor.close() with it.
        releaseAcquire();
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
            if (brokerExecutor != null) {
                brokerExecutor.shutdownNow();
            }
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
        assertThat(caseLetter).as("caseLetter must be set by each test").isNotNull();
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

    private record ProxyCall(String method, String path, String kind,
            int status, String operationId, int seq) {
        ProxyCall complete(int value) {
            return new ProxyCall(method, path, kind, value, operationId, seq);
        }
    }
}
