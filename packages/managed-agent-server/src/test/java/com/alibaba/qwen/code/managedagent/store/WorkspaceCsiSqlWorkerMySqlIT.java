package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiWorkerApiFixture;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.AbstractDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Types;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Real MySQL/native HTTP/file chain; placement and mount provenance are explicit fixtures. */
class WorkspaceCsiSqlWorkerMySqlIT {
    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    @TempDir
    Path directory;

    @Test
    void sqlGrantExecutesOriginalWorkerAndContinuesWithRetainedHistory() throws Exception {
        run(false, 0);
    }

    @Test
    void drainsOriginalWorkerAndReadsRetainedProgressAfterItStops() throws Exception {
        run(true, 0);
    }

    @Test
    void reclaimsOriginalWriterAtReadCommitted() throws Exception {
        run(false, Connection.TRANSACTION_READ_COMMITTED);
    }

    @Test
    void reclaimsOriginalWriterAtWarmedRepeatableRead() throws Exception {
        run(false, Connection.TRANSACTION_REPEATABLE_READ);
    }

    @Test
    void hostedProducerExecutesFilesAndCommitsFinalOutputBeforeConsumption() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, true);
        }
    }

    @Test
    void hostedProducerRecoversOriginalReceiptsWithoutRepeatingFileEffects() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, true, true);
        }
    }

    private void run(boolean retire, int isolation) throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            run(database.source(), directory, retire, isolation, false, false);
        }
    }

    static void acceptance(DataSource source, Path directory, boolean hostedProducer) throws Exception {
        acceptance(source, directory, hostedProducer, false);
    }

    static void acceptance(DataSource source, Path directory, boolean hostedProducer, boolean coldRecovery) throws Exception {
        run(source, directory, false, 0, hostedProducer, coldRecovery);
    }

    private static void run(DataSource source, Path directory, boolean retire, int isolation,
            boolean hostedProducer, boolean coldRecovery) throws Exception {
        boolean coldRun = isolation != 0;
        Path scenario = directory;
        String evidence = System.getProperty("csi.acceptance.evidence");
        if (coldRun && evidence != null) {
            Files.createDirectories(Path.of(evidence));
            scenario = Files.createTempDirectory(Path.of(evidence), "cold-" + isolation + "-");
        }
        Path root = Path.of("../..").toRealPath();
        assertThat(Files.isRegularFile(root.resolve("packages/cli/dist/src/serve/managed-csi-file-worker.js")))
                .as("Run npm run build before this explicitly invoked integration gate").isTrue();

        Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        if (coldRun) {
            transaction.setIsolationLevel(isolation);
        }
        var cold = new ColdContention(source, manager, isolation);
        var apiFixture = new WorkspaceCsiWorkerApiFixture();
        var registration = apiFixture.registration;
        var storage = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
        storage.register(registration);
        var request = WorkspaceCsiRuntimeConstructionFixture.create(source, registration);
        String sessionId = request.getIsolationKey();
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("owned", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source, bindings);
        var initial = bindings.findOrCreate(request);
        var journal = new ManagedSessionStore(jdbc);
        journal.setCsiBindings(bindings);
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("construction-fixture/1");
        var endpointReady = new CompletableFuture<URI>();
        var rpcCalls = new AtomicInteger();
        var renewals = new AtomicInteger();
        var actualClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
        var mappedClient = mock(HttpClient.class);
        when(mappedClient.followRedirects()).thenReturn(HttpClient.Redirect.NEVER);
        // Only the destination changes; production transport serializes and verifies every wire envelope.
        doAnswer(call -> {
            HttpRequest original = call.getArgument(0);
            assertThat(original.uri().getHost()).isEqualTo("10.4.0.8");
            assertThat(original.uri().getPort()).isEqualTo(43190);
            rpcCalls.incrementAndGet();
            URI target = endpointReady.get(45, TimeUnit.SECONDS);
            var mapped = HttpRequest.newBuilder(target.resolve(original.uri().getRawPath()))
                    .method(original.method(), original.bodyPublisher().orElseThrow());
            original.timeout().ifPresent(mapped::timeout);
            original.headers().map().forEach((key, values) -> values.forEach(value -> mapped.header(key, value)));
            return actualClient.sendAsync(mapped.build(), call.getArgument(1));
        }).when(mappedClient).sendAsync(any(HttpRequest.class), any());
        var access = new WorkspaceCsiRuntimeAccess(jdbc, manager, JSON, properties, registration,
                sessionId, request.requestKey(), bindings, sessions, new HttpRuntimeTransport(mappedClient));
        int brokerPort;
        try (var socket = new java.net.ServerSocket(0, 0, java.net.InetAddress.getLoopbackAddress())) {
            brokerPort = socket.getLocalPort();
        }
        var transport = new HttpRuntimeTransport(mappedClient);
        var provisioner = apiFixture.provisioner(storage, bindings, transport, "http://127.0.0.1:" + brokerPort);
        var application = new WorkspaceCsiApplicationStore(jdbc, manager, journal, bindings, sessions, transport);
        var warming = new AtomicReference<CompletableFuture<RuntimeBindingRecord>>();
        var retirement = new AtomicReference<WorkspaceCsiReservationStore.Retirement>();
        var nativeReads = new AtomicInteger();
        String operatorToken = UUID.randomUUID().toString();
        var lifetime = coldRun ? Duration.ofMinutes(5) : Duration.ofSeconds(30);
        try (provisioner; var service = new RuntimeBrokerService(access, provisioner, access, bindings, sessions, executions,
                "owned-broker", lifetime, lifetime);
                var broker = new RuntimeBrokerHttpServer(new InetSocketAddress("127.0.0.1", brokerPort), operatorToken,
                        service, false, (token, body) -> {
                            nativeReads.incrementAndGet();
                            return access.readNative(token, body);
                        })) {
            broker.registerCsiApplicationAuthority("tenant", sessionId, (token, body) -> application.workerAuthority("tenant", sessionId, token, body));
            broker.start();
            var adapter = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            var executor = Executors.newCachedThreadPool();
            adapter.setExecutor(executor);
            adapter.createContext("/", exchange -> {
                try {
                    String route = exchange.getRequestURI().getPath();
                    String raw = new String(exchange.getRequestBody().readNBytes(8 * 1024 * 1024 + 1),
                            StandardCharsets.UTF_8);
                    if (route.startsWith("/fixture:")) {
                        assertThat(exchange.getRequestHeaders().getFirst("Authorization"))
                                .isEqualTo("Bearer " + operatorToken);
                        Map<String, Object> body = JSON.readValue(raw, JSON.getTypeFactory()
                                .constructMapType(Map.class, String.class, Object.class));
                        Object response = switch (route) {
                            case "/fixture:setup" -> {
                                warming.set(service.warm(sessionId).toCompletableFuture());
                                var created = apiFixture.pod.get(30, TimeUnit.SECONDS);
                                var metadata = WorkspaceCsiRuntimeIdentity.map(created.get("metadata"));
                                var spec = WorkspaceCsiRuntimeIdentity.map(created.get("spec"));
                                var boot = apiFixture.boot.get(30, TimeUnit.SECONDS);
                                assertThat(boot.get("version")).isEqualTo(6);
                                yield Map.of("boot", boot, "pod", Map.of("uid", metadata.get("uid"),
                                        "namespace", metadata.get("namespace"), "nodeName", spec.get("nodeName")));
                            }
                            case "/fixture:worker" -> {
                                URI uri = URI.create((String) body.get("url"));
                                assertThat(uri.getHost()).isEqualTo("127.0.0.1");
                                assertThat(uri.getPort()).isPositive();
                                assertThat(endpointReady.complete(uri)).isTrue();
                                warming.get().get(60, TimeUnit.SECONDS);
                                var produced = bindings.findById(initial.getBindingId());
                                assertThat(produced.getResourceHandle().getVersion()).isEqualTo(4);
                                assertThat(WorkspaceCsiRuntimeIdentity.boot(produced).get("version")).isEqualTo(6);
                                yield Map.of("mapped", true);
                            }
                            case "/fixture:retire" -> {
                                var claimed = bindings.claimOperation(initial.getBindingId(), "owned-retire", Duration.ofMinutes(5));
                                var intent = storage.beginRetirement(registration, bindings, claimed, storage.inspect(registration), UUID.randomUUID().toString());
                                retirement.set(intent);
                                yield Map.of("retirementId", intent.operationId());
                            }
                            case "/fixture:retained" -> retained(source, sessionId, retirement.get().operationId(),
                                    (String) body.get("token"), (String) body.get("label"), apiFixture.calls, rpcCalls, nativeReads, renewals);
                            case "/fixture:retained-matrix" -> retainedMatrix(source, sessionId, retirement.get().operationId(), (String) body.get("token"),
                                    apiFixture.calls, rpcCalls, nativeReads, renewals);
                            case "/fixture:inspect" -> Map.of("executions", jdbc.queryForList(
                                    "SELECT execution_call_id, execution_state, result_json, native_authorization_json FROM ma_tool_execution"
                                            + " ORDER BY execution_call_id"),
                                    "activationRevision", jdbc.queryForObject(
                                            "SELECT first_activation_journal_revision FROM ma_runtime_binding", Long.class),
                                    "nativeReads", nativeReads.get());
                            case "/fixture:cold-observe" -> Map.of("image", tableImage(source),
                                    "now", jdbc.queryForObject("SELECT "
                                            + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW,
                                            Long.class),
                                    "counters", List.of(apiFixture.calls.get(), rpcCalls.get(), nativeReads.get(), renewals.get()));
                            case "/fixture:cold-result" -> Map.of("resultJson", jdbc.queryForObject(
                                    "SELECT result_json FROM ma_tool_execution WHERE execution_call_id=?",
                                    String.class, body.get("executionCallId")));
                            case "/fixture:cold-arm" -> cold.arm(((List<?>) body.get("writers")).stream()
                                    .map(String.class::cast).toList());
                            case "/fixture:cold-release" -> cold.release();
                            case "/fixture:leases" -> jdbc.queryForObject("SELECT writer_lease_until, activation_expires_at, "
                                    + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW
                                    + " FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'", (row, number) ->
                                            Map.of("writerLeaseUntil", row.getLong(1), "activationExpiresAt", row.getLong(2),
                                                    "databaseNow", row.getLong(3)));
                            case "/fixture:image" -> databaseImage(source, jdbc);
                            case "/fixture:publication" -> transaction.execute(status -> {
                                var writer = journal.lockPublicationWriter("tenant", "workspace", sessionId,
                                        (String) body.get("writerId"), ((Number) body.get("writerGeneration")).longValue(),
                                        (String) body.get("writerToken"));
                                return Map.of("generation", writer.activationEpoch());
                            });
                            case "/fixture:cold-refusals" -> {
                                var before = databaseImage(source, jdbc);
                                String execution = jdbc.queryForObject("SELECT execution_call_id FROM ma_tool_execution"
                                        + " ORDER BY execution_call_id LIMIT 1", String.class);
                                for (String mutation : List.of("execution_state = 'UNKNOWN', result_json = NULL, execution_status = NULL, settled_at = NULL",
                                        "cancel_requested = TRUE", "native_authorization_json = NULL",
                                        "execution_status = 'error', result_json = '{\"executionStatus\":\"error\",\"responseParts\":[],\"error\":{\"message\":\"changed\"}}'")) {
                                    transaction.executeWithoutResult(status -> {
                                        jdbc.update("UPDATE ma_tool_execution SET " + mutation + " WHERE execution_call_id = ?", execution);
                                        try {
                                            journal.acquireWriter("tenant", sessionId, (String) body.get("writerToken"),
                                                    new ManagedSessionStoreModels.AcquireWriterRequest("workspace",
                                                            UUID.randomUUID().toString(), 1_000L));
                                            throw new AssertionError("Incomplete original SQL evidence admitted a writer");
                                        } catch (RuntimeBrokerException refusal) {
                                            assertThat(refusal.getStatusCode()).isEqualTo(409);
                                        } finally {
                                            status.setRollbackOnly();
                                        }
                                    });
                                    assertThat(databaseImage(source, jdbc)).isEqualTo(before);
                                }
                                yield Map.of("refusals", 4);
                            }
                            default -> throw new IllegalArgumentException("Unknown owned fixture route");
                        };
                        respond(exchange, 200, response);
                        return;
                    }
                    String prefix = "/internal/managed-session-store/v1/sessions/" + sessionId;
                    assertThat(route).startsWith(prefix + "/");
                    String suffix = route.substring(prefix.length());
                    String token = exchange.getRequestHeaders().getFirst(ManagedSessionStoreModels.WRITER_TOKEN_HEADER);
                    var query = query(exchange);
                    if (suffix.equals("/writers:renew")) {
                        renewals.incrementAndGet();
                    }
                    Object response = suffix.startsWith("/csi-retirement")
                            ? suffix.equals("/csi-retirement")
                                ? application.status("tenant", sessionId, query.get("workspaceId"), query.get("retirementId"), token)
                                : application.command("tenant", sessionId, token, suffix.substring("/csi-retirement:".length()), raw.getBytes(StandardCharsets.UTF_8))
                            : suffix.startsWith("/resources/")
                            ? journal.readOwnerResource("tenant", query.get("workspaceId"), sessionId,
                                    suffix.substring("/resources/".length()), token)
                            : suffix.equals("/writers:acquire")
                            ? cold.acquire(journal, token, sessionId, read(raw, ManagedSessionStoreModels.AcquireWriterRequest.class))
                            : transaction.execute(status -> {
                                if (coldRun) {
                                    jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                                        assertThat(connection.getAutoCommit()).isFalse();
                                        assertThat(connection.getTransactionIsolation()).isEqualTo(isolation);
                                        return null;
                                    });
                                }
                                return switch (suffix) {
                                    case "/tool-results:publish" -> journal.publishToolResult("tenant", sessionId, token,
                                            read(raw, ManagedSessionStoreModels.PublishToolResultRequest.class));
                                    case "/writers:renew" -> journal.renewWriter("tenant", sessionId, token,
                                            read(raw, ManagedSessionStoreModels.RenewWriterRequest.class));
                                    case "/writers:seal" -> journal.sealWriter("tenant", sessionId, token,
                                            read(raw, ManagedSessionStoreModels.SealWriterRequest.class));
                                    case "/transactions:commit", "/transactions:commit-v2" -> journal.commit("tenant", sessionId,
                                            token, read(raw, ManagedSessionStoreModels.CommitTransactionRequest.class));
                                    case "/restore" -> journal.restore("tenant", query.get("workspaceId"), sessionId, token);
                                    case "/transactions" -> journal.transactions("tenant", query.get("workspaceId"), sessionId,
                                            token, Long.parseLong(query.get("afterRevision")), Integer.parseInt(query.get("limit")));
                                    default -> throw new IllegalArgumentException("Unknown owned Session store route");
                                };
                            });
                    if (response instanceof ManagedSessionStoreModels.StoredResource resource) {
                        exchange.getResponseHeaders().set("Cache-Control", "no-store");
                        exchange.getResponseHeaders().set("X-Qwen-Resource-Kind", resource.kind());
                        exchange.getResponseHeaders().set("X-Qwen-Resource-Schema-Version", Integer.toString(resource.schemaVersion()));
                        exchange.getResponseHeaders().set("X-Qwen-Resource-Digest", resource.digest());
                        exchange.getResponseHeaders().set("Content-Type", "application/octet-stream");
                        exchange.sendResponseHeaders(200, resource.bytes().length);
                        exchange.getResponseBody().write(resource.bytes());
                    } else {
                        respond(exchange, 200, response);
                    }
                } catch (RuntimeBrokerException refusal) {
                    try {
                        respond(exchange, refusal.getStatusCode(), Map.of("error", Map.of("code", refusal.getCode(),
                                "message", refusal.getMessage())));
                    } catch (java.io.IOException ignored) {
                        exchange.close();
                    }
                } catch (ApiException refusal) {
                    try {
                        respond(exchange, refusal.getStatus().value(), Map.of("error", Map.of("code", refusal.getCode(),
                                "message", refusal.getMessage())));
                    } catch (java.io.IOException ignored) {
                        exchange.close();
                    }
                } catch (Exception | AssertionError failure) {
                    failure.printStackTrace();
                    try {
                        respond(exchange, 500, Map.of("error", Map.of("code", "owned_adapter_failure",
                                "message", failure.toString())));
                    } catch (java.io.IOException ignored) {
                        exchange.close();
                    }
                } finally {
                    exchange.close();
                }
            });
            adapter.start();
            Process child = null;
            try {
                Path input = scenario.resolve("input.json");
                String foreignOwner = UUID.randomUUID().toString();
                JSON.writeValue(input.toFile(), Map.ofEntries(
                        Map.entry("adapter", "http://127.0.0.1:" + adapter.getAddress().getPort()),
                        Map.entry("broker", broker.getBaseUri().toString()),
                        Map.entry("operatorToken", operatorToken),
                        Map.entry("foreignOwnerSessionId", foreignOwner),
                        Map.entry("foreignOwnerOperationId", UUID.nameUUIDFromBytes(foreignOwner.getBytes(StandardCharsets.UTF_8)).toString()),
                        Map.entry("retirement", retire),
                        Map.entry("cold", isolation),
                        Map.entry("hostedProducer", hostedProducer),
                        Map.entry("coldRecovery", coldRecovery),
                        Map.entry("runtime", Map.of("bindingId", initial.getBindingId(), "generation", Long.toString(initial.getGeneration()))),
                        Map.entry("sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", sessionId))));
                Path producer = scenario.resolve("producer.mjs");
                try (var script = WorkspaceCsiSqlWorkerMySqlIT.class.getResourceAsStream("/csi-sql-worker-acceptance.mjs");
                        var declarations = WorkspaceCsiSqlWorkerMySqlIT.class.getResourceAsStream("/csi-native-file-declarations.json")) {
                    assertThat(script).isNotNull();
                    assertThat(declarations).isNotNull();
                    Files.copy(script, producer);
                    Files.copy(declarations, scenario.resolve("declarations.json"));
                    if (hostedProducer) {
                        try (var hostedScript = WorkspaceCsiSqlWorkerMySqlIT.class.getResourceAsStream("/csi-hosted-file-turns.mjs")) {
                            assertThat(hostedScript).isNotNull();
                            Files.copy(hostedScript, scenario.resolve("csi-hosted-file-turns.mjs"));
                        }
                    }
                }
                child = new ProcessBuilder("node", producer.toString(), input.toString(), scenario.toString())
                        .directory(root.toFile()).redirectErrorStream(true).redirectOutput(scenario.resolve("node.log").toFile()).start();
                assertThat(child.waitFor(180, TimeUnit.SECONDS)).as("Owned Node chain timed out").isTrue();
                assertThat(child.exitValue()).as(Files.readString(scenario.resolve("node.log"))).isZero();
                var result = JSON.readTree(scenario.resolve("result.json").toFile());
                if (coldRun) {
                    assertThat(result.path("writerGeneration").asLong()).isEqualTo(2);
                    assertThat(result.path("activationEpoch").asLong()).isEqualTo(2);
                    assertThat(result.path("isolation").asInt()).isEqualTo(isolation);
                    assertThat(result.path("workerClosed").asBoolean()).isTrue();
                    assertThat(result.path("completedTurns").asInt()).isZero();
                    assertThat(jdbc.queryForObject("SELECT writer_generation FROM ma_session_head", Long.class)).isEqualTo(2);
                    assertThat(jdbc.queryForObject("SELECT activation_epoch FROM ma_session_head", Long.class)).isEqualTo(2);
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE execution_state='SETTLED'", Integer.class))
                            .isEqualTo(2);
                    assertThat(cold.warmed).hasSize(2);
                    return;
                }
                assertThat(result.path("completedTurns").asInt()).isEqualTo(2);
                assertThat(result.path("nativeSqlGrant").asBoolean()).isTrue();
                assertThat(result.path("workerClosed").asBoolean()).isTrue();
                assertThat(result.path("finalBytes").asText()).isEqualTo("gamma\n");
                if (hostedProducer) {
                    assertThat(result.path("refusalChecks").asInt()).isPositive();
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx"
                            + " WHERE operation = 'hostedModelAttempt' AND event_count = 2", Integer.class)).isEqualTo(2);
                    var outputRevisions = jdbc.queryForList("SELECT journal_revision FROM ma_session_journal_tx"
                            + " WHERE operation = 'hostedModelAttempt' AND event_count = 2 ORDER BY journal_revision", Long.class);
                    var consumptionRevisions = jdbc.query("SELECT command_id, journal_revision FROM ma_session_journal_tx"
                            + " WHERE operation = 'commitCheckpoint' ORDER BY journal_revision", (row, number) ->
                                    Map.entry(new String(row.getBytes("command_id"), StandardCharsets.UTF_8), row.getLong("journal_revision")))
                            .stream().filter(entry -> entry.getKey().startsWith("harness:results_consumed:"))
                            .map(Map.Entry::getValue).toList();
                    assertThat(consumptionRevisions).hasSize(2);
                    for (int index = 0; index < 2; index++) {
                        assertThat(outputRevisions.get(index)).isLessThan(consumptionRevisions.get(index));
                    }
                    assertThat(consumptionRevisions.get(0)).isLessThan(outputRevisions.get(1));
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx"
                            + " WHERE operation = 'commitFileHistory'", Integer.class)).isEqualTo(7);
                }
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE native_authorization_json IS NOT NULL"
                        + " AND execution_state = 'SETTLED'", Integer.class)).isEqualTo(4);
                assertThat(jdbc.queryForObject("SELECT writer_generation FROM ma_session_head", Long.class))
                        .isEqualTo(coldRecovery ? 3 : 1);
                if (coldRecovery) {
                    assertThat(result.path("coldRecovery").asBoolean()).isTrue();
                    assertThat(result.path("coldRefusalChecks").asInt()).isEqualTo(9);
                    assertThat(jdbc.queryForObject("SELECT activation_epoch FROM ma_session_head", Long.class)).isEqualTo(2);
                }
                assertThat(jdbc.queryForObject("SELECT first_activation_journal_revision FROM ma_runtime_binding", Long.class)).isEqualTo(2);
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE operation = 'CSI_RESOURCE_READ'"
                        + " AND state = 'RETURNED'", Integer.class)).isPositive();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE operation = 'CSI_RESOURCE_READ'"
                        + " AND state = 'OPEN'", Integer.class)).isZero();
                assertThat(nativeReads.get()).isGreaterThanOrEqualTo(7);
                String schema;
                try (var connection = source.getConnection()) {
                    schema = connection.getSchema();
                    if (schema == null) {
                        schema = connection.getCatalog();
                    }
                }
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?"
                        + " AND table_type = 'BASE TABLE'", Integer.class, schema)).isEqualTo(35);
                assertThat(apiFixture.creates.get()).isEqualTo(2);
                if (retire) {
                    assertThat(result.path("retainedBeforeClose").path("outcome").asText()).isEqualTo("UNPLANNED");
                    assertThat(result.path("retainedAfterClose").path("outcome").asText()).isEqualTo("UNPLANNED");
                    assertThat(result.path("retirement").path("stage").asText()).isEqualTo("DRAINED");
                    assertThat(result.path("retirement").path("progressVersion").asInt()).isEqualTo(4);
                    assertThat(result.path("retainedMatrix").size()).isEqualTo(12);
                    var original = bindings.findById(initial.getBindingId());
                    assertThat(original.getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
                    assertThat(original.isDrainRequested()).isTrue();
                    assertThat(jdbc.queryForObject("SELECT session_state FROM ma_runtime_session", String.class)).isEqualTo("RELEASED");
                    assertThat(jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class)).isEqualTo(original.getBindingId());
                    assertThat(jdbc.queryForObject("SELECT csi_phase FROM ma_storage_owner", String.class)).isEqualTo("DRAINING");
                    assertThat(jdbc.queryForObject("SELECT binding_id FROM ma_storage_owner", String.class)).isEqualTo(original.getBindingId());
                }
                if (evidence != null) {
                    Path output = Path.of(evidence);
                    if (hostedProducer) {
                        output = output.resolve("hosted").resolve(schema);
                    }
                    Files.createDirectories(output);
                    Files.copy(scenario.resolve("result.json"), output.resolve(retire ? "retirement-result.json" : "result.json"));
                }
            } finally {
                cold.stop();
                boolean childExited = true;
                if (child != null && child.isAlive()) {
                    child.destroyForcibly();
                    childExited = child.waitFor(10, TimeUnit.SECONDS);
                }
                adapter.stop(0);
                executor.shutdownNow();
                boolean executorTerminated = executor.awaitTermination(10, TimeUnit.SECONDS);
                actualClient.shutdownNow();
                boolean clientTerminated = actualClient.awaitTermination(Duration.ofSeconds(10));
                assertThat(childExited).as("node child did not exit after destroyForcibly").isTrue();
                assertThat(executorTerminated).as("adapter executor did not terminate").isTrue();
                assertThat(clientTerminated).as("http client did not terminate").isTrue();
            }
        }
    }

    private static Map<String, List<String>> databaseImage(DataSource source, ManagedSchemaJdbcTemplate jdbc)
            throws Exception {
        String schema;
        try (var connection = source.getConnection()) {
            schema = connection.getSchema();
            if (schema == null) {
                schema = connection.getCatalog();
            }
        }
        var image = new java.util.TreeMap<String, List<String>>();
        for (String table : jdbc.queryForList("SELECT table_name FROM information_schema.tables"
                + " WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", String.class, schema)) {
            assertThat(table).matches("[a-z_]+");
            var rows = new java.util.ArrayList<String>();
            for (var row : jdbc.queryForList("SELECT * FROM " + table)) {
                rows.add(JSON.writeValueAsString(row));
            }
            rows.sort(String::compareTo);
            image.put(table, rows);
        }
        return image;
    }

    private static <T> T read(String body, Class<T> type) {
        try {
            return JSON.readValue(body, type);
        } catch (java.io.IOException invalid) {
            throw new IllegalArgumentException("Invalid owned adapter request", invalid);
        }
    }

    private static Map<String, String> query(HttpExchange exchange) {
        var result = new LinkedHashMap<String, String>();
        String raw = exchange.getRequestURI().getRawQuery();
        if (raw != null) {
            for (String pair : raw.split("&")) {
                String[] parts = pair.split("=", 2);
                result.put(URLDecoder.decode(parts[0], StandardCharsets.UTF_8),
                        URLDecoder.decode(parts[1], StandardCharsets.UTF_8));
            }
        }
        return result;
    }

    private static void respond(HttpExchange exchange, int status, Object body) throws java.io.IOException {
        byte[] bytes = JSON.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    private static final class ColdContention {
        private final DataSource source;
        private final DataSourceTransactionManager manager;
        private final int isolation;
        private final Set<String> entered = ConcurrentHashMap.newKeySet();
        private final Map<String, Map<String, Object>> warmed = new ConcurrentHashMap<>();
        private final CountDownLatch snapshots = new CountDownLatch(2);
        private final CountDownLatch start = new CountDownLatch(1);
        private volatile List<String> writers = List.of();
        private Connection holder;
        private long holderId;

        private ColdContention(DataSource source, DataSourceTransactionManager manager, int isolation) {
            this.source = source;
            this.manager = manager;
            this.isolation = isolation;
        }

        private Map<String, Object> arm(List<String> contenders) throws Exception {
            assertThat(isolation).isIn(Connection.TRANSACTION_READ_COMMITTED, Connection.TRANSACTION_REPEATABLE_READ);
            assertThat(contenders).hasSize(2).doesNotHaveDuplicates();
            assertThat(writers).isEmpty();
            writers = List.copyOf(contenders);
            holder = source.getConnection();
            holder.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(holder, "tenant", 5);
            try (var statement = holder.prepareStatement("SELECT CONNECTION_ID()"); var row = statement.executeQuery()) {
                assertThat(row.next()).isTrue();
                holderId = row.getLong(1);
            }
            return Map.of("holderId", holderId);
        }

        private ManagedSessionStoreModels.WriterGrant acquire(ManagedSessionStore journal, String token,
                String session, ManagedSessionStoreModels.AcquireWriterRequest request) {
            var transaction = new TransactionTemplate(manager);
            transaction.setTimeout(10);
            boolean contender = writers.contains(request.writerId()) && entered.add(request.writerId());
            if (isolation != 0) {
                transaction.setIsolationLevel(isolation);
            }
            return transaction.execute(status -> {
                if (contender) {
                    new ManagedSchemaJdbcTemplate(source).execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                        assertThat(connection.getAutoCommit()).isFalse();
                        assertThat(connection.getTransactionIsolation()).isEqualTo(isolation);
                        try (var statement = connection.prepareStatement("SELECT CONNECTION_ID(), writer_id, writer_generation,"
                                + " journal_revision, committed_sequence, last_commit_digest, activation_epoch FROM ma_session_head");
                                var row = statement.executeQuery()) {
                            assertThat(row.next()).isTrue();
                            warmed.put(request.writerId(), Map.of("connectionId", row.getLong(1),
                                    "isolation", connection.getTransactionIsolation(), "autoCommit", connection.getAutoCommit(),
                                    "writerId", row.getString(2), "writerGeneration", row.getLong(3),
                                    "journalRevision", row.getLong(4), "committedSequence", row.getLong(5),
                                    "lastCommitDigest", row.getString(6), "activationEpoch", row.getLong(7)));
                            assertThat(row.next()).isFalse();
                        }
                        snapshots.countDown();
                        await(start);
                        return null;
                    });
                }
                return journal.acquireWriter("tenant", session, token, request);
            });
        }

        private Map<String, Object> release() throws Exception {
            try {
                await(snapshots);
                start.countDown();
                var jdbc = new ManagedSchemaJdbcTemplate(source);
                List<Map<String, Object>> waits = List.of();
                long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
                var connections = warmed.values().stream().map(row -> ((Number) row.get("connectionId")).longValue()).toList();
                while (System.nanoTime() < until) {
                    waits = jdbc.queryForList("SELECT DISTINCT requester.PROCESSLIST_ID AS requester, blocker.PROCESSLIST_ID AS blocker,"
                            + " locks.OBJECT_NAME AS table_name, requester.PROCESSLIST_INFO AS sql_text"
                            + " FROM performance_schema.data_lock_waits waits"
                            + " JOIN performance_schema.data_locks locks ON locks.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID"
                            + " JOIN performance_schema.threads requester ON requester.THREAD_ID=waits.REQUESTING_THREAD_ID"
                            + " JOIN performance_schema.threads blocker ON blocker.THREAD_ID=waits.BLOCKING_THREAD_ID"
                            + " WHERE locks.OBJECT_SCHEMA=DATABASE()");
                    var direct = waits.stream().filter(row -> ((Number) row.get("blocker")).longValue() == holderId)
                            .map(row -> ((Number) row.get("requester")).longValue()).toList();
                    if (direct.containsAll(connections)) {
                        break;
                    }
                    Thread.sleep(10);
                }
                assertThat(connections).hasSize(2).doesNotHaveDuplicates().doesNotContain(holderId);
                assertThat(waits).hasSizeBetween(2, 3);
                var direct = waits.stream().filter(row -> ((Number) row.get("blocker")).longValue() == holderId)
                        .map(row -> ((Number) row.get("requester")).longValue()).toList();
                assertThat(direct).containsExactlyInAnyOrderElementsOf(connections);
                for (var row : waits) {
                    assertThat(row.get("table_name")).isEqualTo("ma_tenant_guard");
                    long blocker = ((Number) row.get("blocker")).longValue();
                    assertThat(blocker == holderId || connections.contains(blocker)).isTrue();
                    assertThat(connections).contains(((Number) row.get("requester")).longValue());
                    assertThat(((Number) row.get("requester")).longValue()).isNotEqualTo(blocker);
                    assertThat((String) row.get("sql_text")).contains("INSERT INTO ma_tenant_guard");
                }
                return Map.of("warmed", warmed, "waits", waits, "holderId", holderId);
            } finally {
                stop();
            }
        }

        private static void await(CountDownLatch latch) {
            try {
                assertThat(latch.await(8, TimeUnit.SECONDS)).as("Owned contention barrier timed out").isTrue();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Owned contention barrier interrupted", interrupted);
            }
        }

        private synchronized void stop() throws Exception {
            start.countDown();
            if (holder != null) {
                try {
                    holder.rollback();
                } finally {
                    holder.close();
                    holder = null;
                }
            }
        }
    }

    private static Map<String, Object> retained(DataSource source, String session, String retirement,
            String token, String label, AtomicInteger... counters) throws Exception {
        return retainedRead(source, new WorkspaceCsiPhysicalStore.Original("tenant", session, "workspace", retirement),
                token, label, true, counters);
    }

    private static Map<String, Object> retainedRead(DataSource source, WorkspaceCsiPhysicalStore.Original original,
            String token, String label, boolean accepted, AtomicInteger... counters) throws Exception {
        String before = fingerprint(source);
        int[] opens = {0}, closes = {0}, selects = {0};
        int[] beforeCounts = Arrays.stream(counters).mapToInt(AtomicInteger::get).toArray();
        var observed = new AbstractDataSource() {
            @Override
            public Connection getConnection() throws java.sql.SQLException {
                opens[0]++;
                var connection = source.getConnection();
                return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
                        (proxy, method, arguments) -> {
                            if (method.getName().equals("prepareStatement")) {
                                String sql = (String) arguments[0];
                                assertThat(sql).startsWith("SELECT ").doesNotContain("FOR UPDATE", "LOCK IN SHARE MODE");
                                assertThat(connection.isReadOnly()).isTrue();
                                assertThat(connection.getAutoCommit()).isFalse();
                                assertThat(connection.getTransactionIsolation()).isEqualTo(Connection.TRANSACTION_REPEATABLE_READ);
                                selects[0]++;
                            }
                            assertThat(method.getName()).isNotIn("createStatement", "prepareCall");
                            if (method.getName().equals("close")) {
                                closes[0]++;
                            }
                            try {
                                return method.invoke(connection, arguments);
                            } catch (InvocationTargetException failure) {
                                throw failure.getCause();
                            }
                        });
            }

            @Override
            public Connection getConnection(String username, String password) throws java.sql.SQLException {
                return getConnection();
            }
        };
        var jdbc = new ManagedSchemaJdbcTemplate(observed);
        var reader = new WorkspaceCsiApplicationHistory(jdbc, new DataSourceTransactionManager(observed),
                new JdbcRuntimeBindingRepository(observed, new AesGcmSecretProtector("owned", new byte[32])),
                new ManagedSessionStore(jdbc), JSON);
        String outcome;
        try {
            var status = reader.readRetainedProgress(original, token);
            assertThat(accepted).as(label).isTrue();
            assertThat(status.stage()).isEqualTo("UNPLANNED");
            assertThat(status.version()).isZero();
            assertThat(status.deletionAttempts()).isZero();
            assertThat(status.planSha256()).isNull();
            outcome = status.stage();
        } catch (ApiException | IllegalArgumentException refused) {
            if (accepted) {
                throw refused;
            }
            if (label.equals("wrong-credential")) {
                assertThat(refused).isInstanceOf(ApiException.class);
                assertThat(((ApiException) refused).getStatus().value()).isEqualTo(409);
                assertThat(((ApiException) refused).getCode()).isEqualTo("csi_resource_read_conflict");
            }
            outcome = refused.getClass().getSimpleName();
        }
        assertThat(fingerprint(source)).as(label).isEqualTo(before);
        assertThat(opens[0]).isEqualTo(1);
        assertThat(closes[0]).isEqualTo(1);
        assertThat(selects[0]).isPositive();
        assertThat(Arrays.stream(counters).mapToInt(AtomicInteger::get).toArray()).containsExactly(beforeCounts);
        return Map.of("label", label, "outcome", outcome, "accepted", accepted, "selects", selects[0]);
    }

    private interface SqlControl {
        void run() throws Exception;
    }

    private static Map<String, Object> controlled(DataSource source, WorkspaceCsiPhysicalStore.Original original,
            String token, String label, SqlControl mutate, SqlControl restore, AtomicInteger... counters) throws Exception {
        String baseline = fingerprint(source);
        try {
            mutate.run();
            assertThat(fingerprint(source)).as(label).isNotEqualTo(baseline);
            return retainedRead(source, original, token, label, false, counters);
        } finally {
            restore.run();
            assertThat(fingerprint(source)).as("Restore " + label).isEqualTo(baseline);
        }
    }

    private static List<Map<String, Object>> retainedMatrix(DataSource source, String session, String retirement,
            String token, AtomicInteger... counters) throws Exception {
        var original = new WorkspaceCsiPhysicalStore.Original("tenant", session, "workspace", retirement);
        var results = new ArrayList<Map<String, Object>>();
        results.add(retainedRead(source, original, Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]),
                "wrong-credential", false, counters));
        results.add(retainedRead(source, new WorkspaceCsiPhysicalStore.Original("foreign", session, "workspace", retirement),
                token, "wrong-tenant", false, counters));
        results.add(retainedRead(source, new WorkspaceCsiPhysicalStore.Original("tenant", session, "foreign-workspace", retirement),
                token, "wrong-workspace", false, counters));
        results.add(retainedRead(source, new WorkspaceCsiPhysicalStore.Original("tenant", UUID.randomUUID().toString(), "workspace", retirement),
                token, "wrong-session", false, counters));
        results.add(retainedRead(source, new WorkspaceCsiPhysicalStore.Original("tenant", session, "workspace", UUID.randomUUID().toString()),
                token, "wrong-retirement", false, counters));
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        for (String name : List.of("frozen_request", "cut", "finalize_receipt")) {
            var row = jdbc.queryForMap("SELECT " + name + "_bytes," + name + "_sha256 FROM ma_operation"
                    + " WHERE operation_kind='CSI_RETIREMENT' AND operation_id=?", retirement);
            byte[] saved = (byte[]) row.get(name + "_bytes");
            String digest = (String) row.get(name + "_sha256");
            var json = (ObjectNode) JSON.readTree(saved);
            json.put("format", "deliberate-negative-control/1");
            byte[] changed = JSON.writeValueAsBytes(json);
            String update = "UPDATE ma_operation SET " + name + "_bytes=?," + name + "_sha256=?"
                    + " WHERE operation_kind='CSI_RETIREMENT' AND operation_id=?";
            results.add(controlled(source, original, token, "altered-" + name + "-rehashed",
                    () -> assertThat(jdbc.update(update, changed, DigestUtils.sha256Hex(changed), retirement)).isEqualTo(1),
                    () -> assertThat(jdbc.update(update, saved, digest, retirement)).isEqualTo(1), counters));
        }
        var savedJournal = jdbc.queryForMap("SELECT * FROM ma_session_journal_tx"
                + " WHERE tenant_id='tenant' AND session_id=? AND journal_revision=1", session);
        byte[] savedBytes = (byte[]) savedJournal.get("record_bytes");
        byte[] changed = savedBytes.clone();
        changed[0] ^= 1;
        String updateJournal = "UPDATE ma_session_journal_tx SET record_bytes=?,record_digest=?"
                + " WHERE tenant_id='tenant' AND session_id=? AND journal_revision=1";
        results.add(controlled(source, original, token, "altered-native-journal-rehashed",
                () -> assertThat(jdbc.update(updateJournal, changed, DigestUtils.sha256Hex(changed), session)).isEqualTo(1),
                () -> assertThat(jdbc.update(updateJournal, savedBytes, savedJournal.get("record_digest"), session)).isEqualTo(1), counters));
        results.add(controlled(source, original, token, "missing-native-journal-member",
                () -> assertThat(jdbc.update("DELETE FROM ma_session_journal_tx"
                        + " WHERE tenant_id='tenant' AND session_id=? AND journal_revision=1", session)).isEqualTo(1),
                () -> assertThat(jdbc.update("INSERT INTO ma_session_journal_tx (" + String.join(",", savedJournal.keySet())
                        + ") VALUES (" + String.join(",", Collections.nCopies(savedJournal.size(), "?")) + ")",
                        savedJournal.values().toArray())).isEqualTo(1), counters));
        String scope = ManagedSessionStore.sessionScopeKey("foreign", "foreign-session");
        String resource = ManagedSessionStore.resourceKey(scope, "foreign-unknown");
        byte[] foreign = "{}".getBytes(StandardCharsets.UTF_8);
        results.add(controlled(source, original, token, "unsupported-foreign-carrier",
                () -> assertThat(jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,session_id,"
                        + "resource_id,kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,publish_command_id,state,gmt_create)"
                        + " VALUES (?,?,'foreign','foreign-workspace','foreign-session','foreign-unknown','unknown-format',1,?,?,'MYSQL_INLINE',?,"
                        + "'owned-negative','REFERENCED'," + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW + ")",
                        resource, scope, foreign.length, DigestUtils.sha256Hex(foreign), foreign)).isEqualTo(1),
                () -> assertThat(jdbc.update("DELETE FROM ma_resource WHERE resource_key=?", resource)).isEqualTo(1), counters));
        results.add(retainedRead(source, original, token, "restored-after-all-controls", true, counters));
        return results;
    }

    private static String fingerprint(DataSource source) throws Exception {
        return DigestUtils.sha256Hex(JSON.writeValueAsBytes(tableImage(source)));
    }

    private static Map<String, List<String>> tableImage(DataSource source) throws Exception {
        var image = new TreeMap<String, List<String>>();
        try (var connection = source.getConnection()) {
            connection.setReadOnly(true);
            connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            connection.setAutoCommit(false);
            var tables = new ArrayList<String>();
            try (var statement = connection.prepareStatement("SELECT table_name FROM information_schema.tables"
                    + " WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name");
                    var rows = statement.executeQuery()) {
                while (rows.next()) {
                    tables.add(rows.getString(1));
                }
            }
            for (String table : tables) {
                assertThat(table).matches("[a-z_]+");
                var rows = new ArrayList<String>();
                try (var statement = connection.prepareStatement("SELECT * FROM `" + table + "`");
                        var result = statement.executeQuery()) {
                    var metadata = result.getMetaData();
                    while (result.next()) {
                        var cells = new ArrayList<Object>();
                        for (int column = 1; column <= metadata.getColumnCount(); column++) {
                            int type = metadata.getColumnType(column);
                            boolean binary = type == Types.BLOB || type == Types.BINARY || type == Types.VARBINARY || type == Types.LONGVARBINARY;
                            String value = result.getObject(column) == null ? null : binary
                                    ? Base64.getEncoder().encodeToString(result.getBytes(column)) : result.getString(column);
                            cells.add(Arrays.asList(metadata.getColumnName(column), type, value));
                        }
                        rows.add(JSON.writeValueAsString(cells));
                    }
                }
                Collections.sort(rows);
                image.put(table, rows);
            }
            connection.rollback();
        }
        return image;
    }
}
