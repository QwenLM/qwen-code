package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ManagedCsiFilesProtocol;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Real MySQL/native HTTP/file chain; placement and mount provenance are explicit fixtures. */
class WorkspaceCsiSqlWorkerMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    @TempDir
    Path directory;

    @Test
    void sqlGrantExecutesOriginalWorkerAndContinuesWithRetainedHistory() throws Exception {
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
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "owned-cluster", "owned-runtime",
                    "pvc", "pvc-uid", "pv", "pv-uid", "diskplugin.csi.alibabacloud.com", "volume", "backend",
                    "owned-serial", "/workspace", 1);
            var storage = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
            storage.register(registration);
            var request = WorkspaceCsiRuntimeConstructionFixture.create(source, registration);
            String sessionId = request.getIsolationKey();
            var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("owned", new byte[32]));
            var sessions = new JdbcRuntimeSessionRepository(source);
            var executions = new JdbcToolExecutionRepository(source, bindings);
            var initial = bindings.findOrCreate(request);
            var binding = bindings.claimOperation(initial.getBindingId(), "owned-test", Duration.ofMinutes(5));
            var reserved = storage.reserve(registration, bindings, binding, UUID.randomUUID().toString());
            bindings.releaseOperation(binding.getBindingId(), "owned-test", binding.getOperationGeneration());
            var journal = new ManagedSessionStore(jdbc);
            journal.setCsiBindings(bindings);
            var properties = new ManagedAgentProperties();
            properties.setAgentRevision("construction-fixture/1");
            var endpoint = new AtomicReference<URI>();
            var actualClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
            var mappedClient = mock(HttpClient.class);
            when(mappedClient.followRedirects()).thenReturn(HttpClient.Redirect.NEVER);
            // Only the destination changes; production transport serializes and verifies every wire envelope.
            doAnswer(call -> {
                HttpRequest original = call.getArgument(0);
                assertThat(original.uri().getHost()).isEqualTo("10.4.0.8");
                assertThat(original.uri().getPort()).isEqualTo(43190);
                URI target = endpoint.get();
                assertThat(target).isNotNull();
                var mapped = HttpRequest.newBuilder(target.resolve(original.uri().getRawPath()))
                        .method(original.method(), original.bodyPublisher().orElseThrow());
                original.timeout().ifPresent(mapped::timeout);
                original.headers().map().forEach((key, values) -> values.forEach(value -> mapped.header(key, value)));
                return actualClient.sendAsync(mapped.build(), call.getArgument(1));
            }).when(mappedClient).sendAsync(any(HttpRequest.class), any());
            var access = new WorkspaceCsiRuntimeAccess(jdbc, manager, JSON, properties, registration,
                    sessionId, request.requestKey(), bindings, sessions, new HttpRuntimeTransport(mappedClient));
            var provisioner = mock(RuntimeProvisioner.class);
            var placement = new AtomicReference<RuntimeResourceHandle>();
            when(provisioner.kind()).thenReturn("kubernetes-workspace");
            when(provisioner.createRequest(any(), any(), any())).thenReturn(request);
            doAnswer(call -> CompletableFuture.completedFuture(placement.get()))
                    .when(provisioner).ensureResource(any(), any(), any());
            doAnswer(call -> CompletableFuture.completedFuture(WorkspaceCsiRuntimeIdentity.lease(binding.getProvisionSeed(),
                    WorkspaceCsiRuntimeIdentity.map(placement.get().getValue().get("placement")))))
                    .when(provisioner).provision(any(), any());
            when(provisioner.confirm(any(), any())).thenReturn(CompletableFuture.completedFuture(null));
            when(provisioner.isUsable(any())).thenReturn(true);
            var nativeReads = new AtomicInteger();
            String operatorToken = UUID.randomUUID().toString();
            try (var service = new RuntimeBrokerService(access, provisioner, access, bindings, sessions, executions,
                    "owned-broker", Duration.ofSeconds(30), Duration.ofSeconds(30));
                    var broker = new RuntimeBrokerHttpServer(new InetSocketAddress("127.0.0.1", 0), operatorToken,
                            service, false, (token, body) -> {
                                nativeReads.incrementAndGet();
                                return access.readNative(token, body);
                            })) {
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
                                    var handle = identity(binding, registration, reserved, broker.getBaseUri(),
                                            WorkspaceCsiRuntimeIdentity.map(body.get("mount")));
                                    assertThat(placement.compareAndSet(null, handle)).isTrue();
                                    yield Map.of("boot", WorkspaceCsiRuntimeIdentity.boot(request, binding.getProvisionSeed(), handle),
                                            "pod", WorkspaceCsiRuntimeIdentity.pod(WorkspaceCsiRuntimeIdentity.map(handle.getValue().get("placement"))));
                                }
                                case "/fixture:worker" -> {
                                    URI uri = URI.create((String) body.get("url"));
                                    assertThat(uri.getHost()).isEqualTo("127.0.0.1");
                                    assertThat(uri.getPort()).isPositive();
                                    assertThat(endpoint.compareAndSet(null, uri)).isTrue();
                                    yield Map.of("mapped", true);
                                }
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
                        Object response = suffix.startsWith("/resources/")
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
                    assertThat(child.waitFor(120, TimeUnit.SECONDS)).as("Owned Node chain timed out").isTrue();
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
                            + " AND table_type = 'BASE TABLE'", Integer.class)).isEqualTo(33);
                    verify(provisioner).ensureResource(any(), any(), any());
                    verify(provisioner).provision(any(), any());
                    String evidence = System.getProperty("csi.acceptance.evidence");
                    if (evidence != null) {
                        Path output = Path.of(evidence);
                        Files.createDirectories(output);
                        Files.copy(directory.resolve("result.json"), output.resolve("result.json"));
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

    private static RuntimeResourceHandle identity(RuntimeBindingRecord binding, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation, URI broker, Map<String, Object> mount) {
        var seed = binding.getProvisionSeed();
        var storage = new LinkedHashMap<String, Object>(Map.of("clusterDomain", registration.clusterDomain(),
                "namespace", registration.namespace(), "pvcUid", registration.pvcUid(), "pvUid", registration.pvUid(),
                "driver", registration.driver(), "volumeHandle", registration.volumeHandle(), "backendDomain", registration.backendDomain(),
                "diskSerial", registration.diskSerial(), "physicalKey", registration.physicalKey()));
        storage.putAll(Map.of("registrationRevision", Long.toString(registration.revision()), "reservationId", reservation.reservationId(),
                "reservationRevision", Long.toString(reservation.revision())));
        var authority = ManagedCsiFilesProtocol.authority(broker.toString().replaceFirst("/$", ""));
        var boot = ManagedCsiFilesProtocol.boot(binding.getRequest(), seed, storage, authority);
        String uid = UUID.randomUUID().toString();
        var placement = new LinkedHashMap<String, Object>(Map.of("clusterDomain", registration.clusterDomain(), "namespace", registration.namespace(),
                "namespaceUid", uid, "podName", WorkspaceCsiRuntimeIdentity.name(seed), "podUid", uid, "nodeName", "owned-node", "nodeUid", uid,
                "containerName", "runtime", "containerId", "containerd://" + "a".repeat(64)));
        placement.putAll(Map.of("image", "registry.example/worker@sha256:" + "b".repeat(64), "imageId", "sha256:" + "b".repeat(64),
                "podIp", "10.4.0.8", "secretName", WorkspaceCsiRuntimeIdentity.name(seed), "secretUid", uid));
        var value = new LinkedHashMap<String, Object>();
        value.put("bindingId", binding.getBindingId());
        value.put("runtimeGeneration", Long.toString(binding.getGeneration()));
        value.put("context", WorkspaceCsiRuntimeIdentity.context(boot));
        value.put("storage", storage);
        value.put("placement", placement);
        value.put("protection", Map.of("namespaceUid", uid, "policyName", "owned-policy", "policyUid", uid, "policyGeneration", "1",
                "bindingName", "owned-binding", "bindingUid", uid, "bindingGeneration", "1"));
        value.put("artifacts", List.of());
        value.put("bootDigest", WorkspaceCsiRuntimeIdentity.digest(boot));
        value.put("podSpecDigest", "a".repeat(64));
        value.put("mount", mount);
        value.put("profileIdentity", ManagedCsiFilesProtocol.identity(binding.getRequest()));
        value.put("authority", authority);
        value.put("identity", WorkspaceCsiRuntimeIdentity.digest(value));
        var handle = new RuntimeResourceHandle("kubernetes-workspace", 3, value);
        WorkspaceCsiRuntimeIdentity.validate(binding.getRequest(), seed, handle);
        return handle;
    }
}
