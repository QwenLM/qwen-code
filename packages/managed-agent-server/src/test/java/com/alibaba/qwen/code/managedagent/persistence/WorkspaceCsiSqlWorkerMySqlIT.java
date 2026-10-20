package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiFilesProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.RuntimeBrokerHttpServer;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, false);
        }
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

    @Test
    void hostedProducerRecoversMissingSettledReceiptWithoutRepeatingFileEffects() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, true, true, "missing_receipt");
        }
    }

    @Test
    void hostedProducerConsumesCommittedFinalOutputWithoutAnotherModelRequest() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, true, true, "final_output");
        }
    }

    @Test
    void coldWriterContentionAtReadCommittedHasOneInstalledWinner() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, true, true, "receipt_complete", Connection.TRANSACTION_READ_COMMITTED);
        }
    }

    @Test
    void coldWriterContentionAtWarmedRepeatableReadHasOneInstalledWinner() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, true, true, "receipt_complete", Connection.TRANSACTION_REPEATABLE_READ);
        }
    }

    @Test
    void originalHostedProducerDrainsApplicationWithoutReleasingItsBindingOrHolder() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            acceptance(database.source(), directory, true, false, true);
        }
    }

    static void acceptance(DataSource source, Path directory, boolean hostedProducer) throws Exception {
        acceptance(source, directory, hostedProducer, false);
    }

    static void acceptance(DataSource source, Path directory, boolean hostedProducer, boolean coldRecovery) throws Exception {
        acceptance(source, directory, hostedProducer, coldRecovery, "receipt_complete");
    }

    static void acceptance(DataSource source, Path directory, boolean hostedProducer, boolean coldRecovery,
            String recoveryCut) throws Exception {
        acceptance(source, directory, hostedProducer, coldRecovery, recoveryCut, 0);
    }

    static void acceptance(DataSource source, Path directory, boolean hostedProducer, boolean coldRecovery,
            String recoveryCut, int isolation) throws Exception {
        acceptance(source, directory, hostedProducer, coldRecovery, recoveryCut, isolation, false);
    }

    private static void acceptance(DataSource source, Path directory, boolean hostedProducer, boolean coldRecovery, boolean retirement) throws Exception {
        acceptance(source, directory, hostedProducer, coldRecovery, "receipt_complete", 0, retirement);
    }

    private static void acceptance(DataSource source, Path directory, boolean hostedProducer, boolean coldRecovery,
            String recoveryCut, int isolation, boolean retirement) throws Exception {
        Path root = Path.of("../..").toRealPath();
        assertThat(Files.isRegularFile(root.resolve("packages/cli/dist/src/serve/managed-csi-file-worker.js")))
                .as("Run npm run build before this explicitly invoked integration gate").isTrue();
        Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        if (isolation != 0) {
            transaction.setIsolationLevel(isolation);
        }
        var cold = new ColdContention(source, manager, isolation);
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
        var application = new WorkspaceCsiApplicationStore(jdbc, manager, journal, bindings, sessions, new HttpRuntimeTransport(mappedClient));
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
            broker.registerCsiApplicationAuthority("tenant", sessionId,
                    (token, body) -> application.workerAuthority("tenant", sessionId, token, body));
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
                                        WorkspaceCsiRuntimeIdentity.map(body.get("mount")), retirement);
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
                                    "SELECT execution_call_id, execution_state, result_json, native_authorization_json FROM ma_tool_execution"
                                            + " ORDER BY execution_call_id"),
                                    "activationRevision", jdbc.queryForObject(
                                            "SELECT first_activation_journal_revision FROM ma_runtime_binding", Long.class),
                                    "nativeReads", nativeReads.get());
                            case "/fixture:retire" -> {
                                var claimed = bindings.claimOperation(initial.getBindingId(), "owned-retire", Duration.ofMinutes(5));
                                var intent = storage.beginRetirement(registration, bindings, claimed, storage.inspect(registration), UUID.randomUUID().toString());
                                yield Map.of("retirementId", intent.operationId());
                            }
                            case "/fixture:leases" -> jdbc.queryForObject("SELECT writer_lease_until, activation_expires_at, "
                                    + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW
                                    + " FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'", (row, number) ->
                                            Map.of("writerLeaseUntil", row.getLong(1), "activationExpiresAt", row.getLong(2),
                                                    "databaseNow", row.getLong(3)));
                            case "/fixture:image" -> databaseImage(source, jdbc);
                            case "/fixture:cold-arm" -> cold.arm(((List<?>) body.get("writers")).stream().map(String.class::cast).toList());
                            case "/fixture:cold-release" -> cold.release();
                            case "/fixture:publication" -> transaction.execute(status -> {
                                var writer = journal.lockPublicationWriter("tenant", "workspace", sessionId,
                                        (String) body.get("writerId"), ((Number) body.get("writerGeneration")).longValue(),
                                        (String) body.get("writerToken"));
                                return Map.of("generation", writer.activationEpoch());
                            });
                            case "/fixture:cold-refusals" -> {
                                var before = databaseImage(source, jdbc);
                                String execution = jdbc.queryForObject("SELECT e.execution_call_id FROM ma_tool_execution e"
                                        + " WHERE EXISTS (SELECT 1 FROM ma_session_journal_tx t WHERE t.operation = 'recordToolResult'"
                                        + " AND t.command_id = e.execution_call_id) ORDER BY e.execution_call_id LIMIT 1", String.class);
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
                    Object response = suffix.startsWith("/csi-retirement")
                            ? suffix.equals("/csi-retirement")
                                ? application.status("tenant", sessionId, query.get("workspaceId"), query.get("retirementId"), token)
                                : application.command("tenant", sessionId, token, suffix.substring("/csi-retirement:".length()), raw.getBytes(StandardCharsets.UTF_8))
                            : suffix.startsWith("/resources/")
                            ? journal.readOwnerResource("tenant", query.get("workspaceId"), sessionId,
                                    suffix.substring("/resources/".length()), token)
                            : transaction.execute(status -> switch (suffix) {
                                case "/writers:acquire" -> cold.acquire(journal, token, sessionId,
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
                    try {
                        respond(exchange, refusal.getStatusCode(), Map.of("error", Map.of("code", refusal.getCode(),
                                "message", refusal.getMessage())));
                    } catch (java.io.IOException ignored) {
                        exchange.close();
                    }
                } catch (ManagedAgentException refusal) {
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
                var inputBody = new java.util.LinkedHashMap<String, Object>(Map.of("adapter", "http://127.0.0.1:" + adapter.getAddress().getPort(),
                        "broker", broker.getBaseUri().toString(), "operatorToken", operatorToken,
                        "foreignOwnerSessionId", foreignOwner,
                        "foreignOwnerOperationId", UUID.nameUUIDFromBytes(foreignOwner.getBytes(StandardCharsets.UTF_8)).toString(),
                        "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", sessionId),
                        "hostedProducer", hostedProducer,
                        "coldRecovery", coldRecovery,
                        "recoveryCut", recoveryCut,
                        "runtime", Map.of("bindingId", binding.getBindingId(), "generation", Long.toString(binding.getGeneration()))));
                inputBody.put("isolation", isolation);
                inputBody.put("retirement", retirement);
                JSON.writeValue(input.toFile(), inputBody);
                Path producer = directory.resolve("producer.mjs");
                try (var script = WorkspaceCsiSqlWorkerMySqlIT.class.getResourceAsStream("/csi-sql-worker-acceptance.mjs");
                        var declarations = WorkspaceCsiSqlWorkerMySqlIT.class.getResourceAsStream("/csi-native-file-declarations.json")) {
                    assertThat(script).isNotNull();
                    assertThat(declarations).isNotNull();
                    Files.copy(script, producer);
                    Files.copy(declarations, directory.resolve("declarations.json"));
                    if (hostedProducer) {
                        try (var hostedScript = WorkspaceCsiSqlWorkerMySqlIT.class.getResourceAsStream("/csi-hosted-file-turns.mjs")) {
                            assertThat(hostedScript).isNotNull();
                            Files.copy(hostedScript, directory.resolve("csi-hosted-file-turns.mjs"));
                        }
                    }
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
                if (retirement) {
                    assertThat(result.path("retirement").path("stage").asText()).isEqualTo("DRAINED");
                    assertThat(result.path("retirement").path("progressVersion").asInt()).isEqualTo(4);
                    assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head", String.class)).isEqualTo("SEALED");
                    assertThat(jdbc.queryForObject("SELECT wake_scan_pending FROM ma_session_head", Boolean.class)).isFalse();
                    assertThat(jdbc.queryForObject("SELECT binding_state FROM ma_runtime_binding", String.class)).isEqualTo("DRAINING");
                    assertThat(jdbc.queryForObject("SELECT csi_phase FROM ma_storage_owner", String.class)).isEqualTo("DRAINING");
                    assertThat(jdbc.queryForObject("SELECT session_state FROM ma_runtime_session", String.class)).isEqualTo("RELEASED");
                    assertThat(jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class)).isEqualTo(binding.getBindingId());
                    assertThat(jdbc.queryForObject("SELECT progress_stage FROM ma_operation WHERE operation_kind='CSI_RETIREMENT'", String.class)).isEqualTo("DRAINED");
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
                        + " AND table_type = 'BASE TABLE'", Integer.class, schema)).isEqualTo(33);
                verify(provisioner).ensureResource(any(), any(), any());
                verify(provisioner).provision(any(), any());
                String evidence = System.getProperty("csi.acceptance.evidence");
                if (evidence != null) {
                    Path output = Path.of(evidence);
                    if (hostedProducer) {
                        output = output.resolve("hosted").resolve(schema);
                    }
                    Files.createDirectories(output);
                    Files.copy(directory.resolve("result.json"), output.resolve("result.json"));
                }
            } finally {
                boolean childExited = true;
                if (child != null && child.isAlive()) {
                    child.destroyForcibly();
                    childExited = child.waitFor(10, TimeUnit.SECONDS);
                }
                cold.stop();
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

    private static void respond(HttpExchange exchange, int status, Object body) throws java.io.IOException {
        byte[] bytes = JSON.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    private static RuntimeResourceHandle identity(RuntimeBindingRecord binding, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation, URI broker, Map<String, Object> mount, boolean retirement) {
        var seed = binding.getProvisionSeed();
        var storage = new LinkedHashMap<String, Object>(Map.of("clusterDomain", registration.clusterDomain(),
                "namespace", registration.namespace(), "pvcUid", registration.pvcUid(), "pvUid", registration.pvUid(),
                "driver", registration.driver(), "volumeHandle", registration.volumeHandle(), "backendDomain", registration.backendDomain(),
                "diskSerial", registration.diskSerial(), "physicalKey", registration.physicalKey()));
        storage.putAll(Map.of("registrationRevision", Long.toString(registration.revision()), "reservationId", reservation.reservationId(),
                "reservationRevision", Long.toString(reservation.revision())));
        var authority = ManagedCsiFilesProtocol.authority(broker.toString().replaceFirst("/$", ""));
        var boot = retirement ? ManagedCsiFilesProtocol.finalizationBoot(binding.getRequest(), seed, storage, authority)
                : ManagedCsiFilesProtocol.boot(binding.getRequest(), seed, storage, authority);
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
        if (retirement) {
            value.put("finalization", boot.get("finalization"));
        }
        value.put("identity", WorkspaceCsiRuntimeIdentity.digest(value));
        var handle = new RuntimeResourceHandle("kubernetes-workspace", retirement ? 4 : 3, value);
        WorkspaceCsiRuntimeIdentity.validate(binding.getRequest(), seed, handle);
        return handle;
    }
}
