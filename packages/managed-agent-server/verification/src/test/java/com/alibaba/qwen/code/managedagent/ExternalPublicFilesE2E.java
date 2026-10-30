package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.MapPropertySource;
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
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Dedicated opt-in, fresh-MySQL public path; only allocation and OpenAI are fixtures.
 * Run it with {@code mvn -Pexternal-public-files-e2e verify} and explicit mysql.url/user,
 * node.executable, qwen.cli.entry and qwen.external.public-files.tmp (private evidence parent).
 * The class name keeps it out of the {@code Hosted*IT} family: that lane collects the
 * whole family, disables this class, and then fails any collected class that runs no test.
 * Do NOT use hosted-harness-mysql: its automatic isolation extension truncates before tests.
 * The dedicated profile disables extension autodetection and isolation, validates the
 * dedicated server and absent/new issue15512_b2_public_* catalog there, then lets normal
 * Spring initialize it. The condition checks effective JUnit configuration before BeforeAll;
 * the test never truncates. Retained private logs/reports may contain credentials; publish
 * only the sanitized JSON files.
 */
@EnabledIfSystemProperty(named = "qwen.external.public-files.it", matches = "true")
@ExtendWith(ExternalPublicFilesE2E.NoTruncation.class)
@Timeout(300)
class ExternalPublicFilesE2E {
    private static final String PROFILE = "hosted-workspace-external-files/1";
    private static final String PROVIDER = "issue15512-fixture";
    private static final String WORKSPACE = "external-b2";
    private static final String TENANT = "issue15512-public";
    private static final List<String> TOOLS = List.of("write_file", "read_file", "edit", "glob");
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final String harnessToken = UUID.randomUUID().toString();
    private final String brokerToken = UUID.randomUUID().toString();
    private final String adapterToken = UUID.randomUUID().toString();
    private final String digest = "sha256:" + DigestUtils.sha256Hex("issue15512-public-harness");
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private final AtomicInteger modelRequests = new AtomicInteger();
    private final AtomicInteger requests = new AtomicInteger();
    private final java.util.concurrent.ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final Set<String> answered = new HashSet<>();
    private final List<ExecutorService> executors = new ArrayList<>();
    private final List<HttpServer> servers = new ArrayList<>();
    private Path temporary;
    private Path mount;
    private Path decoy;
    private Path control;
    private Path cli;
    private String node;
    private int port;
    private ConfigurableApplicationContext spring;
    private JdbcTemplate jdbc;
    private Process harness;
    private volatile Process worker;
    private volatile JsonNode provision;
    private volatile JsonNode ready;
    private volatile int allocations;
    private volatile int observations;
    private volatile int completedTools;
    private JsonNode registration;
    private Map<String, Object> rootStat;
    private Map<String, Object> descriptorStat;
    private String descriptorHash;

