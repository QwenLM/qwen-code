package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

@EnabledOnOs(OS.LINUX)
class HostedShellLifecycleRecoveryIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "l4-local-fixture";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    @TempDir(cleanup = CleanupMode.ON_SUCCESS)
    private Path temporary;

    @ParameterizedTest
    @ValueSource(strings = {"resident-expiry", "spring-kill", "settle-ack", "detach-ack"})
    @Timeout(240)
    void publicDeletionRecoversOriginalResources(String cut) throws Exception {
        assertThat(required("mysql.url")).startsWith("jdbc:mysql:");
        try (var fixture = new Fixture(cut)) {
            fixture.run();
        }
    }

    private final class Fixture implements AutoCloseable {
        private final String cut;
        private final String tenant = "l4-http-" + UUID.randomUUID();
        private final Path root;
        private final Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath().normalize();
        private final String node = required("node.executable");
        private final HttpClient http = HttpClient.newHttpClient();
        private final HostedLifecycleRelay store = new HostedLifecycleRelay();
        private final HostedLifecycleRelay broker = new HostedLifecycleRelay();
        private final HostedLifecycleRelay control = new HostedLifecycleRelay();
        private final JdbcTemplate jdbc;
        private final JdbcRuntimeBindingRepository bindings;
        private final List<Process> springs = new ArrayList<>();
        private final CountDownLatch firstPrepare = new CountDownLatch(1);
        private final CountDownLatch releaseFirst = new CountDownLatch(1);
        private final CountDownLatch secondPrepare = new CountDownLatch(1);
        private final CountDownLatch releaseSecond = new CountDownLatch(1);
        private final AtomicReference<HostedLifecycleRelay.Request> oldRequest = new AtomicReference<>();
        private final AtomicReference<HostedLifecycleRelay.Request> newRequest = new AtomicReference<>();
        private final AtomicInteger dropped = new AtomicInteger();
        private final AtomicInteger successfulPrepare = new AtomicInteger();
        private final AtomicInteger models = new AtomicInteger();
        private final AtomicReference<Throwable> modelFailure = new AtomicReference<>();
        private final Set<String> approvals = new HashSet<>();
        private HttpServer model;
        private Process harness;
        private URI harnessUri;
        private int springPort;
        private String session;
        private String operation;
        private RuntimeBindingRecord originalBinding;
        private ProcessHandle worker;
        private Map<String, Object> writer;
        private Map<String, Object> manifest;

        private Fixture(String cut) throws Exception {
            this.cut = cut;
            root = Files.createDirectory(temporary.resolve(cut)).toRealPath();
            Files.createDirectories(root.resolve("workspace/child"));
            // Keep initialized-root mtime distinct from birth time without relying on sleeps.
            Files.setLastModifiedTime(root.resolve("workspace"), FileTime.fromMillis(1));
            Files.createDirectory(root.resolve("broker"), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Files.createDirectory(root.resolve("decoy"));
            Files.createDirectory(root.resolve("objects"));
            var source = new DriverManagerDataSource(required("mysql.url"), required("mysql.user"),
                    System.getProperty("mysql.password", ""));
            jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(source);
            jdbc.setQueryTimeout(10);
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("l4-fixture", new byte[32]));
        }

        private void run() throws Exception {
            startHarness();
            startSpring();
            var storageRegistrationProperties = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
            storageRegistrationProperties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
            storageRegistrationProperties.getRuntimeBroker().setWorkspaceMounts(List.of(
                    new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                            tenant, "storage", root.resolve("workspace").toString())));
            new com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard(jdbc,
                    new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()), storageRegistrationProperties)
                    .register(tenant, "storage", UUID.randomUUID().toString());
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage', 'L4', ?, ?, 'ACTIVE')",
                    tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
            session = create("original");
            assertThat(jdbc.queryForObject("SELECT tool_profile FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    String.class, tenant, session)).isEqualTo("hosted-workspace-shell/1");
            var input = List.of(Map.of("type", "input_text", "text", "L4_SHELL"));
            request("POST", "/v1/agents/sessions/" + session + "/events",
                    Map.of("type", "agent.session.input.message", "input", input), "shell-turn", 202);
            await().atMost(Duration.ofSeconds(45)).failFast(() -> modelFailure.get() != null).untilAsserted(() -> {
                answerApproval();
                assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                        String.class, tenant, session)).isEqualTo("COMPLETED");
            });
            assertThat(Files.readString(root.resolve("workspace/child/lifecycle-marker.txt"))).isEqualTo("once\n");
            assertThat(models.get()).isEqualTo(2);
            var executions = jdbc.queryForList("SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns() + " FROM ma_tool_execution WHERE harness_session_id = ?", session);
            assertThat(executions).hasSize(1);
            assertThat(executions.getFirst().get("execution_state")).isEqualTo("SETTLED");
            assertThat(((Number) executions.getFirst().get("dispatch_generation")).longValue()).isEqualTo(1);
            originalBinding = bindings.findById((String) executions.getFirst().get("binding_id"));
            String resource = (String) originalBinding.getResourceHandle().getValue().get("resourceId");
            var registration = JSON.readTree(Files.readString(root.resolve("broker/" + resource + ".json")));
            worker = ProcessHandle.of(registration.path("pid").asLong()).orElseThrow();
            assertThat(worker.isAlive()).isTrue();
            writer = writerIdentity();
            var publications = jdbc.queryForList("SELECT publication_id FROM ma_output_capture"
                    + " WHERE tenant_id = ? AND session_id = ? AND capture_bytes = 1048576", String.class, tenant, session);
            assertThat(publications).hasSize(1);
            var manifests = jdbc.queryForList("SELECT resource_id, sha256, inline_bytes FROM ma_resource"
                    + " WHERE tenant_id = ? AND session_id = ? AND kind = 'managed-tool-result-manifest'", tenant, session);
            assertThat(manifests).hasSize(1);
            manifest = manifests.getFirst();
            JsonNode capture = JSON.readTree((byte[]) manifest.get("inline_bytes"));
            var execution = executions.getFirst();
            var reference = JSON.readTree(execution.get("reference_json").toString());
            assertThat(reference.path("dispatchMode").asText()).isEqualTo("deferred_v3");
            assertThat(reference.path("argsDigest").asText()).matches("sha256:[0-9a-f]{64}");
            assertThat(capture.path("tenantId").asText()).isEqualTo(tenant);
            assertThat(capture.path("sessionId").asText()).isEqualTo(session);
            assertThat(capture.path("turnId").asText()).isEqualTo(execution.get("turn_id"));
            assertThat(capture.path("executionCallId").asText()).isEqualTo(execution.get("execution_call_id"));
            assertThat(capture.path("callId")).isEqualTo(reference.path("callId"));
            assertThat(capture.path("invocationDigest")).isEqualTo(reference.path("argsDigest"));
            assertThat(capture.path("bindingGeneration").asLong()).isEqualTo(originalBinding.getGeneration());
            assertThat(capture.path("captureStatus").asText()).isEqualTo("complete");
            assertThat(capture.path("executionStatus").asText()).isEqualTo("success");
            assertThat(capture.path("contents").size()).isEqualTo(2);
            var streams = new HashSet<String>();
            for (JsonNode stream : capture.path("contents")) {
                streams.add(stream.path("streamId").asText());
                assertThat(stream.path("state").asText()).isEqualTo("sealed");
            }
            assertThat(streams).containsExactlyInAnyOrder("stdout", "stderr");
            assertManifestUnchanged();
            var outputs = jdbc.queryForList("SELECT capture_object_key, byte_length, sha256, slot_key, capture_state"
                    + " FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND capture_object_key IS NOT NULL",
                    tenant, session);
            assertThat(outputs).as("real foreground capture before lifecycle admission").isNotEmpty();
            boolean stdout = false;
            for (var output : outputs) {
                assertThat(output.get("capture_state")).isEqualTo("VERIFIED");
                byte[] bytes = Files.readAllBytes(root.resolve("objects").resolve(output.get("capture_object_key").toString()));
                assertThat(bytes).hasSize(((Number) output.get("byte_length")).intValue());
                assertThat(java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)))
                        .isEqualTo(output.get("sha256"));
                stdout |= output.get("slot_key").toString().startsWith("segment:stdout:")
                        && new String(bytes, StandardCharsets.UTF_8).contains("L4_CAPTURE_STDOUT");
            }
            assertThat(stdout).isTrue();
            String companion = create("companion");
            await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                    "SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    String.class, tenant, companion)).isEqualTo("ACTIVE"));
            installFault();
            boolean web = cut.equals("detach-ack");
            var admitted = web ? request("POST", "/api/agent/web-shell/v1/sessions/delete",
                    Map.of("sessionId", session, "idempotencyKey", "delete"), "delete", 202)
                    : request("DELETE", "/v1/agents/sessions/" + session, null, "delete", 202);
            operation = admitted.path(web ? "operationId" : "id").asText();
            assertThat(operation).isNotBlank();
            if (cut.equals("resident-expiry") || cut.equals("spring-kill")) {
                recoverExpiredResident();
            }
            await().atMost(Duration.ofSeconds(70)).failFast(() -> control.failure() != null).untilAsserted(() -> {
                var result = request("GET", "/v1/agents/sessions/" + session + "/operations/" + operation, null, null, 200);
                assertThat(result.path("status").asText()).isEqualTo("completed");
            });
            assertThat(successfulPrepare.get()).isPositive();
            assertThat(dropped.get()).isEqualTo(cut.endsWith("ack") ? 1 : 0);
            assertThat(models.get()).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE harness_session_id = ?",
                    Integer.class, session)).isEqualTo(1);
            var released = bindings.findById(originalBinding.getBindingId());
            assertThat(released.getGeneration()).isEqualTo(originalBinding.getGeneration());
            assertThat(released.getResourceHandle()).isEqualTo(originalBinding.getResourceHandle());
            assertThat(released.getDrainReceipt()).isNotNull();
            assertThat(released.getDrainReceipt().matches(originalBinding)).isTrue();
            assertThat(jdbc.queryForObject("SELECT binding_state FROM ma_runtime_binding WHERE binding_id = ?",
                    String.class, originalBinding.getBindingId())).isEqualTo("RELEASED");
            assertThat(running(worker)).isFalse();
            // The completion transaction of a DELETE retires the Session and nulls the
            // head's writer identity with it, so only the writer generation column still
            // witnesses the writer count: the pre-delete writer alone, plus the reload
            // that re-acquired the session after the detach-ack cut lost the first reply.
            if (cut.equals("detach-ack")) {
                assertThat(((Number) writerIdentity().get("writer_generation")).longValue())
                        .isEqualTo(((Number) writer.get("writer_generation")).longValue() + 1);
            } else {
                assertThat(((Number) writerIdentity().get("writer_generation")).longValue())
                        .isEqualTo(((Number) writer.get("writer_generation")).longValue());
            }
            assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head WHERE tenant_id = ? AND session_id = ?",
                    String.class, tenant, session)).isEqualTo("DELETED");
            assertThat(jdbc.queryForObject("SELECT lifecycle_protocol_version FROM ma_operation WHERE operation_id = ?",
                    Integer.class, operation)).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    String.class, tenant, session)).isEqualTo("DELETED");
            request("GET", "/v1/agents/sessions/" + session, null, null, 404);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL AND session_kind = 'PUBLIC' AND tenant_id = ? AND session_id = ?",
                    Integer.class, tenant, session)).isEqualTo(1);
            // The restarted ledger scan and capture GC each retry on a one-minute cadence.
            await().atMost(Duration.ofSeconds(150)).untilAsserted(() -> {
                var collections = jdbc.queryForList("SELECT completed_at AS collected_at, CAST(JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.collectedBytes')) AS UNSIGNED) AS collected_bytes FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC'"
                        + " AND tenant_id = ? AND session_id = ?", tenant, session);
                assertThat(collections).hasSize(1);
                assertThat(collections.getFirst().get("collected_at")).isNotNull();
                assertThat(((Number) collections.getFirst().get("collected_at")).longValue()).isPositive();
                var publication = jdbc.queryForMap("SELECT retention_state, collected_at FROM ma_output_capture"
                        + " WHERE tenant_id = ? AND session_id = ? AND publication_id = ?", tenant, session, publications.getFirst());
                assertThat(publication.get("retention_state")).isEqualTo("COLLECTED");
                assertThat(publication.get("collected_at")).isNotNull();
                for (var output : outputs) {
                    assertThat(jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE capture_object_key = ?",
                            String.class, output.get("capture_object_key"))).isEqualTo("COLLECTED");
                    assertThat(root.resolve("objects").resolve(output.get("capture_object_key").toString())).doesNotExist();
                }
            });
            assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    String.class, tenant, companion)).isEqualTo("ACTIVE");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL AND session_kind = 'PUBLIC' AND tenant_id = ? AND session_id = ?",
                    Integer.class, tenant, companion)).isZero();
            assertThat(Files.readString(root.resolve("workspace/child/lifecycle-marker.txt"))).isEqualTo("once\n");
            assertThat(root.resolve("decoy/lifecycle-marker.txt")).doesNotExist();
            assertThat(control.failure()).isNull();
            assertThat(store.failure()).isNull();
            assertThat(broker.failure()).isNull();
            assertThat(modelFailure.get()).isNull();
            var evidence = new LinkedHashMap<String, Object>();
            evidence.put("cut", cut);
            evidence.put("session", session);
            evidence.put("operation", operation);
            evidence.put("springPids", springs.stream().map(Process::pid).toList());
            evidence.put("harnessPid", harness.pid());
            evidence.put("workerPid", worker.pid());
            evidence.put("bindingId", originalBinding.getBindingId());
            evidence.put("runtimeGeneration", originalBinding.getGeneration());
            evidence.put("originalResource", originalBinding.getResourceHandle().getValue());
            evidence.put("writerId", writer.get("writer_id"));
            evidence.put("writerGeneration", writer.get("writer_generation"));
            evidence.put("finalWriterId", writerIdentity().get("writer_id"));
            evidence.put("finalWriterGeneration", writerIdentity().get("writer_generation"));
            evidence.put("finalClaimGeneration", jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_id = ?",
                    Long.class, operation));
            if (oldRequest.get() != null) {
                evidence.put("oldClaimGeneration", JSON.readTree(oldRequest.get().body()).at("/authority/claimGeneration").asLong());
            }
            evidence.put("publicationId", publications.getFirst());
            evidence.put("collectedObjects", outputs.size());
            evidence.put("manifestId", manifest.get("resource_id"));
            evidence.put("manifestDigest", manifest.get("sha256"));
            evidence.put("originalStopProofVerified", true);
            evidence.put("lostReplies", dropped.get());
            JSON.writeValue(root.resolve("evidence.json").toFile(), evidence);
            System.out.println("L4_SHELL_RECOVERY_OK " + cut + " " + root);
        }

        private void installFault() {
            control.fault(new HostedLifecycleRelay.Fault() {
                public boolean before(HostedLifecycleRelay.Request request) throws Exception {
                    if (!phase(request).equals("prepare_resources")) {
                        return true;
                    }
                    if (!cut.equals("resident-expiry") && !cut.equals("spring-kill")) {
                        return true;
                    }
                    if (oldRequest.compareAndSet(null, request)) {
                        firstPrepare.countDown();
                        assertThat(releaseFirst.await(40, TimeUnit.SECONDS)).as("first prepare gate released").isTrue();
                        return !cut.equals("spring-kill");
                    }
                    if (cut.equals("spring-kill") && newRequest.compareAndSet(null, request)) {
                        secondPrepare.countDown();
                        assertThat(releaseSecond.await(30, TimeUnit.SECONDS)).as("second prepare gate released").isTrue();
                    }
                    return true;
                }

                public boolean after(HostedLifecycleRelay.Request request, int status) throws Exception {
                    if (phase(request).equals("prepare_resources") && status == 200) {
                        successfulPrepare.incrementAndGet();
                        if (!cut.equals("detach-ack") || dropped.get() == 0) {
                            assertThat(writerIdentity()).isEqualTo(writer);
                        }
                        assertThat(liveWriter()).isTrue();
                        assertManifestUnchanged();
                    }
                    if (phase(request).equals("settle_resources") && status == 200) {
                        assertManifestUnchanged();
                    }
                    boolean lose = cut.equals("settle-ack") && phase(request).equals("settle_resources")
                            || cut.equals("detach-ack") && request.path().equals("/session/" + session + "/detach");
                    if (cut.equals("detach-ack") && lose && status == 204 && dropped.get() == 0) {
                        assertThat(writerIdentity()).isEqualTo(writer);
                        assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head WHERE tenant_id = ? AND session_id = ?",
                                String.class, tenant, session)).isEqualTo("SEALED");
                    }
                    return !(lose && status >= 200 && status < 300 && dropped.compareAndSet(0, 1));
                }
            });
        }

        private void recoverExpiredResident() throws Exception {
            assertThat(firstPrepare.await(20, TimeUnit.SECONDS)).as("first real prepare request").isTrue();
            await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
                assertThat(jdbc.queryForObject("SELECT phase FROM ma_session_head"
                        + " WHERE tenant_id = ? AND harness_session_id = ?", String.class, tenant, session)).isEqualTo("DRAINING");
                assertThat(jdbc.queryForObject("SELECT lifecycle_effects_receipt_json FROM ma_operation WHERE operation_id = ?",
                        String.class, operation)).isNotBlank();
                assertThat(liveWriter()).isFalse();
            });
            assertThat(writerIdentity()).isEqualTo(writer);
            if (cut.equals("spring-kill")) {
                Process first = springs.getFirst();
                first.destroyForcibly();
                assertThat(first.waitFor(10, TimeUnit.SECONDS)).isTrue();
                assertThat(first.exitValue()).isEqualTo(137);
                assertThat(running(worker)).as("original worker survives Spring SIGKILL").isTrue();
                assertThat(harness.isAlive()).isTrue();
                releaseFirst.countDown();
                await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(jdbc.queryForObject(
                        "SELECT claim_until <= " + ManagedSchemaTime.SQL_NOW + " FROM ma_operation WHERE operation_id = ?", Boolean.class, operation)).isTrue());
                startSpring();
                assertThat(secondPrepare.await(30, TimeUnit.SECONDS)).as("second Spring resource claim").isTrue();
                long oldGeneration = JSON.readTree(oldRequest.get().body()).at("/authority/claimGeneration").asLong();
                long nextGeneration = JSON.readTree(newRequest.get().body()).at("/authority/claimGeneration").asLong();
                assertThat(nextGeneration).isGreaterThan(oldGeneration);
                assertThat(jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_id = ?",
                        Long.class, operation)).isEqualTo(nextGeneration);
                assertThat(writerIdentity()).isEqualTo(writer);
                assertThat(liveWriter()).isTrue();
                long revision = jdbc.queryForObject("SELECT journal_revision FROM ma_session_head"
                        + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session);
                var stale = replay(oldRequest.get());
                assertThat(stale.statusCode()).isEqualTo(503);
                assertThat(JSON.readTree(stale.body()).path("code").asText()).isEqualTo("workspace_lifecycle_claim_fenced");
                assertThat(writerIdentity()).isEqualTo(writer);
                assertThat(jdbc.queryForObject("SELECT journal_revision FROM ma_session_head"
                        + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session)).isEqualTo(revision);
                assertThat(bindings.findById(originalBinding.getBindingId()).getResourceHandle()).isEqualTo(originalBinding.getResourceHandle());
                releaseSecond.countDown();
            } else {
                releaseFirst.countDown();
            }
        }

        private HttpResponse<String> replay(HostedLifecycleRelay.Request saved) throws Exception {
            var request = HttpRequest.newBuilder(harnessUri.resolve(saved.path())).timeout(Duration.ofSeconds(10))
                    .method(saved.method(), HttpRequest.BodyPublishers.ofByteArray(saved.body()));
            saved.headers().forEach((name, values) -> {
                if (name.equalsIgnoreCase("authorization") || name.equalsIgnoreCase("content-type")
                        || name.toLowerCase(java.util.Locale.ROOT).startsWith("x-qwen-")) {
                    values.forEach(value -> request.header(name, value));
                }
            });
            return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        }

        private String phase(HostedLifecycleRelay.Request request) throws IOException {
            return request.path().endsWith("/lifecycle") ? JSON.readTree(request.body()).path("phase").asText() : "";
        }

        private Map<String, Object> writerIdentity() {
            return jdbc.queryForMap("SELECT writer_id, writer_generation, lease_token_hash FROM ma_session_head"
                    + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        }

        private void assertManifestUnchanged() throws Exception {
            var rows = jdbc.queryForList("SELECT resource_id, sha256, inline_bytes FROM ma_resource"
                    + " WHERE tenant_id = ? AND session_id = ? AND kind = 'managed-tool-result-manifest'", tenant, session);
            assertThat(rows).hasSize(1);
            assertThat(rows.getFirst().get("resource_id")).isEqualTo(manifest.get("resource_id"));
            assertThat(rows.getFirst().get("sha256")).isEqualTo(manifest.get("sha256"));
            assertThat((byte[]) rows.getFirst().get("inline_bytes")).isEqualTo((byte[]) manifest.get("inline_bytes"));
            assertThat(java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest((byte[]) rows.getFirst().get("inline_bytes")))).isEqualTo(manifest.get("sha256"));
        }

        private boolean liveWriter() {
            return Boolean.TRUE.equals(jdbc.queryForObject("SELECT writer_lease_until > " + ManagedSchemaTime.SQL_NOW + " FROM ma_session_head WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session));
        }

        private String create(String key) throws Exception {
            return request("POST", "/v1/agents/sessions", Map.of("agent_id", "qwen-code", "input", List.of(),
                    "workspace", Map.of("workspace_id", "workspace", "cwd_relative", "child")), key, 202).path("id").asText();
        }

        private void answerApproval() throws Exception {
            var actions = request("GET", "/v1/agents/sessions/" + session + "/actions", null, null, 200);
            for (var action : actions.path("data")) {
                String id = action.path("id").asText();
                if (approvals.contains(id)) {
                    continue;
                }
                request("POST", "/v1/agents/sessions/" + session + "/actions/" + id + "/responses",
                        Map.of("kind", "permission", "option_id", "allow", "input_revision", action.path("input_revision").asLong(),
                                "policy_revision", action.path("policy_revision").asText()), id, 202);
                approvals.add(id);
            }
        }

        private JsonNode request(String method, String path, Object body, String key, int status) throws Exception {
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + springPort + path)).timeout(Duration.ofSeconds(10))
                    .header("X-Qwen-Tenant-Id", tenant).header("X-G0-Fixture-Actor", "actor")
                    .header("Content-Type", "application/json").method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body)));
            if (key != null) {
                request.header("Idempotency-Key", key);
            }
            var response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).as("%s %s: %s", method, path, response.body()).isEqualTo(status);
            return JSON.readTree(response.body());
        }

        private void startSpring() throws Exception {
            springPort = freePort();
            int brokerPort = freePort();
            var properties = new LinkedHashMap<String, Object>();
            properties.put("server.address", "127.0.0.1");
            properties.put("server.port", springPort);
            properties.put("spring.mvc.log-request-details", false);
            properties.put("logging.level.org.springframework.web.servlet.DispatcherServlet", "DEBUG");
            properties.put("logging.level.org.springframework.web.servlet.mvc.method.annotation."
                    + "ExceptionHandlerExceptionResolver", "DEBUG");
            properties.put("spring.datasource.url", required("mysql.url"));
            properties.put("spring.datasource.driver-class-name", "com.mysql.cj.jdbc.Driver");
            properties.put("spring.datasource.username", required("mysql.user"));
            properties.put("spring.datasource.password", System.getProperty("mysql.password", ""));
            String prefix = "qwen.managed-agent.";
            properties.put(prefix + "session-store.enabled", true);
            properties.put(prefix + "session-store.base-url", store.uri());
            properties.put(prefix + "session-store.workspace-id", "unused-global-workspace");
            properties.put(prefix + "session-store.writer-lease-duration", "8s");
            properties.put(prefix + "dispatch.lease-duration", "5s");
            properties.put(prefix + "dispatch.lease-renew-interval", "1s");
            properties.put(prefix + "dispatch.retry-initial-delay", "500ms");
            properties.put(prefix + "dispatch.retry-max-delay", "1s");
            properties.put(prefix + "harness.enabled", true);
            properties.put(prefix + "harness.workspace-files-enabled", true);
            properties.put(prefix + "harness.workspace-shell-enabled", true);
            properties.put(prefix + "harness.base-url", control.uri());
            properties.put(prefix + "harness.token", TOKEN);
            properties.put(prefix + "harness.capability-digest", DIGEST);
            properties.put(prefix + "harness.approval-mode", "default");
            properties.put(prefix + "runtime-broker.enabled", true);
            properties.put(prefix + "runtime-broker.port", brokerPort);
            properties.put(prefix + "runtime-broker.token", TOKEN);
            properties.put(prefix + "runtime-broker.durable-local-process", true);
            properties.put(prefix + "runtime-broker.verified-workspace-recovery-enabled", true);
            properties.put(prefix + "runtime-broker.trusted-local-reboot-recovery", false);
            properties.put(prefix + "runtime-broker.workspace-cwd", root.resolve("decoy"));
            properties.put(prefix + "runtime-broker.state-directory", root.resolve("broker"));
            properties.put(prefix + "runtime-broker.credential-key-id", "l4-fixture");
            properties.put(prefix + "runtime-broker.credential-key", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
            properties.put(prefix + "runtime-broker.node-executable", node);
            properties.put(prefix + "runtime-broker.worker-entry", cli);
            properties.put(prefix + "runtime-broker.workspace-mounts[0].tenant-id", tenant);
            properties.put(prefix + "runtime-broker.workspace-mounts[0].storage-id", "storage");
            properties.put(prefix + "runtime-broker.workspace-mounts[0].root", root.resolve("workspace"));
            properties.put(prefix + "tool-publication.enabled", true);
            properties.put(prefix + "tool-publication.oss-endpoint", "https://oss-cn-hangzhou.aliyuncs.com");
            properties.put(prefix + "tool-publication.oss-region", "cn-hangzhou");
            properties.put(prefix + "tool-publication.oss-bucket", "private-test-bucket");
            properties.put(prefix + "tool-publication.service-base-url", store.uri());
            properties.put(prefix + "tool-publication.execution-bytes", 1048576);
            properties.put(prefix + "tool-publication.session-bytes", 1073741824);
            properties.put(prefix + "tool-publication.tenant-bytes", 1073741824);
            properties.put(prefix + "tool-publication.active-captures", 4);
            properties.put(prefix + "tool-publication.entry-concurrency", 4);
            properties.put(prefix + "tool-publication.operation-timeout", "10s");
            properties.put(prefix + "tool-publication.claim-timeout", "5s");
            properties.put(prefix + "tool-publication.verification-bytes-per-second", 1048576);
            properties.put(prefix + "tool-publication.max-verification-timeout", "20m");
            properties.put(prefix + "tool-publication.gc-enabled", true);
            properties.put(prefix + "tool-publication.deletion-grace", "0s");
            int boot = springs.size() + 1;
            Path config = root.resolve("spring-" + boot + ".json");
            Path ready = root.resolve("ready-" + boot + ".json");
            properties.replaceAll((key, value) -> value.toString());
            JSON.writeValue(config.toFile(), Map.of("tenant", tenant, "properties", properties, "ready", ready.toString(),
                    "objects", root.resolve("objects").toString()));
            Files.setPosixFilePermissions(config, PosixFilePermissions.fromString("rw-------"));
            String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
            var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin/java").toString(), "-cp", classpath,
                    HostedShellLifecycleFixtureMain.class.getName(), config.toString())
                    .redirectErrorStream(true).redirectOutput(root.resolve("spring-" + boot + ".log").toFile()).start();
            springs.add(process);
            await().atMost(Duration.ofSeconds(40)).until(() -> Files.exists(ready) || !process.isAlive());
            assertThat(process.isAlive()).as("Spring boot: %s", Files.readString(root.resolve("spring-" + boot + ".log"))).isTrue();
            assertThat(JSON.readTree(Files.readString(ready)).path("pid").asLong()).isEqualTo(process.pid());
            store.backend(URI.create("http://127.0.0.1:" + springPort));
            broker.backend(URI.create("http://127.0.0.1:" + brokerPort));
        }

        private void startHarness() throws Exception {
            model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            model.createContext("/", this::modelReply);
            model.start();
            Path home = Files.createDirectory(root.resolve("home"));
            Path config = Files.createDirectory(home.resolve(".qwen"));
            String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
            Files.writeString(config.resolve("settings.json"), JSON.writeValueAsString(Map.of("security",
                    Map.of("auth", Map.of("selectedType", "openai")), "model", Map.of("name", "l4-fixture"),
                    "telemetry", Map.of("enabled", false), "modelProviders", Map.of("openai", List.of(Map.of(
                            "id", "l4-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl))))));
            harnessUri = URI.create("http://127.0.0.1:" + freePort());
            var builder = new ProcessBuilder(node, cli.toString(), "serve", "--profile", "hosted-harness", "--http-bridge",
                    "--hostname", "127.0.0.1", "--port", Integer.toString(harnessUri.getPort()), "--require-auth", "--no-web",
                    "--workspace", root.resolve("decoy").toString(), "--managed-runtime-broker-url", broker.uri().toString(),
                    "--managed-runtime-broker-token", TOKEN).directory(root.resolve("decoy").toFile())
                    .redirectErrorStream(true).redirectOutput(root.resolve("harness.log").toFile());
            var environment = builder.environment();
            String path = environment.get("PATH");
            environment.clear();
            environment.put("PATH", path);
            environment.put("HOME", home.toString());
            environment.put("QWEN_HOME", config.toString());
            environment.put("QWEN_RUNTIME_DIR", root.resolve("runtime").toString());
            environment.put("OPENAI_API_KEY", "fake-local-key");
            environment.put("OPENAI_BASE_URL", modelUrl);
            environment.put("QWEN_SERVER_TOKEN", TOKEN);
            environment.put("QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST);
            environment.put("QWEN_HOSTED_LIFECYCLE_V2_PROFILES", "hosted-workspace-shell/1");
            environment.put("TMPDIR", root.toString());
            for (String name : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH", "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
                environment.put(name, root.resolve(name + ".json").toString());
            }
            harness = builder.start();
            await().atMost(Duration.ofSeconds(30)).ignoreExceptions().untilAsserted(() -> assertThat(http.send(
                    HttpRequest.newBuilder(harnessUri.resolve("/capabilities")).timeout(Duration.ofSeconds(2))
                            .header("Authorization", "Bearer " + TOKEN).build(), HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(200));
            control.backend(harnessUri);
        }

        private void modelReply(HttpExchange exchange) throws IOException {
            try {
                JsonNode request = JSON.readTree(exchange.getRequestBody());
                int call = models.getAndIncrement();
                assertThat(call).isLessThan(2);
                if (call == 1) {
                    assertThat(request.path("messages").toString()).contains("L4_CAPTURE_STDOUT");
                }
                var chunk = JSON.createObjectNode().put("id", "l4").put("object", "chat.completion.chunk").put("created", 0).put("model", "l4-fixture");
                var choice = chunk.putArray("choices").addObject().put("index", 0);
                var delta = choice.putObject("delta").put("role", "assistant");
                if (call == 0) {
                    delta.putArray("tool_calls").addObject().put("index", 0).put("id", "l4-shell")
                            .put("type", "function").putObject("function").put("name", "run_shell_command")
                            .put("arguments", JSON.writeValueAsString(Map.of("command",
                                    "printf 'once\\n' >> lifecycle-marker.txt; printf 'L4_CAPTURE_STDOUT\\n'", "description", "L4 Shell proof")));
                }
                else {
                    delta.put("content", "L4_DONE");
                }
                choice.putNull("finish_reason");
                String first = "data: " + JSON.writeValueAsString(chunk) + "\n\n";
                choice.putObject("delta");
                choice.put("finish_reason", call == 0 ? "tool_calls" : "stop");
                byte[] response = (first + "data: " + JSON.writeValueAsString(chunk) + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, response.length);
                exchange.getResponseBody().write(response);
            } catch (Exception | AssertionError error) {
                modelFailure.compareAndSet(null, error);
            } finally {
                exchange.close();
            }
        }

        @Override
        public void close() throws Exception {
            releaseFirst.countDown();
            releaseSecond.countDown();
            var cleanup = new ArrayList<org.junit.jupiter.api.function.Executable>();
            for (Process process : springs) {
                cleanup.add(() -> {
                    process.destroyForcibly();
                    assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
                });
            }
            cleanup.add(() -> {
                if (harness != null) {
                    harness.destroyForcibly();
                    assertThat(harness.waitFor(10, TimeUnit.SECONDS)).isTrue();
                }
            });
            cleanup.add(control::close);
            cleanup.add(store::close);
            cleanup.add(broker::close);
            cleanup.add(() -> { if (model != null) {
                    model.stop(0);
                } });
            cleanup.add(() -> HostedDurableWorkers.stop(root.resolve("broker"), JSON));
            cleanup.add(http::shutdownNow);
            try {
                org.junit.jupiter.api.Assertions.assertAll("task-owned process cleanup", cleanup);
            } finally {
                Path evidence = Path.of("target/l4-shell-lifecycle", cut);
                Files.createDirectories(evidence);
                // Walk, not list: the daemon log sits under runtime/debug/daemon/.
                try (var files = Files.walk(root)) {
                    for (Path file : files.filter(Files::isRegularFile).filter(file -> file.toString().endsWith(".log") || file.getFileName().toString().equals("evidence.json")).toList()) {
                        Path target = evidence.resolve(root.relativize(file).toString());
                        Files.createDirectories(target.getParent());
                        Files.copy(file, target, StandardCopyOption.REPLACE_EXISTING);
                    }
                }
            }
        }
    }

    private static int freePort() throws IOException {
        try (var socket = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            return socket.getLocalPort();
        }
    }

    private static boolean running(ProcessHandle process) throws IOException {
        if (!process.isAlive()) {
            return false;
        }
        try {
            String stat = Files.readString(Path.of("/proc", Long.toString(process.pid()), "stat"));
            return stat.charAt(stat.lastIndexOf(')') + 2) != 'Z';
        } catch (java.nio.file.NoSuchFileException exited) {
            return false;
        }
    }

    private static String required(String property) {
        String value = System.getProperty(property);
        assertThat(value).as(property).isNotBlank();
        return value;
    }
}
