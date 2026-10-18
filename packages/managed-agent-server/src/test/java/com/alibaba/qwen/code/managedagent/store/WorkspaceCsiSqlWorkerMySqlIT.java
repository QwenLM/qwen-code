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
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
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
        run(false);
    }

    @Test
    void drainsOriginalWorkerAndReadsRetainedProgressAfterItStops() throws Exception {
        run(true);
    }

    private void run(boolean retire) throws Exception {
        Path root = Path.of("../..").toRealPath();
        assertThat(Files.isRegularFile(root.resolve("packages/cli/dist/src/serve/managed-csi-file-worker.js")))
                .as("Run npm run build before this explicitly invoked integration gate").isTrue();
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            var manager = new DataSourceTransactionManager(source);
            var transaction = new TransactionTemplate(manager);
            transaction.setTimeout(10);
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
            try (provisioner; var service = new RuntimeBrokerService(access, provisioner, access, bindings, sessions, executions,
                    "owned-broker", Duration.ofSeconds(30), Duration.ofSeconds(30));
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
                                        "SELECT execution_state, native_authorization_json FROM ma_tool_execution"
                                                + " ORDER BY execution_call_id"),
                                        "activationRevision", jdbc.queryForObject(
                                                "SELECT first_activation_journal_revision FROM ma_runtime_binding", Long.class),
                                        "nativeReads", nativeReads.get());
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
                                : transaction.execute(status -> switch (suffix) {
                                    case "/writers:acquire" -> journal.acquireWriter("tenant", sessionId, token,
                                            read(raw, ManagedSessionStoreModels.AcquireWriterRequest.class));
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
                        respond(exchange, refusal.getStatusCode(), Map.of("error", Map.of("code", refusal.getCode(),
                                "message", refusal.getMessage())));
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
                    Path input = directory.resolve("input.json");
                    String foreignOwner = UUID.randomUUID().toString();
                    JSON.writeValue(input.toFile(), Map.of("adapter", "http://127.0.0.1:" + adapter.getAddress().getPort(),
                            "broker", broker.getBaseUri().toString(), "operatorToken", operatorToken,
                            "foreignOwnerSessionId", foreignOwner,
                            "foreignOwnerOperationId", UUID.nameUUIDFromBytes(foreignOwner.getBytes(StandardCharsets.UTF_8)).toString(),
                            "retirement", retire,
                            "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", sessionId)));
                    Path producer = directory.resolve("producer.mjs");
                    try (var script = getClass().getResourceAsStream("/csi-sql-worker-acceptance.mjs");
                            var declarations = getClass().getResourceAsStream("/csi-native-file-declarations.json")) {
                        assertThat(script).isNotNull();
                        assertThat(declarations).isNotNull();
                        Files.copy(script, producer);
                        Files.copy(declarations, directory.resolve("declarations.json"));
                    }
                    child = new ProcessBuilder("node", producer.toString(), input.toString(), directory.toString())
                            .directory(root.toFile()).redirectErrorStream(true).redirectOutput(directory.resolve("node.log").toFile()).start();
                    assertThat(child.waitFor(180, TimeUnit.SECONDS)).as("Owned Node chain timed out").isTrue();
                    assertThat(child.exitValue()).as(Files.readString(directory.resolve("node.log"))).isZero();
                    var result = JSON.readTree(directory.resolve("result.json").toFile());
                    assertThat(result.path("completedTurns").asInt()).isEqualTo(2);
                    assertThat(result.path("nativeSqlGrant").asBoolean()).isTrue();
                    assertThat(result.path("workerClosed").asBoolean()).isTrue();
                    assertThat(result.path("finalBytes").asText()).isEqualTo("gamma\n");
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE native_authorization_json IS NOT NULL"
                            + " AND execution_state = 'SETTLED'", Integer.class)).isEqualTo(4);
                    assertThat(jdbc.queryForObject("SELECT writer_generation FROM ma_session_head", Long.class)).isEqualTo(1);
                    assertThat(jdbc.queryForObject("SELECT first_activation_journal_revision FROM ma_runtime_binding", Long.class)).isEqualTo(2);
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE operation = 'CSI_RESOURCE_READ'"
                            + " AND state = 'RETURNED'", Integer.class)).isPositive();
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE operation = 'CSI_RESOURCE_READ'"
                            + " AND state = 'OPEN'", Integer.class)).isZero();
                    assertThat(nativeReads.get()).isGreaterThanOrEqualTo(7);
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()"
                            + " AND table_type = 'BASE TABLE'", Integer.class)).isEqualTo(35);
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
                    String evidence = System.getProperty("csi.acceptance.evidence");
                    if (evidence != null) {
                        Path output = Path.of(evidence);
                        Files.createDirectories(output);
                        Files.copy(directory.resolve("result.json"), output.resolve(retire ? "retirement-result.json" : "result.json"));
                    }
                } finally {
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
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var image = new TreeMap<String, List<String>>();
        try (var connection = source.getConnection()) {
            for (String table : jdbc.queryForList("SELECT table_name FROM information_schema.tables"
                    + " WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name", String.class)) {
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
        }
        return DigestUtils.sha256Hex(JSON.writeValueAsBytes(image));
    }
}