    public static final class NoTruncation implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
            if (Boolean.getBoolean("qwen.external.public-files.it")
                    && context.getConfigurationParameter("qwen.hosted.mysql.isolation")
                            .map(Boolean::parseBoolean).orElse(false)) {
                throw new IllegalStateException("Dedicated fresh-catalog test forbids the truncating Hosted isolation extension");
            }
            return ConditionEvaluationResult.enabled("Dedicated fresh-catalog guard");
        }
    }

    @Test
    void publicFilesAndCloseUseOriginalExternalWorker() throws Exception {
        Throwable problem = null;
        try {
            boot();
            var identity = Map.of("providerId", PROVIDER, "physicalKey", "public-files-physical", "registrationRevision", 1);
            var register = Map.of("identity", identity, "alias", Map.of("tenantWorkspaceId", WORKSPACE,
                    "aliasPath", registration.path("aliasPath").asText(), "mountRoot", mount.toString()),
                    "idempotencyKey", "register", "requestId", "register");
            String registerRoute = "/internal/managed-workspaces/v1/storage:register-external";
            publicRequest("POST", registerRoute, register, null, null, 403);
            assertThat(rows("SELECT storage_id FROM ma_storage")).isEmpty();
            JsonNode registered = publicRequest("POST", registerRoute, register, null, "operator", 200);
            assertThat(publicRequest("POST", registerRoute, register, null, "operator", 200)).isEqualTo(registered);
            var materialize = Map.of("registeredAliasId", WORKSPACE, "displayName", "External public files",
                    "ownerActorId", "owner", "idempotencyKey", "materialize", "requestId", "materialize");
            String materializeRoute = "/internal/managed-workspaces/v1/workspace:materialize-external";
            JsonNode materialized = publicRequest("POST", materializeRoute, materialize, null, "operator", 200);
            assertThat(publicRequest("POST", materializeRoute, materialize, null, "operator", 200)).isEqualTo(materialized);
            assertThat(rows("SELECT actor_id, role FROM ma_workspace_access"))
                    .containsExactly(Map.of("actor_id", "owner", "role", "OWNER"));
            assertThat(publicRequest("GET", "/v1/agents/workspaces", null, null, "owner", 200)
                    .at("/data/0/can_create_session").asBoolean()).isTrue();
            assertThat(publicRequest("GET", "/v1/agents/workspaces", null, null, "outsider", 200).path("data").isEmpty()).isTrue();
            publicRequest("GET", "/v1/agents/workspaces/" + WORKSPACE, null, null, "outsider", 404);
            var storageBefore = rows("SELECT storage_id, physical_key, registration_state, storage_kind, registration_revision, registration_json FROM ma_storage");
            var ownerMetadata = rows("SELECT tenant_id, storage_id, mount_revision, mount_root, physical_key, storage_kind FROM ma_storage_owner");
            assertThat(storageBefore).hasSize(1);
            assertThat(ownerMetadata).hasSize(1);
            JsonNode created = publicRequest("POST", "/v1/agents/sessions", Map.of("agent_id", "qwen-code",
                    "input", List.of(Map.of("type", "input_text", "text", "G0_EXTERNAL_FILES")),
                    "workspace", Map.of("workspace_id", WORKSPACE, "cwd_relative", ".")), "create", "owner", 202);
            String session = created.path("id").asText();
            assertThat(session).isNotBlank();
            await().atMost(Duration.ofSeconds(120)).until(() -> {
                checkFailure();
                answerActions(session);
                return "COMPLETED".equals(jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id = ?", String.class, session));
            });
            checkFailure();
            assertThat(answered).isNotEmpty();
            assertThat(completedTools).isEqualTo(4);
            assertThat(rows("SELECT tool_profile, approval_mode, workspace_id, workspace_storage_id FROM ma_session WHERE session_kind = 'PUBLIC'"))
                    .containsExactly(Map.of("tool_profile", PROFILE, "approval_mode", "default", "workspace_id", WORKSPACE, "workspace_storage_id", WORKSPACE));
            assertThat(Files.readString(mount.resolve("proof.txt"))).isEqualTo("after");
            assertThat(Files.exists(decoy.resolve("proof.txt"))).isFalse();
            assertThat(rows("SELECT execution_status FROM ma_tool_execution"))
                    .hasSize(4).allSatisfy(row -> assertThat(row.get("execution_status")).isEqualTo("success"));
            var bindings = rows("SELECT binding_id, runtime_generation, binding_state, provision_request_id, resource_handle_json, runtime_instance_id FROM ma_runtime_binding");
            assertThat(bindings).hasSize(1);
            var binding = bindings.getFirst();
            String bindingId = binding.get("binding_id").toString();
            assertThat(binding.get("binding_state")).isEqualTo("READY");
            assertThat(binding.get("runtime_instance_id")).isEqualTo(ready.path("runtimeInstanceId").asText());
            var held = rows("SELECT holder_key, binding_id, runtime_generation, runtime_session_id FROM ma_storage_owner").getFirst();
            assertThat(held.get("holder_key")).isNotNull();
            assertThat(held.get("binding_id")).isEqualTo(bindingId);
            assertThat(held.get("runtime_generation")).isEqualTo(binding.get("runtime_generation"));
            assertThat(rows("SELECT runtime_session_id FROM ma_runtime_session WHERE binding_id = ?", bindingId))
                    .anySatisfy(row -> assertThat(row.get("runtime_session_id")).isEqualTo(held.get("runtime_session_id")));
            evidence("held-after-turn", held);
            var retained = rows("SELECT resource_id, sha256, kind FROM ma_resource ORDER BY resource_id");
            assertThat(retained).isNotEmpty();
            var history = history(session);
            assertThat(history).isNotEmpty();
            assertThat(history.getLast().toString()).contains("proof.txt");
            evidence("history-before-close", history);
            String completedTurn = jdbc.queryForObject("SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                    String.class, TENANT, session);
            AtomicReference<JsonNode> terminalEvent = new AtomicReference<>();
            AtomicReference<JsonNode> finalItems = new AtomicReference<>();
            // Item snapshots may lag committed events; compare their public watermarks before inspecting tools.
            await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(200)).untilAsserted(() -> {
                if (failure.get() != null) {
                    throw new IllegalStateException("Fixture protocol assertion failed", failure.get());
                }
                if (terminalEvent.get() == null) {
                    JsonNode events = publicRequest("GET", "/v1/agents/sessions/" + session + "/events?limit=100", null, null, "owner", 200);
                    assertThat(events.path("has_more").asBoolean()).isFalse();
                    assertThat(events.toString()).contains("G0_EXTERNAL_DONE");
                    List<JsonNode> completed = new ArrayList<>();
                    events.path("data").forEach(event -> {
                        if ("turn.completed".equals(event.path("type").asText())) {
                            completed.add(event);
                        }
                    });
                    assertThat(completed).hasSize(1);
                    assertThat(completed.getFirst().path("session_id").asText()).isEqualTo(session);
                    assertThat(completed.getFirst().path("turn_id").asText()).isEqualTo(completedTurn);
                    assertThat(completed.getFirst().path("sequence").asLong()).isPositive();
                    terminalEvent.set(completed.getFirst());
                }
                JsonNode snapshot = publicRequest("GET", "/v1/agents/sessions/" + session + "/items?limit=100", null, null, "owner", 200);
                assertThat(snapshot.path("snapshot_through_sequence").asLong())
                        .isGreaterThanOrEqualTo(terminalEvent.get().path("sequence").asLong());
                finalItems.set(snapshot);
            });
            JsonNode items = finalItems.get();
            assertThat(items.path("has_more").asBoolean()).isFalse();
            List<JsonNode> toolItems = new ArrayList<>();
            items.path("data").forEach(item -> {
                if ("tool_call".equals(item.path("type").asText())) {
                    toolItems.add(item);
                }
            });
            assertThat(toolItems).hasSize(4).allSatisfy(item -> assertThat(item.path("status").asText()).isEqualTo("completed"));
            var reads = toolItems.stream().filter(item -> "read_file".equals(item.at("/attributes/name").asText())).toList();
            assertThat(reads).hasSize(1);
            JsonNode detail = publicRequest("POST", "/api/agent/web-shell/v1/tool-details/get",
                    Map.of("sessionId", session, "itemId", reads.getFirst().path("id").asText()), null, "owner", 200);
            assertThat(detail.at("/input/file_path").asText()).isIn("proof.txt", mount.resolve("proof.txt").toString());
            assertThat(detail.path("output").asText()).contains("before");
            String closeRoute = "/v1/agents/sessions/" + session + "/close";
            String operation = publicRequest("POST", closeRoute, null, "close", "owner", 202).path("id").asText();
            awaitOperation(session, operation);
            var lifecycle = rows("SELECT lifecycle_protocol_version, lifecycle_effects_receipt_json FROM ma_operation WHERE operation_id = ?", operation).getFirst();
            assertThat(((Number) lifecycle.get("lifecycle_protocol_version")).intValue()).isEqualTo(1);
            JsonNode effects = json.readTree(lifecycle.get("lifecycle_effects_receipt_json").toString());
            assertThat(effects.path("operationId").asText()).isEqualTo(operation);
            assertThat(effects.at("/sessionKey/sessionId").asText()).isEqualTo(session);
            assertThat(effects.at("/sessionKey/tenantId").asText()).isEqualTo(TENANT);
            assertThat(effects.at("/sessionKey/workspaceId").asText()).isEqualTo(WORKSPACE);
            assertThat(effects.path("kind").asText()).isEqualTo("close");
            assertThat(effects.path("neverInitialized").asBoolean()).isFalse();
            assertThat(effects.path("effects").isArray()).isTrue();
            assertThat(effects.path("effects").isEmpty()).isTrue();
            boolean synthesized = effects.path("storeSynthesized").asBoolean();
            if (synthesized) {
                byte[] first = jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id = ?"
                        + " AND session_id = ? ORDER BY journal_revision LIMIT 1", byte[].class, TENANT, session);
                List<JsonNode> headers = new ArrayList<>();
                for (String line : new String(first, StandardCharsets.UTF_8).split("\n")) {
                    JsonNode record = json.readTree(line);
                    if ("managed_session_header_v1".equals(record.path("subtype").asText())) {
                        headers.add(record.path("managedSession"));
                    }
                }
                assertThat(headers).hasSize(1);
                assertThat(headers.getFirst().path("sessionKey")).isEqualTo(effects.path("sessionKey"));
                assertThat(headers.getFirst().path("definitionRef")).isEqualTo(effects.path("definitionRef"));
                JsonNode definition = spring.getBean(com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore.class)
                        .readRecordResource(TENANT, session, effects.path("definitionRef"));
                assertThat(definition.has("hookCatalog")).isFalse();
                assertThat(jdbc.queryForObject("SELECT tool_profile FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                        String.class, TENANT, session)).isEqualTo(PROFILE);
            }
            evidence("lifecycle-effects-source", Map.of("source", synthesized ? "store-journal" : "receipt-source-not-synthesized",
                    "receipt", effects));
            JsonNode drain = json.readTree(jdbc.queryForObject("SELECT drain_receipt_json FROM ma_runtime_binding WHERE binding_id = ?", String.class, bindingId));
            assertThat(drain.path("bindingId").asText()).isEqualTo(bindingId);
            assertThat(drain.path("generation").asLong()).isEqualTo(((Number) binding.get("runtime_generation")).longValue());
            assertThat(drain.path("provisionRequestId").asText()).isEqualTo(binding.get("provision_request_id"));
            assertThat(json.readTree(drain.path("handle").asText())).isEqualTo(json.readTree(binding.get("resource_handle_json").toString()));
            assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE session_id = ?", String.class, session)).isEqualTo("CLOSED");
            assertThat(jdbc.queryForObject("SELECT binding_state FROM ma_runtime_binding WHERE binding_id = ?", String.class, bindingId)).isEqualTo("RELEASED");
            assertThat(rows("SELECT session_state, execution_storage_key FROM ma_runtime_session")).isNotEmpty().allSatisfy(row -> {
                assertThat(row.get("session_state")).isIn("RELEASED", "FAILED");
                assertThat(row.get("execution_storage_key")).isNull();
            });
            var cleared = rows("SELECT holder_key, binding_id, runtime_generation, runtime_session_id FROM ma_storage_owner");
            assertThat(cleared).hasSize(1).allSatisfy(row -> assertThat(row.values()).containsOnlyNulls());
            assertThat(rows("SELECT tenant_id, storage_id, mount_revision, mount_root, physical_key, storage_kind FROM ma_storage_owner")).isEqualTo(ownerMetadata);
            assertThat(rows("SELECT storage_id, physical_key, registration_state, storage_kind, registration_revision, registration_json FROM ma_storage")).isEqualTo(storageBefore);
            assertThat(rows("SELECT actor_id, role FROM ma_workspace_access")).containsExactly(Map.of("actor_id", "owner", "role", "OWNER"));
            assertThat(rows("SELECT execution_call_id FROM ma_tool_execution WHERE settled_at IS NULL")).isEmpty();
            var heads = rows("SELECT head_kind, state, phase, writer_id, writer_lease_until FROM ma_session_head");
            assertThat(heads).isNotEmpty();
            assertThat(spring.getBean(com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore.class)
                    .hasLiveWriter(TENANT, session)).isFalse();
            // managedToolDigest is SHA-256 of sorted-key JSON; this input has only ASCII string leaves.
            var lateInput = new TreeMap<String, Object>(Map.of("file_path", "late.txt", "content", "must not be written"));
            var late = Map.of("protocolVersion", 2, "toolName", "write_file", "input", lateInput,
                    "reference", Map.of("sessionId", held.get("runtime_session_id"), "promptId", "late-prompt", "callId", "late-call",
                            "argsDigest", DigestUtils.sha256Hex(json.writeValueAsBytes(lateInput))));
            nativeRequest(ready.path("url").asText(), "/internal/managed-runtime/v2/execute", late, true, 401);
            JsonNode rejected = nativeRequest(ready.path("url").asText(), "/internal/managed-runtime/v2/execute", late, false, 409);
            assertThat(rejected.path("code").asText()).isEqualTo("managed_context_unavailable");
            assertThat(rejected.path("error").asText()).contains("closing");
            assertThat(Files.exists(mount.resolve("late.txt"))).isFalse();
            JsonNode proof = nativeRequest(ready.path("url").asText(), "/internal/managed-runtime/v2/publication:stop-drained",
                    Map.of("protocolVersion", 2, "channel", "all"), false, 200);
            assertThat(proof.path("state").asText()).isEqualTo("drained");
            assertThat(proof.at("/proof/kind").asText()).isEqualTo("external-publication");
            assertThat(proof.at("/proof/resourceId").asText()).isNotBlank();
            assertThat(proof.at("/proof/digest").asText()).isNotBlank();
            assertThat(proof.at("/proof/byteLength").asLong()).isPositive();
            assertThat(proof.path("receipts").isArray()).isTrue();
            assertThat(nativeRequest(ready.at("/publication/url").asText(), "/internal/managed-runtime/v2/publication:stop-drained",
                    Map.of("protocolVersion", 2, "channel", "all"), false, 200)).isEqualTo(proof);
            var turnsBeforeLate = rows("SELECT turn_id, status FROM ma_turn WHERE tenant_id = ? AND session_id = ? ORDER BY turn_id", TENANT, session);
            var toolsBeforeLate = rows("SELECT execution_call_id, execution_status FROM ma_tool_execution ORDER BY execution_call_id");
            int modelsBeforeLate = modelRequests.get();
            int allocationsBeforeLate = allocations;
            JsonNode latePublic = publicRequest("POST", "/v1/agents/sessions/" + session + "/events",
                    Map.of("type", "agent.session.input.message", "input", List.of(Map.of("type", "input_text", "text", "late"))),
                    "late", "owner", 409);
            assertThat(latePublic.at("/error/code").asText()).isEqualTo("workspace_unavailable");
            assertThat(latePublic.at("/error/message").asText()).isEqualTo("Hosted Workspace execution is not available.");
            assertThat(rows("SELECT turn_id, status FROM ma_turn WHERE tenant_id = ? AND session_id = ? ORDER BY turn_id", TENANT, session)).isEqualTo(turnsBeforeLate);
            assertThat(rows("SELECT execution_call_id, execution_status FROM ma_tool_execution ORDER BY execution_call_id")).isEqualTo(toolsBeforeLate);
            assertThat(modelRequests.get()).isEqualTo(modelsBeforeLate);
            assertThat(allocations).isEqualTo(allocationsBeforeLate);
            evidence("public-late-no-effects", Map.of("response", latePublic, "turns", turnsBeforeLate, "tools", toolsBeforeLate,
                    "modelRequests", modelsBeforeLate, "allocations", allocationsBeforeLate));
            assertThat(publicRequest("POST", closeRoute, null, "close", "owner", 202).path("id").asText()).isEqualTo(operation);
            assertThat(rows("SELECT resource_id, sha256, kind FROM ma_resource ORDER BY resource_id")).containsAll(retained);
            assertThat(history(session)).containsAll(history);
            assertThat(rows("SELECT execution_call_id FROM ma_tool_execution")).hasSize(4);
            assertThat(allocations).isEqualTo(1);
            assertThat(observations).isPositive();
            assertThat(worker.isAlive()).isTrue();
            assertThat(Files.readString(mount.resolve("proof.txt"))).isEqualTo("after");
            evidence("close", Map.of("effects", effects, "drain", drain, "native", proof, "owner", cleared, "heads", heads));
            evidence("summary", Map.of("session", session, "operation", operation, "tools", completedTools,
                    "modelRequests", modelRequests.get(), "allocations", allocations, "observations", observations,
                    "workerPid", worker.pid(), "lateStatus", 409, "approvedActions", answered.size()));
            checkFailure();
        } catch (Exception | AssertionError error) {
            problem = error;
            throw error;
        } finally {
            try {
                cleanup();
            } catch (Exception | AssertionError cleanupError) {
                if (problem == null) {
                    throw cleanupError;
                }
                problem.addSuppressed(cleanupError);
            }
        }
    }

    private void boot() throws Exception {
        assertThat(System.getProperty("os.name")).isEqualTo("Linux");
        String url = System.getProperty("mysql.url", "");
        assertThat(url).matches("jdbc:mysql://[^/?]+:[0-9]+/issue15512_b2_public_[a-z0-9_]+(?:\\?[^#]*)?");
        assertThat(System.getProperty("mysql.user")).isNotBlank();
        try (var connection = DriverManager.getConnection(url, System.getProperty("mysql.user"), System.getProperty("mysql.password", ""));
                var statement = connection.createStatement();
                var tables = statement.executeQuery("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")) {
            assertThat(connection.getMetaData().getDatabaseProductName()).isEqualTo("MySQL");
            assertThat(tables.next()).isTrue();
            assertThat(tables.getLong(1)).as("Fresh catalog; never reuse or truncate a previous attempt").isZero();
        }
        Path parent = Path.of(System.getProperty("qwen.external.public-files.tmp"));
        assertThat(parent.isAbsolute()).isTrue();
        temporary = Files.createTempDirectory(parent, "public-files-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"))).toRealPath();
        mount = directory("external");
        decoy = directory("decoy");
        control = directory("control");
        directory("broker");
        registration = json.valueToTree(Map.of("providerId", PROVIDER, "physicalKey", "public-files-physical",
                "aliasPath", "/issue15512/aliases/external-b2", "mountRoot", mount.toString(), "registrationRevision", 1));
        privateFile(control.resolve("registration.json"), registration.toString());
        rootStat = new LinkedHashMap<>(stat(mount));
        rootStat.remove("nlink");
        descriptorStat = stat(control.resolve("registration.json"));
        assertThat(((Number) rootStat.get("mode")).intValue() & 07777).isEqualTo(0700);
        assertThat(((Number) descriptorStat.get("mode")).intValue() & 07777).isEqualTo(0600);
        assertThat(descriptorStat.get("uid")).isEqualTo(rootStat.get("uid"));
        assertThat(((Number) descriptorStat.get("nlink")).intValue()).isEqualTo(1);
        descriptorHash = DigestUtils.sha256Hex(Files.readAllBytes(control.resolve("registration.json")));
        cli = Path.of(System.getProperty("qwen.cli.entry")).toRealPath();
        assertThat(cli).isRegularFile();
        node = System.getProperty("node.executable");
        assertThat(Path.of(node).isAbsolute()).isTrue();
        try (var main = new ServerSocket(); var publication = new ServerSocket()) {
            main.bind(new InetSocketAddress("0.0.0.0", 43190));
            publication.bind(new InetSocketAddress("0.0.0.0", 43191));
        }
        HttpServer model = server("/v1/chat/completions", this::modelReply);
        HttpServer adapter = server("/operator/", this::adapterReply);
        int harnessPort;
        int brokerPort;
        try (var service = socket(); var harnessSocket = socket(); var broker = socket()) {
            port = service.getLocalPort();
            harnessPort = harnessSocket.getLocalPort();
            brokerPort = broker.getLocalPort();
        }
        Map<String, Object> properties = new LinkedHashMap<>(Map.of("server.address", "127.0.0.1", "server.port", port,
                "spring.datasource.url", url, "spring.datasource.username", System.getProperty("mysql.user"),
                "spring.datasource.password", System.getProperty("mysql.password", ""), "spring.datasource.driver-class-name", "com.mysql.cj.jdbc.Driver",
                "spring.datasource.hikari.maximum-pool-size", 4));
        Map<String, Object> managed = new LinkedHashMap<>(Map.of("auth.mode", "open", "trusted-actor-header", "X-Issue15512-Actor",
                "session-store.enabled", true, "session-store.base-url", "http://127.0.0.1:" + port,
                "session-store.binding-key", UUID.randomUUID().toString() + UUID.randomUUID(), "internal-server.port", 0));
        managed.putAll(Map.of("harness.enabled", true, "harness.workspace-files-enabled", true, "harness.workspace-shell-enabled", false,
                "harness.workspace-child-agents-enabled", false, "harness.approval-mode", "default", "harness.base-url", "http://127.0.0.1:" + harnessPort,
                "harness.token", harnessToken, "harness.capability-digest", digest));
        managed.putAll(Map.of("runtime-broker.enabled", true, "runtime-broker.host", "127.0.0.1", "runtime-broker.port", brokerPort,
                "runtime-broker.token", brokerToken, "runtime-broker.provisioner", "external-workspace", "runtime-broker.isolation-class", "session",
                "runtime-broker.workspace-id", "unused-decoy", "runtime-broker.workspace-cwd", decoy.toString(),
                "runtime-broker.state-directory", temporary.resolve("broker").toString()));
        managed.putAll(Map.of("runtime-broker.durable-local-process", false, "runtime-broker.trusted-local-reboot-recovery", false,
                "runtime-broker.credential-key-id", "public-files", "runtime-broker.credential-key", randomKey(),
                "runtime-broker.external-provider-url", "http://127.0.0.1:" + adapter.getAddress().getPort() + "/operator/",
                "runtime-broker.external-provider-id", PROVIDER, "runtime-broker.external-provider-token", adapterToken,
                "runtime-broker.external-request-timeout", "10s", "runtime-broker.external-startup-timeout", "30s"));
        managed.putAll(Map.of("automation.enabled", false, "channels.enabled", false, "tool-publication.enabled", false));
        managed.forEach((key, value) -> properties.put("qwen.managed-agent." + key, value));
        spring = new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .initializers(context -> context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("public-files-fixture", properties))).run();
        jdbc = spring.getBean(JdbcTemplate.class);
        Path home = directory("home");
        Path config = Files.createDirectory(home.resolve(".qwen"), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        String modelUrl = "http://127.0.0.1:" + model.getAddress().getPort() + "/v1";
        privateFile(config.resolve("settings.json"), json.writeValueAsString(Map.of("security", Map.of("auth", Map.of("selectedType", "openai")),
                "model", Map.of("name", "issue15512-fixture"), "telemetry", Map.of("enabled", false),
                "modelProviders", Map.of("openai", List.of(Map.of("id", "issue15512-fixture", "envKey", "OPENAI_API_KEY", "baseUrl", modelUrl))))));
        ProcessBuilder builder = process("harness", decoy, "serve", "--profile", "hosted-harness", "--http-bridge", "--hostname", "127.0.0.1",
                "--port", Integer.toString(harnessPort), "--require-auth", "--no-web", "--workspace", decoy.toString(),
                "--managed-runtime-broker-url", "http://127.0.0.1:" + brokerPort);
        builder.environment().putAll(Map.of("HOME", home.toString(), "QWEN_HOME", config.toString(), "OPENAI_API_KEY", "local-fixture-only",
                "OPENAI_BASE_URL", modelUrl, "QWEN_SERVER_TOKEN", harnessToken, "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", digest,
                "QWEN_MANAGED_RUNTIME_BROKER_TOKEN", brokerToken, "QWEN_HOSTED_LIFECYCLE_V2_PROFILES", ""));
        harness = builder.start();
        await().atMost(Duration.ofSeconds(30)).ignoreExceptions().untilAsserted(() -> {
            assertThat(harness.isAlive()).as("Inspect private harness logs on startup failure").isTrue();
            JsonNode capabilities = request("GET", "http://127.0.0.1:" + harnessPort + "/capabilities", null, Map.of("Authorization", "Bearer " + harnessToken), 200);
            assertThat(capabilities.at("/hostedHarness/features").toString()).contains("\"" + PROFILE + "\"");
            assertThat(capabilities.at("/hostedHarness/lifecycleProtocolVersion").asInt()).isEqualTo(1);
        });
        evidence("runtime", Map.of("springPort", port, "harnessPort", harnessPort, "brokerPort", brokerPort,
                "adapterPort", adapter.getAddress().getPort(), "modelPort", model.getAddress().getPort(), "harnessPid", harness.pid(),
                "cliSha256", DigestUtils.sha256Hex(Files.readAllBytes(cli))));
    }

    private void answerActions(String session) throws Exception {
        for (JsonNode action : publicRequest("GET", "/v1/agents/sessions/" + session + "/actions", null, null, "owner", 200).path("data")) {
            String id = action.path("id").asText();
            if (answered.contains(id)) {
                continue;
            }
            if (answered.isEmpty()) {
                assertThat(Files.exists(mount.resolve("proof.txt"))).isFalse();
            }
            assertThat(action.path("state").asText()).isEqualTo("requested");
            assertThat(action.path("options").findValuesAsText("id")).contains("allow");
            String route = "/v1/agents/sessions/" + session + "/actions/" + id + "/responses";
            var response = Map.of("kind", "permission", "option_id", "allow", "input_revision", action.path("input_revision").asLong(),
                    "policy_revision", action.path("policy_revision").asText());
            publicRequest("POST", route, response, id, "outsider", 404);
            JsonNode accepted = publicRequest("POST", route, response, id, "owner", 202);
            assertThat(publicRequest("POST", route, response, id, "owner", 202).path("id")).isEqualTo(accepted.path("id"));
            awaitOperation(session, accepted.path("id").asText());
            assertThat(publicRequest("GET", "/v1/agents/sessions/" + session + "/operations/" + accepted.path("id").asText(),
                    null, null, "owner", 200).at("/action_resolution/outcome").asText()).isEqualTo("decided");
            answered.add(id);
        }
    }

    private void awaitOperation(String session, String operation) {
        await().atMost(Duration.ofSeconds(60)).untilAsserted(() -> {
            checkFailure();
            assertThat(publicRequest("GET", "/v1/agents/sessions/" + session + "/operations/" + operation, null, null, "owner", 200)
                    .path("status").asText()).isEqualTo("completed");
        });
    }

    private void modelReply(HttpExchange exchange) throws IOException {
        try (exchange) {
            JsonNode body = body(exchange, 1024 * 1024);
            int requestNumber = modelRequests.incrementAndGet();
            evidence("model-incoming-" + requestNumber, Map.of("messages", body.path("messages"), "tools", body.path("tools")));
            assertThat(exchange.getRequestMethod()).isEqualTo("POST");
            assertThat(requestNumber).isLessThanOrEqualTo(12);
            List<String> tools = new ArrayList<>();
            body.path("tools").forEach(tool -> tools.add(tool.at("/function/name").asText()));
            assertThat(tools).containsExactlyInAnyOrderElementsOf(TOOLS);
            Map<String, String> results = new LinkedHashMap<>();
            for (JsonNode message : body.path("messages")) {
                if ("tool".equals(message.path("role").asText())) {
                    String id = message.path("tool_call_id").asText();
                    assertThat(id).matches("external-tool-[0-3]");
                    JsonNode content = message.path("content");
                    String text;
                    if (content.isTextual()) {
                        text = content.textValue();
                    } else {
                        assertThat(content.isArray()).as("Tool content must be text or text parts").isTrue();
                        StringBuilder combined = new StringBuilder();
                        for (JsonNode part : content) {
                            assertThat(part.path("type").asText()).isEqualTo("text");
                            assertThat(part.path("text").isTextual()).isTrue();
                            combined.append(part.path("text").textValue());
                        }
                        text = combined.toString();
                    }
                    String previous = results.putIfAbsent(id, text);
                    assertThat(previous == null || previous.equals(text)).isTrue();
                }
            }
            int step = results.size();
            for (int i = 0; i < step; i++) {
                assertThat(results).containsKey("external-tool-" + i);
                String expected = switch (i) {
                    case 0 -> "Successfully";
                    case 1 -> "before";
                    case 2 -> "has been updated";
                    default -> "proof.txt";
                };
                assertThat(results.get("external-tool-" + i)).contains(expected);
            }
            completedTools = Math.max(completedTools, step);
            evidence("model-" + modelRequests.get(), Map.of("tools", tools, "results", results));
            var chunk = json.createObjectNode().put("id", "external").put("object", "chat.completion.chunk").put("created", 0).put("model", "issue15512-fixture");
            var choice = chunk.putArray("choices").addObject().put("index", 0);
            var delta = choice.putObject("delta").put("role", "assistant");
            if (step < 4) {
                Object args = switch (step) {
                    case 0 -> Map.of("file_path", "proof.txt", "content", "before");
                    case 1 -> Map.of("file_path", "proof.txt");
                    case 2 -> Map.of("file_path", "proof.txt", "old_string", "before", "new_string", "after");
                    default -> Map.of("pattern", "proof.txt");
                };
                delta.putArray("tool_calls").addObject().put("index", 0).put("id", "external-tool-" + step)
                        .put("type", "function").putObject("function").put("name", TOOLS.get(step)).put("arguments", json.writeValueAsString(args));
            } else {
                delta.put("content", "G0_EXTERNAL_DONE");
            }
            choice.putNull("finish_reason");
            String first = "data: " + chunk + "\n\n";
            choice.putObject("delta");
            choice.put("finish_reason", step < 4 ? "tool_calls" : "stop");
            byte[] response = (first + "data: " + chunk + "\n\ndata: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
        } catch (Exception | AssertionError error) {
            failure.compareAndSet(null, error);
        }
    }

    private synchronized void adapterReply(HttpExchange exchange) throws IOException {
        try (exchange) {
            assertThat(exchange.getRequestMethod()).isEqualTo("POST");
            assertThat(("Bearer " + adapterToken).equals(exchange.getRequestHeaders().getFirst("Authorization"))).isTrue();
            assertThat(exchange.getRequestHeaders().getFirst("Cache-Control")).isEqualTo("no-store");
            JsonNode incoming = body(exchange, 65536);
            assertThat(incoming.path("protocolVersion").asInt()).isEqualTo(1);
            boolean allocate = exchange.getRequestURI().getPath().equals("/operator/provision");
            Set<String> keys = new HashSet<>();
            incoming.fieldNames().forEachRemaining(keys::add);
            assertThat(keys).isEqualTo(allocate ? Set.of("protocolVersion", "provisionRequestId", "identity", "scope", "boot", "handle")
                    : Set.of("protocolVersion", "provisionRequestId", "identity", "handle"));
            if (allocate && provision == null) {
                JsonNode boot = incoming.path("boot");
                assertThat(boot.path("storage")).isEqualTo(((ObjectNode) registration.deepCopy()).remove(List.of("providerId")).put("kind", "external"));
                assertThat(boot.path("tenantId").asText()).isEqualTo(TENANT);
                assertThat(boot.path("workspaceId").asText()).isEqualTo(WORKSPACE);
                assertThat(boot.path("storageId").asText()).isEqualTo(WORKSPACE);
                assertThat(boot.path("workspaceGeneration").asText()).isEqualTo("1");
                assertThat(boot.path("mountRoot").asText()).isEqualTo(mount.toString());
                assertThat(boot.path("isolationClass").asText()).isEqualTo("session");
                assertThat(boot.path("capabilityDigest").asText()).isEqualTo(WorkspaceExecutionProfile.CAPABILITY_DIGEST);
                assertThat(boot.path("provisionRequestId")).isEqualTo(incoming.path("provisionRequestId"));
                provision = incoming.deepCopy();
                privateFile(control.resolve("boot.json"), boot.toString());
                worker = process("worker", mount, "managed-runtime-worker", "--container-boot", control.resolve("boot.json").toString()).start();
                allocations++;
                await().atMost(Duration.ofSeconds(30)).until(() -> {
                    assertThat(worker.isAlive()).as("Inspect private worker logs; boot admission failed").isTrue();
                    String output = Files.readString(temporary.resolve("worker.stdout"));
                    if (!output.contains("\n")) {
                        return false;
                    }
                    ready = json.readTree(output.lines().findFirst().orElseThrow());
                    return true;
                });
                assertThat(ready.path("type").asText()).isEqualTo("ready");
                assertThat(ready.path("version").asInt()).isEqualTo(2);
                assertThat(ready.path("managedContext").asText()).isEqualTo("managed-context/1");
                for (String key : List.of("runtimeInstanceId", "runtimeIncarnation", "leaseId", "epoch")) {
                    assertThat(ready.path(key)).isEqualTo(boot.path(key));
                }
                assertThat(ready.path("url").asText()).isEqualTo("http://127.0.0.1:43190");
                assertThat(ready.at("/publication/url").asText()).isEqualTo("http://127.0.0.1:43191");
                evidence("worker-ready", ready);
            }
            assertThat(provision).isNotNull();
            for (String key : List.of("provisionRequestId", "identity", "handle")) {
                assertThat(incoming.path(key)).isEqualTo(provision.path(key));
            }
            if (allocate) {
                assertThat(incoming.equals(provision)).as("Immutable allocation replay").isTrue();
            }
            verifyOriginal();
            Object response;
            if (allocate) {
                response = Map.of("protocolVersion", 1, "handle", provision.path("handle"), "endpoint", ready.path("url").asText());
            } else {
                observations++;
                String storageRef = DigestUtils.sha256Hex(json.writeValueAsBytes(new TreeMap<>(Map.of(
                        "physicalKey", registration.path("physicalKey").asText(), "providerId", PROVIDER, "registrationRevision", 1))));
                response = Map.of("protocolVersion", 1, "state", "RUNNING", "endpoint", ready.path("url").asText(),
                        "storage", Map.of("storageRef", storageRef, "mountRoot", mount.toString(), "continuity", "confirms"));
            }
            byte[] bytes = json.writeValueAsBytes(response);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
        } catch (Exception | AssertionError error) {
            failure.compareAndSet(null, error);
        }
    }

    private void verifyOriginal() throws Exception {
        assertThat(worker.isAlive()).isTrue();
        assertThat(mount.toRealPath()).isEqualTo(mount);
        var currentRoot = new LinkedHashMap<>(stat(mount));
        currentRoot.remove("nlink");
        assertThat(currentRoot).isEqualTo(rootStat);
        assertThat(stat(control.resolve("registration.json"))).isEqualTo(descriptorStat);
        assertThat(DigestUtils.sha256Hex(Files.readAllBytes(control.resolve("registration.json")))).isEqualTo(descriptorHash);
        ObjectNode expected = provision.path("boot").deepCopy();
        expected.remove(List.of("type", "version", "token", "storage"));
        expected.put("protocolVersion", 3);
        ObjectNode request = expected.deepCopy();
        request.remove(List.of("runtimeInstanceId", "runtimeIncarnation", "leaseId", "epoch"));
        assertThat(nativeRequest(ready.path("url").asText(), "/internal/managed-runtime/v3/attest", request, false, 200)).isEqualTo(expected);
    }

    private JsonNode nativeRequest(String origin, String path, Object body, boolean wrongToken, int status) throws Exception {
        JsonNode boot = provision.path("boot");
        return request("POST", origin + path, body, Map.of("Authorization", "Bearer " + (wrongToken ? "incorrect" : boot.path("token").asText()),
                "Cache-Control", "no-store", "X-Qwen-Managed-Lease-Id", boot.path("leaseId").asText(),
                "X-Qwen-Managed-Lease-Epoch", boot.path("epoch").asText(), "X-Qwen-Managed-Storage-Revision", "1",
                "X-Qwen-Managed-Runtime-Incarnation", boot.path("runtimeIncarnation").asText()), status);
    }

    private JsonNode publicRequest(String method, String path, Object body, String key, String actor, int status) throws Exception {
        Map<String, String> headers = new LinkedHashMap<>(Map.of("X-Qwen-Tenant-Id", TENANT));
        if (key != null) {
            headers.put("Idempotency-Key", key);
        }
        if ("operator".equals(actor)) {
            headers.put("Authorization", "Bearer " + brokerToken);
        } else if (actor != null) {
            headers.put("X-Issue15512-Actor", actor);
        }
        return request(method, "http://127.0.0.1:" + port + path, body, headers, status);
    }

    private JsonNode request(String method, String url, Object body, Map<String, String> headers, int status) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json").header("Accept", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        headers.forEach(builder::header);
        var pending = http.sendAsync(builder.build(), ignored -> boundedResponse());
        HttpResponse<byte[]> response;
        try {
            response = pending.get(10, TimeUnit.SECONDS);
        } finally {
            pending.cancel(true);
        }
        JsonNode parsed = response.body().length == 0 ? json.nullNode() : json.readTree(response.body());
        if (temporary != null) {
            evidence("http-" + requests.incrementAndGet(), Map.of("method", method, "path", URI.create(url).getPath(),
                    "status", response.statusCode(), "body", parsed));
        }
        assertThat(response.statusCode()).as("%s %s; see retained HTTP response", method, URI.create(url).getPath()).isEqualTo(status);
        return parsed;
    }

    private static HttpResponse.BodySubscriber<byte[]> boundedResponse() {
        return new HttpResponse.BodySubscriber<>() {
            private final HttpResponse.BodySubscriber<byte[]> delegate = HttpResponse.BodySubscribers.ofByteArray();
            private java.util.concurrent.Flow.Subscription subscription;
            private long received;
            @Override
            public java.util.concurrent.CompletionStage<byte[]> getBody() { return delegate.getBody(); }
            @Override
            public void onSubscribe(java.util.concurrent.Flow.Subscription value) {
                subscription = value;
                delegate.onSubscribe(value);
            }
            @Override
            public void onNext(List<java.nio.ByteBuffer> buffers) {
                for (var buffer : buffers) {
                    received += buffer.remaining();
                }
                if (received > 1024 * 1024) {
                    subscription.cancel();
                    delegate.onError(new IOException("Fixture HTTP response exceeds 1 MiB"));
                } else {
                    delegate.onNext(buffers);
                }
            }
            @Override
            public void onError(Throwable error) { delegate.onError(error); }
            @Override
            public void onComplete() { delegate.onComplete(); }
        };
    }

    private List<JsonNode> history(String session) throws IOException {
        String scope = com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore.sessionScopeKey(TENANT, session);
        List<JsonNode> history = new ArrayList<>();
        for (byte[] transaction : jdbc.queryForList("SELECT record_bytes FROM ma_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? AND operation = 'commitFileHistory' ORDER BY journal_revision",
                byte[].class, TENANT, session)) {
            for (String line : new String(transaction, StandardCharsets.UTF_8).split("\n")) {
                JsonNode event = json.readTree(line).path("managedSession");
                if (!"domain.committed".equals(event.path("kind").asText())
                        || !"file_history".equals(event.at("/payload/domain").asText())) {
                    continue;
                }
                JsonNode ref = event.at("/payload/recordRef");
                assertThat(ref.path("kind").asText()).isEqualTo("managed-file_history");
                var resources = jdbc.queryForList("SELECT inline_bytes, sha256, byte_length, schema_version FROM ma_resource"
                        + " WHERE session_scope_key = ? AND resource_id = ? AND tenant_id = ? AND session_id = ?"
                        + " AND kind = 'managed-file_history'", scope, ref.path("resourceId").asText(), TENANT, session);
                assertThat(resources).hasSize(1);
                var resource = resources.getFirst();
                byte[] bytes = (byte[]) resource.get("inline_bytes");
                assertThat(bytes).isNotNull();
                assertThat(DigestUtils.sha256Hex(bytes)).isEqualTo(resource.get("sha256")).isEqualTo(ref.path("digest").asText());
                assertThat((long) bytes.length).isEqualTo(((Number) resource.get("byte_length")).longValue())
                        .isEqualTo(ref.path("byteLength").asLong());
                assertThat(((Number) resource.get("schema_version")).intValue()).isEqualTo(ref.path("schemaVersion").asInt());
                history.add(json.valueToTree(Map.of("ref", ref, "content", json.readTree(bytes))));
            }
        }
        return history;
    }

    private List<Map<String, Object>> rows(String sql, Object... args) {
        var result = jdbc.queryForList(sql, args);
        result.forEach(row -> row.replaceAll((key, value) -> value instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8) : value));
        return result;
    }

    private HttpServer server(String path, com.sun.net.httpserver.HttpHandler handler) throws IOException {
        var executor = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16));
        executors.add(executor);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        servers.add(server);
        server.setExecutor(executor);
        server.createContext(path, handler);
        server.start();
        return server;
    }

    private JsonNode body(HttpExchange exchange, int limit) throws IOException {
        var timeout = deadlines.schedule(exchange::close, 10, TimeUnit.SECONDS);
        try {
            byte[] bytes = exchange.getRequestBody().readNBytes(limit + 1);
            assertThat(bytes.length).isLessThanOrEqualTo(limit);
            return json.readTree(bytes);
        } finally {
            timeout.cancel(false);
        }
    }

    private Path directory(String name) throws IOException {
        return Files.createDirectory(temporary.resolve(name), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    }

    private void privateFile(Path file, String content) throws IOException {
        Files.createFile(file, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(file, content);
    }

    private void evidence(String name, Object value) throws IOException {
        String encoded = json.writeValueAsString(value);
        for (String token : List.of(harnessToken, brokerToken, adapterToken)) {
            encoded = encoded.replace(token, "[REDACTED]");
        }
        if (provision != null) {
            encoded = encoded.replace(provision.at("/boot/token").asText(), "[REDACTED]");
        }
        privateFile(temporary.resolve(name + ".sanitized.json"), encoded);
    }

    private Map<String, Object> stat(Path file) throws IOException {
        return Files.readAttributes(file, "unix:ino,dev,uid,mode,nlink", LinkOption.NOFOLLOW_LINKS);
    }

    private ProcessBuilder process(String name, Path cwd, String... arguments) throws IOException {
        List<String> command = new ArrayList<>(List.of(node, cli.toString()));
        command.addAll(List.of(arguments));
        Path stdout = temporary.resolve(name + ".stdout");
        Path stderr = temporary.resolve(name + ".stderr");
        privateFile(stdout, "");
        privateFile(stderr, "");
        var builder = new ProcessBuilder(command).directory(cwd.toFile()).redirectOutput(stdout.toFile()).redirectError(stderr.toFile());
        var environment = builder.environment();
        environment.clear();
        environment.put("PATH", System.getenv("PATH"));
        environment.put("HOME", temporary.toString());
        environment.put("QWEN_RUNTIME_DIR", directory(name + "-runtime").toString());
        environment.put("TMPDIR", temporary.toString());
        for (String setting : List.of("QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH", "QWEN_CODE_TRUSTED_FOLDERS_PATH")) {
            environment.put(setting, temporary.resolve(setting + ".json").toString());
        }
        return builder;
    }

    private static ServerSocket socket() throws IOException {
        return new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
    }

    private static String randomKey() {
        byte[] bytes = new byte[32];
        new java.security.SecureRandom().nextBytes(bytes);
        return Base64.getEncoder().encodeToString(bytes);
    }

    private void checkFailure() {
        if (failure.get() != null) {
            throw new AssertionError("Fixture protocol assertion failed", failure.get());
        }
    }

    private void cleanup() throws Exception {
        boolean interrupted = Thread.interrupted();
        servers.forEach(server -> server.stop(0));
        deadlines.shutdownNow();
        executors.forEach(ExecutorService::shutdownNow);
        List<ProcessHandle> owned = new ArrayList<>();
        for (Process process : new Process[] {harness, worker}) {
            if (process != null) {
                owned.addAll(process.descendants().toList());
                owned.add(process.toHandle());
            }
        }
        owned.forEach(ProcessHandle::destroy);
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        for (ProcessHandle process : owned) {
            if (process.isAlive() && System.nanoTime() < deadline) {
                try {
                    process.onExit().get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                } catch (java.util.concurrent.TimeoutException ignored) {
                    break;
                } catch (InterruptedException ignored) {
                    interrupted = true;
                    break;
                }
            }
        }
        owned.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
        var closer = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "external-public-files-cleanup");
            thread.setDaemon(true);
            return thread;
        });
        try {
            closer.submit(() -> {
                if (spring != null) {
                    spring.close();
                }
            }).get(10, TimeUnit.SECONDS);
        } finally {
            closer.shutdownNow();
            http.shutdownNow();
            try {
                for (ProcessHandle process : owned) {
                    if (process.isAlive()) {
                        process.onExit().get(3, TimeUnit.SECONDS);
                    }
                }
                for (ExecutorService executor : executors) {
                    assertThat(executor.awaitTermination(3, TimeUnit.SECONDS)).isTrue();
                }
                assertThat(deadlines.awaitTermination(3, TimeUnit.SECONDS)).isTrue();
            } finally {
                if (interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }
        assertThat(owned).allSatisfy(process -> assertThat(process.isAlive()).isFalse());
    }
}
