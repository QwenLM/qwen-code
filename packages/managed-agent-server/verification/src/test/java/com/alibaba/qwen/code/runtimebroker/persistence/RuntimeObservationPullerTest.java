package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.fastjson2.JSON;
import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WakeStamp;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcRuntimeStageStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.http.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocol;
import com.alibaba.qwen.code.runtimebroker.provisioning.staticruntime.StaticRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * End-to-end H2 + loopback HTTP verification for Phase 3b observation-pull,
 * single-puller binding claims across Broker replicas, publisher detach,
 * staged delivery list/acknowledge, and post-restart durable adoption.
 */
class RuntimeObservationPullerTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String WRITER_TOKEN = "w".repeat(32);
    private static final String BROKER_SECRET = "broker-secret-token";
    private static final String WORKER_TOKEN = "worker-lease-token";
    private static final String TENANT = "tenant";
    private static final String WORKSPACE = "workspace";

    private JdbcDataSource source;
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate tx;
    private JdbcManagedSessionStore sessionStore;
    private JdbcRuntimeBindingRepository bindingRepo;
    private JdbcRuntimeSessionRepository runtimeSessionRepo;
    private JdbcToolExecutionRepository executionRepo;
    private JdbcRuntimeStageStore stageStore;
    private HttpServer workerServer;
    private HttpClient httpClient;
    private RuntimeScope scope;
    private String harnessSessionId;
    private String runtimeSessionId;
    private long writerGeneration;

    private final AtomicBoolean workerAttached = new AtomicBoolean(true);
    private final AtomicLong workerAckedThrough = new AtomicLong();
    private final List<Map<String, Object>> workerOutbox = new CopyOnWriteArrayList<>();
    private final List<Long> observedAckThroughs = new CopyOnWriteArrayList<>();
    private final List<RuntimeBrokerService> openServices = new ArrayList<>();
    private final List<RuntimeBrokerHttpServer> openServers = new ArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:obs-puller-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        sessionStore = VerificationFixtures.managedSessionStore(jdbc);
        bindingRepo = new JdbcRuntimeBindingRepository(
                source, new AesGcmSecretProtector("test", new byte[32]));
        runtimeSessionRepo = new JdbcRuntimeSessionRepository(source);
        executionRepo = new JdbcToolExecutionRepository(source);
        stageStore = new JdbcRuntimeStageStore(jdbc);
        httpClient = HttpClient.newHttpClient();

        harnessSessionId = "hs-" + UUID.randomUUID();
        runtimeSessionId = "rts-" + UUID.randomUUID();
        scope = new RuntimeScope(
                TENANT, WORKSPACE, "1", "/workspace",
                "sha256:" + "1".repeat(64), "workspace");

        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                + " gmt_create, gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                TENANT, harnessSessionId);
        acquireWriter();
        commitGenesis();
        startWorkerServer();
    }

    @AfterEach
    void tearDown() {
        for (RuntimeBrokerHttpServer server : openServers) {
            server.close();
        }
        for (RuntimeBrokerService service : openServices) {
            service.close();
        }
        if (workerServer != null) {
            workerServer.stop(0);
        }
    }

    @Test
    void detachesStagesViaSinglePullerAndAdoptsAcrossBrokerRestart() throws Exception {
        RuntimeBrokerService brokerA = newBroker("broker-a");
        RuntimeBrokerHttpServer serverA = newHttpServer(brokerA);
        RuntimeBrokerService brokerB = newBroker("broker-b");

        // Acquire Runtime Session on brokerA and seed unsettled background run call-1.
        HttpResponse<String> acquired = postBroker(serverA, "/tool-sessions:acquire", Map.of(
                "protocolVersion", 1,
                "requestId", "acq-1",
                "harnessSessionId", harnessSessionId,
                "runtimeSessionId", runtimeSessionId,
                "turnKind", "bootstrap"));
        assertThat(acquired.statusCode()).isEqualTo(200);
        var binding = bindingRepo.findActive(new com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest(
                scope, null, "static"));
        seedBackgroundRun(binding.getBindingId(), binding.getGeneration(), "call-1");

        // While attached, scanning both brokerA and brokerB stages nothing (worker answers status=attached).
        brokerA.runObservationScanOnce().toCompletableFuture().join();
        brokerB.runObservationScanOnce().toCompletableFuture().join();
        assertThat(stageStore.highestStagedSequence("call-1")).isZero();

        // Populate worker outbox (output seq 1 + terminal seq 2), then detach publisher via HTTP!
        workerOutbox.add(outputEntry("call-1", 1L, "seg-1", "page-1", "man-1", "bg-out\n"));
        workerOutbox.add(terminalEntry("call-1", 2L, "man-2"));
        sealWriter();

        HttpResponse<String> detached = postBroker(
                serverA,
                "/tool-sessions/" + runtimeSessionId + "/publisher/detach",
                Map.of(
                        "protocolVersion", 1,
                        "requestId", "det-1",
                        "harnessSessionId", harnessSessionId,
                        "writerGeneration", writerGeneration));
        assertThat(detached.statusCode()).isEqualTo(200);
        assertThat(workerAttached.get()).isFalse();

        // Both brokers scan concurrently; single-puller claim ensures clean staging + terminal ackThrough=2!
        brokerA.runObservationScanOnce().toCompletableFuture().join();
        brokerB.runObservationScanOnce().toCompletableFuture().join();
        waitUntil(() -> stageStore.highestStagedSequence("call-1") == 2L && observedAckThroughs.contains(2L));

        ToolExecutionRecord settledProcess = executionRepo.findByExecutionCallId("call-1:process");
        assertThat(settledProcess.isTerminal()).isTrue();
        assertThat(settledProcess.getExecutionStatus()).isEqualTo("success");
        assertThat(jdbc.queryForObject(
                "SELECT is_wake_pending FROM ma_session_head WHERE session_id = ?",
                Integer.class, harnessSessionId)).isEqualTo(1);

        // Seed a second active background run call-2, then close brokerA & brokerB to simulate full Broker restart!
        seedBackgroundRun(binding.getBindingId(), binding.getGeneration(), "call-2");
        serverA.close();
        brokerA.close();
        brokerB.close();
        openServers.clear();
        openServices.clear();

        // Start a brand-new Broker instance (brokerC) with empty in-memory maps — NO acquire call!
        RuntimeBrokerService brokerC = newBroker("broker-c");
        RuntimeBrokerHttpServer serverC = newHttpServer(brokerC);

        acquireWriter();
        // 1. Publisher re-attach adopts durable binding + Runtime Session and returns observedRuns!
        HttpResponse<String> reattached = postBroker(
                serverC,
                "/tool-sessions/" + runtimeSessionId + ":publisher",
                Map.of(
                        "protocolVersion", 1,
                        "requestId", "pub-2",
                        "harnessSessionId", harnessSessionId,
                        "runtimeSessionId", runtimeSessionId,
                        "writerGeneration", writerGeneration,
                        "publisher", Map.of(
                                "url", "http://127.0.0.1:19999/internal/hosted-shell-publisher/v1",
                                "token", "p".repeat(43))));
        assertThat(reattached.statusCode()).isEqualTo(200);
        var reattachedJson = JSON.parseObject(reattached.body());
        assertThat(reattachedJson.getBooleanValue("observation")).isTrue();
        assertThat(reattachedJson.getJSONObject("observedRuns").getLongValue("call-1")).isEqualTo(2L);

        // 2. Staged deliveries list & acknowledge succeed over HTTP under active writer lease!
        HttpResponse<String> listed = postBroker(
                serverC,
                "/harness-sessions/" + harnessSessionId + "/staged-deliveries/list",
                Map.of(
                        "protocolVersion", 1,
                        "requestId", "list-1",
                        "harnessSessionId", harnessSessionId,
                        "writerId", "writer",
                        "writerGeneration", writerGeneration));
        assertThat(listed.statusCode()).isEqualTo(200);
        assertThat(JSON.parseObject(listed.body()).getJSONArray("entries")).hasSize(2);

        HttpResponse<String> acked = postBroker(
                serverC,
                "/harness-sessions/" + harnessSessionId + "/staged-deliveries/acknowledge",
                Map.of(
                        "protocolVersion", 1,
                        "requestId", "ack-1",
                        "harnessSessionId", harnessSessionId,
                        "writerId", "writer",
                        "writerGeneration", writerGeneration,
                        "executionCallId", "call-1",
                        "throughSeq", 2L));
        assertThat(acked.statusCode()).isEqualTo(200);
        assertThat(stageStore.highestStagedSequence("call-1")).isZero();

        // 3. Public task cancel (stopBackgroundProcess) on restarted brokerC adopts durable session and settles call-2!
        ToolExecutionRecord stopped = brokerC.stopBackgroundProcess(TENANT, harnessSessionId, "call-2")
                .toCompletableFuture().join();
        assertThat(stopped.isTerminal()).isTrue();
    }

    private RuntimeBrokerService newBroker(String ownerId) {
        URI workerUri = URI.create("http://127.0.0.1:" + workerServer.getAddress().getPort());
        RuntimeLease staticLease = new RuntimeLease("inst-1", workerUri, WORKER_TOKEN, "lease-1", 1L);
        HttpRuntimeTransport httpTransport = new HttpRuntimeTransport(httpClient);
        RuntimeTransport transport = new ForwardingV3Transport(httpTransport);
        HarnessSessionResolver resolver = new HarnessSessionResolver() {
            @Override
            public CompletionStage<RuntimeScope> resolve(String id) {
                return CompletableFuture.completedFuture(scope);
            }

            @Override
            public CompletionStage<String> resolveTenant(String id) {
                return CompletableFuture.completedFuture(TENANT);
            }
        };
        RuntimeBrokerService service = new RuntimeBrokerService(
                resolver,
                new StaticRuntimeProvisioner(staticLease),
                transport,
                bindingRepo,
                runtimeSessionRepo,
                executionRepo,
                ownerId,
                Duration.ofMinutes(1),
                Duration.ofMinutes(1),
                null);
        service.configureStageStore(
                stageStore, Duration.ofSeconds(30), Duration.ofMillis(200), 50, 100L);
        openServices.add(service);
        return service;
    }

    private RuntimeBrokerHttpServer newHttpServer(RuntimeBrokerService service) throws IOException {
        RuntimeBrokerHttpServer server = new RuntimeBrokerHttpServer(
                new InetSocketAddress("127.0.0.1", 0), BROKER_SECRET, service);
        server.start();
        openServers.add(server);
        return server;
    }

    private HttpResponse<String> postBroker(
            RuntimeBrokerHttpServer server,
            String path,
            Map<String, Object> body) throws Exception {
        URI uri = server.getBaseUri().resolve("internal/runtime-broker/v1" + path);
        HttpRequest req = HttpRequest.newBuilder(uri)
                .header("Authorization", "Bearer " + BROKER_SECRET)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.toJSONString(body)))
                .build();
        return httpClient.send(req, HttpResponse.BodyHandlers.ofString());
    }

    private void startWorkerServer() throws IOException {
        workerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        workerServer.createContext("/", exchange -> {
            if (!("Bearer " + WORKER_TOKEN).equals(exchange.getRequestHeaders().getFirst("Authorization"))
                    || !"lease-1".equals(exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Id"))
                    || !"1".equals(exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Epoch"))) {
                replyJson(exchange, 401, Map.of("code", "unauthorized"));
                return;
            }
            String path = exchange.getRequestURI().getPath();
            String rawBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, Object> body = rawBody.isEmpty() ? Map.of() : JSON.parseObject(rawBody);

            if ("/internal/managed-runtime/v1/sessions".equals(path)) {
                replyJson(exchange, 200, Map.of(
                        "protocolVersion", 1,
                        "harnessSessionId", body.get("harnessSessionId"),
                        "runtimeSessionId", body.get("runtimeSessionId"),
                        "turnKind", body.get("turnKind")));
                return;
            }
            if ("/internal/managed-runtime/v3/publisher".equals(path)) {
                workerAttached.set(true);
                replyJson(exchange, 200, Map.of(
                        "protocolVersion", 3,
                        "toolResult", "managed-tool-result/1",
                        "sessionId", body.get("sessionId"),
                        "installed", true,
                        "observation", true,
                        "observedRuns", Map.of("call-1", workerAckedThrough.get())));
                return;
            }
            if (ManagedContextProtocol.PUBLISHER_DETACH_PATH.equals(path)) {
                workerAttached.set(false);
                replyJson(exchange, 200, Map.of(
                        "protocolVersion", 3,
                        "toolResult", "managed-tool-result/1",
                        "sessionId", body.get("sessionId"),
                        "detached", true));
                return;
            }
            if (ManagedContextProtocol.OBSERVATION_PULL_PATH.equals(path)) {
                long afterSeq = ((Number) body.get("afterSeq")).longValue();
                long ackThrough = body.get("ackThrough") instanceof Number n ? n.longValue() : 0L;
                if (ackThrough > 0) {
                    observedAckThroughs.add(ackThrough);
                    workerAckedThrough.updateAndGet(prev -> Math.max(prev, ackThrough));
                    workerOutbox.removeIf(item -> ((Number) item.get("deliverySeq")).longValue() <= ackThrough);
                }
                if (workerAttached.get()) {
                    replyJson(exchange, 200, Map.of(
                            "protocolVersion", 3,
                            "toolResult", "managed-tool-result/1",
                            "executionCallId", body.get("executionCallId"),
                            "status", "attached",
                            "ackedThrough", workerAckedThrough.get(),
                            "closed", false,
                            "entries", List.of()));
                    return;
                }
                List<Map<String, Object>> batch = workerOutbox.stream()
                        .filter(item -> ((Number) item.get("deliverySeq")).longValue() > afterSeq)
                        .toList();
                boolean hasTerminal = batch.stream().anyMatch(item -> "terminal".equals(item.get("kind")));
                replyJson(exchange, 200, Map.of(
                        "protocolVersion", 3,
                        "toolResult", "managed-tool-result/1",
                        "executionCallId", body.get("executionCallId"),
                        "status", "held",
                        "ackedThrough", workerAckedThrough.get(),
                        "closed", hasTerminal || workerOutbox.isEmpty(),
                        "entries", batch));
                return;
            }
            if ("/internal/managed-runtime/v1/sessions/control".equals(path)) {
                replyJson(exchange, 200, Map.of(
                        "protocolVersion", 1,
                        "result", Map.of(
                                "state", "exited",
                                "evidence", Map.of("exitCode", 0))));
                return;
            }
            replyJson(exchange, 404, Map.of("code", "not_found", "path", path));
        });
        workerServer.start();
    }

    private static void replyJson(HttpExchange exchange, int status, Map<String, Object> payload) throws IOException {
        byte[] bytes = JSON.toJSONString(payload).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private void seedBackgroundRun(String bindingId, long generation, String callId) {
        String digest = "sha256:" + "2".repeat(64);
        Map<String, Object> invRef = Map.of(
                "sessionId", runtimeSessionId,
                "promptId", "turn-1",
                "callId", callId,
                "argsDigest", digest,
                "runtimeProtocol", 3);
        ToolExecutionRecord inv = new ToolExecutionRecord(
                callId, "idem-" + callId, bindingId, generation, harnessSessionId, runtimeSessionId,
                "turn-1", callId, digest, invRef, ToolExecutionRecord.State.PREPARED, null, null,
                0L, false, null, null, 0L, 0L, null);
        ToolExecutionRecord admittedInv = bindingRepo.admitExecution(runtimeSessionRepo, executionRepo, inv);
        executionRepo.settlePrepared(
                admittedInv,
                Map.of("executionStatus", "success", "responseParts", List.of()),
                Instant.now());

        Map<String, Object> procRef = Map.of(
                "sessionId", runtimeSessionId,
                "promptId", "turn-1",
                "callId", callId + "-proc",
                "argsDigest", digest,
                "processOf", callId,
                "dispatchMode", "background_v3_process");
        ToolExecutionRecord proc = new ToolExecutionRecord(
                callId + ":process", "idem-" + callId + "-proc", bindingId, generation,
                harnessSessionId, runtimeSessionId, "turn-1", callId + "-proc", digest, procRef,
                ToolExecutionRecord.State.PREPARED, null, null,
                0L, false, null, null, 0L, 0L, null);
        bindingRepo.admitExecution(runtimeSessionRepo, executionRepo, proc);
    }

    private void acquireWriter() {
        writerGeneration = tx.execute(status -> sessionStore.acquireWriter(
                TENANT, harnessSessionId, WRITER_TOKEN,
                new AcquireWriterRequest(WORKSPACE, "writer", 60_000L))).writerGeneration();
    }

    private void sealWriter() {
        tx.execute(status -> sessionStore.sealWriter(
                TENANT, harnessSessionId, WRITER_TOKEN,
                new SealWriterRequest(WORKSPACE, "writer", writerGeneration,
                        new WakeStamp(1, false, System.currentTimeMillis() + 3_600_000L))));
    }

    private void commitGenesis() throws Exception {
        String records = "{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n";
        String digest = DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8));
        var node = MAPPER.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", "writer")
                .put("writerGeneration", writerGeneration)
                .put("expectedJournalRevision", 0)
                .put("expectedCommittedSequence", 0)
                .put("transactionId", "genesis")
                .put("operation", "session.create")
                .put("commandId", "genesis")
                .put("contentDigest", digest)
                .put("firstSequence", 0)
                .put("lastSequence", 0)
                .put("eventCount", 0)
                .put("activationEpoch", 0)
                .put("recordCount", 2)
                .put("recordDigest", digest)
                .put("recordBytesBase64", Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        var req = MAPPER.treeToValue(node, CommitTransactionRequest.class);
        tx.execute(status -> sessionStore.commit(TENANT, harnessSessionId, WRITER_TOKEN, req));
    }

    private static void waitUntil(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000L;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(25L);
        }
        assertThat(condition.getAsBoolean()).isTrue();
    }

    private static Map<String, Object> outputEntry(
            String callId, long seq, String segId, String pageId, String manId, String content) {
        byte[] segBytes = content.getBytes(StandardCharsets.UTF_8);
        byte[] pageBytes = ("{\"page\":\"" + pageId + "\"}").getBytes(StandardCharsets.UTF_8);
        byte[] manBytes = ("{\"manifest\":\"" + manId + "\",\"revision\":" + seq + "}")
                .getBytes(StandardCharsets.UTF_8);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("schemaVersion", 1);
        entry.put("kind", "output");
        entry.put("executionCallId", callId);
        entry.put("deliverySeq", seq);
        entry.put("manifestRef", ref(manId, "managed-tool-result-manifest", manBytes));
        entry.put("manifestRevision", seq);
        entry.put("resources", List.of(
                resource(segId, "managed-tool-result-segment", segBytes),
                resource(pageId, "managed-tool-result-page", pageBytes),
                resource(manId, "managed-tool-result-manifest", manBytes)));
        return entry;
    }

    private static Map<String, Object> terminalEntry(String callId, long seq, String manId) {
        byte[] manBytes = ("{\"manifest\":\"" + manId + "\",\"sealed\":true}").getBytes(StandardCharsets.UTF_8);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("schemaVersion", 1);
        entry.put("kind", "terminal");
        entry.put("executionCallId", callId);
        entry.put("deliverySeq", seq);
        entry.put("outcome", "exited");
        entry.put("executionStatus", "success");
        entry.put("stopRequested", false);
        entry.put("evidence", Map.of("exitCode", 0));
        entry.put("manifestRef", ref(manId, "managed-tool-result-manifest", manBytes));
        entry.put("envelope", Map.of("protocol", "managed-tool-result/1"));
        entry.put("resources", List.of(resource(manId, "managed-tool-result-manifest", manBytes)));
        return entry;
    }

    private static Map<String, Object> ref(String id, String kind, byte[] bytes) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("resourceId", id);
        map.put("kind", kind);
        map.put("schemaVersion", 1);
        map.put("byteLength", (long) bytes.length);
        map.put("digest", DigestUtils.sha256Hex(bytes));
        return map;
    }

    private static Map<String, Object> resource(String id, String kind, byte[] bytes) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ref", ref(id, kind, bytes));
        map.put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
        return map;
    }

    private static final class ForwardingV3Transport implements RuntimeTransport {
        private final HttpRuntimeTransport delegate;

        private ForwardingV3Transport(HttpRuntimeTransport delegate) {
            this.delegate = delegate;
        }

        @Override
        public CompletionStage<Void> acquire(
                RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            return delegate.release(lease, session);
        }

        @Override
        public CompletionStage<Map<String, Object>> installPublisher(
                RuntimeLease lease,
                RuntimeSession session,
                Map<String, Object> publisher,
                Long writerGeneration) {
            return delegate.installPublisherV3(lease, session, publisher, writerGeneration);
        }

        @Override
        public CompletionStage<Void> detachPublisher(
                RuntimeLease lease, RuntimeSession session, Long writerGeneration) {
            return delegate.detachPublisher(lease, session, writerGeneration);
        }

        @Override
        public CompletionStage<Map<String, Object>> pullObservations(
                RuntimeLease lease,
                String executionCallId,
                long afterSeq,
                long ackThrough,
                int waitMs,
                int maxEntries) {
            return delegate.pullObservations(
                    lease, executionCallId, afterSeq, ackThrough, waitMs, maxEntries);
        }

        @Override
        public CompletionStage<Object> control(
                RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(
                    Map.of("state", "exited", "evidence", Map.of("exitCode", 0)));
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
            return delegate.execute(lease, session, reference);
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
            return delegate.cancel(lease, session, reference);
        }
    }
}
