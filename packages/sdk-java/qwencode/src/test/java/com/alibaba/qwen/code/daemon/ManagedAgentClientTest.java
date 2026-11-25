package com.alibaba.qwen.code.daemon;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpServer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedAgentClientTest {
    private static final byte[] SIGNING_KEY = "managed-test-key".getBytes(StandardCharsets.UTF_8);
    private static final String SESSIONS = "/gateway/v1/agents/sessions";
    private static final String SESSION = SESSIONS + "/session";

    @Test
    void typedCreationDistinguishesOmittedFieldsFromExplicitSelections() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String session = "{\"id\":\"session\",\"agent_id\":\"qwen-code\",\"agent_revision\":\"r1\","
                    + "\"status\":\"active\",\"metadata\":{\"title\":\"Review\"},\"workspace\":{"
                    + "\"workspace_id\":\"work\",\"cwd_relative\":\"src\",\"context_revision\":3,\"state\":\"ready\"}}";
            fixture.json(202, session);
            fixture.json(202, session);
            fixture.json(200, "{\"data\":[" + session + "],\"has_more\":true,\"next_cursor\":\"next+\"}");
            fixture.json(200, "{\"id\":\"work\",\"state\":\"active\",\"can_create_session\":true}");
            ManagedAgentClient client = fixture.client();
            ManagedCreateSessionRequest.Builder builder = ManagedCreateSessionRequest.builder("qwen-code");
            ManagedCreateSessionRequest minimal = builder.build();
            ManagedCreateSessionRequest selected = builder.agentRevision("r1").workspace("work", "src").title("Review")
                    .input(List.of(ManagedInput.text("hi"), ManagedInput.file("a.txt", "text/plain", "a"),
                            ManagedInput.image("image/png", new byte[]{1, 2})))
                    .skills(List.of(new ManagedCreateSessionRequest.Skill("check", "Check", "Read changes", ".", true, false)))
                    .extensionPins(List.of()).worktree().memoryStoreId("memory")
                    .modelConfig(new ManagedCreateSessionRequest.ModelConfig(ManagedCreateSessionRequest.ModelProtocol.OPENAI,
                            "test-model", "https://model.example.test", "fixture-key",
                            new ManagedCreateSessionRequest.GenerationConfig(null, null, 8, 64, null, null, -1)))
                    .build();
            client.sessions().create(minimal, "minimal");
            ManagedSession created = client.sessions().create(selected, "selected");
            assertEquals("session", created.getId());
            assertEquals(ManagedSession.Status.ACTIVE, created.getStatus());
            assertEquals("Review", created.getTitle());
            assertEquals("src", created.getWorkspace().getCwdRelative());
            assertEquals(3, created.getWorkspace().getContextRevision());
            assertNull(created.getActiveTurn());
            ManagedPage<ManagedSession> page = client.sessions().list("cursor", 10, ManagedSessions.ArchiveFilter.UNARCHIVED, "Review");
            assertEquals(created.getId(), page.getEntries().get(0).getId());
            assertEquals("next+", page.getNextCursor());
            assertTrue(page.hasMore());
            assertTrue(client.workspaces().get("work").canCreateSession());

            assertEquals(Map.of("agent_id", "qwen-code"), fixture.request(0, "POST", SESSIONS, "minimal").json());
            assertEquals(Map.of("agent_id", "qwen-code", "agent_revision", "r1",
                    "workspace", Map.of("workspace_id", "work", "cwd_relative", "src"),
                    "metadata", Map.of("title", "Review"), "input", List.of(
                            Map.of("type", "input_text", "text", "hi"),
                            Map.of("type", "input_file", "name", "a.txt", "mime_type", "text/plain", "text", "a"),
                            Map.of("type", "input_image", "mime_type", "image/png", "data", "AQI=")),
                    "skills", List.of(Map.of("name", "check", "description", "Check", "body", "Read changes",
                            "base_directory", ".", "model_invocable", true, "user_invocable", false)),
                    "extensionPins", List.of(), "worktree", Map.of(), "memory_store_id", "memory",
                    "model_config", Map.of("protocol", "openai", "model", "test-model",
                            "base_url", "https://model.example.test", "api_key", "fixture-key",
                            "generation_config", Map.of("top_k", 8, "max_tokens", 64, "seed", -1))),
                    fixture.request(1, "POST", SESSIONS, "selected").json());
            fixture.request(2, "GET", SESSIONS + "?cursor=cursor&limit=10&archive_state=unarchived&title_query=Review", null);
            fixture.request(3, "GET", "/gateway/v1/agents/workspaces/work", null);
        }
    }

    @Test
    void typedTurnReceiptAndEventsExposeExecutionWithoutJsonCasts() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.json(202, "{\"session_id\":\"session\",\"turn_id\":\"turn\",\"status\":\"accepted\","
                    + "\"operation_id\":\"submit\",\"replayed\":false,\"admission_stage\":\"java_durable\","
                    + "\"delivery_state\":\"pending\"}");
            fixture.sse("id: 1\nevent: item.output_text.delta\ndata: {\"session_id\":\"session\",\"turn_id\":\"turn\","
                    + "\"data\":{\"text\":\"你好\"},\"terminal\":false}\n\n"
                    + "id: 2\nevent: turn.completed\ndata: {\"turn_id\":\"turn\",\"terminal\":true}\n\n"
                    + "event: agent.session.resync_required\ndata: {\"snapshot_through_sequence\":5,"
                    + "\"replay_floor_sequence\":4}\n\n");
            fixture.json(200, "{\"data\":[],\"has_more\":false,\"snapshot_through_sequence\":6}");
            fixture.sse("id: 7\nevent: future.event\ndata: {\"terminal\":false}\n\n");
            fixture.json(200, "{\"id\":\"turn\",\"session_id\":\"session\",\"status\":\"future_status\"}");
            ManagedSessions sessions = fixture.client().sessions();
            ManagedTurnAdmission receipt = sessions.submitText("session", "hi", "message");
            assertEquals("turn", receipt.getTurnId());
            assertEquals("submit", receipt.getOperationId());
            assertEquals("pending", receipt.getDeliveryState());
            assertFalse(receipt.isReplayed());
            try (ManagedAgentEventStream stream = sessions.streamEvents("session")) {
                ManagedAgentEventStream.Event delta = stream.next();
                assertEquals(receipt.getTurnId(), delta.getTurnId());
                assertEquals("你好", delta.getOutputTextDelta());
                assertFalse(delta.isTerminal());
                assertTrue(stream.next().isTerminal());
                ManagedAgentEventStream.Event resync = stream.next();
                assertTrue(resync.isResyncRequired());
                assertFalse(resync.isTerminal());
                assertEquals(4L, resync.getReplayFloorSequence());
                assertEquals(2, stream.getLastEventId());
            }
            ManagedSessions.ItemPage items = sessions.listItems("session", null, 20);
            assertEquals(6, items.getSnapshotThroughSequence());
            try (ManagedAgentEventStream stream = sessions.streamEvents("session", items.getSnapshotThroughSequence())) {
                assertEquals("future.event", stream.next().getType());
            }
            ManagedTurn turn = sessions.getTurn("session", receipt.getTurnId());
            assertEquals(ManagedTurn.Status.UNKNOWN, turn.getStatus());
            assertEquals("future_status", turn.getStatusCode());
            assertEquals(Map.of("type", "agent.session.input.message", "input",
                    List.of(Map.of("type", "input_text", "text", "hi"))),
                    fixture.request(0, "POST", SESSION + "/events", "message").json());
            assertEquals("0", fixture.request(1, "GET", SESSION + "/events", null).headers.getFirst("Last-Event-ID"));
            fixture.request(2, "GET", SESSION + "/items?limit=20", null);
            assertEquals("6", fixture.request(3, "GET", SESSION + "/events", null).headers.getFirst("Last-Event-ID"));
            fixture.request(4, "GET", SESSION + "/turns/turn", null);
        }
    }

    @Test
    void typedExtensionPublicationRoundTripsTheSettledPin(@TempDir Path directory) throws Exception {
        Path source = Files.writeString(directory.resolve("skill.md"), "fixture");
        String digest = hex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(source)));
        String publishDigest = "a".repeat(64);
        String barePin = "{\"extensionId\":\"ext\",\"packageRevision\":4,\"packageDigest\":\"" + publishDigest + "\"}";
        String selectedPin = barePin.substring(0, barePin.length() - 1) + ",\"settingsRevision\":2}";
        try (Fixture fixture = new Fixture()) {
            fixture.json(200, "{\"operationId\":\"publish\",\"extensionId\":\"ext\",\"kind\":\"publish\","
                    + "\"state\":\"settled\",\"revision\":4,\"packageDigest\":\"" + publishDigest + "\"}");
            fixture.json(200, "{\"pin\":" + barePin + ",\"manifest\":{},\"byteLength\":10}");
            fixture.json(200, "{\"settingsRevision\":1,\"configuredKeys\":[\"API_KEY\"]}");
            fixture.json(200, "{\"operationId\":\"settings\",\"extensionId\":\"ext\",\"kind\":\"settings\","
                    + "\"state\":\"settled\",\"revision\":2,\"packageDigest\":null}");
            String applying = "{\"sessionId\":\"session\",\"revision\":3,\"supported\":true,\"extensions\":[],"
                    + "\"requestedExtensions\":[" + selectedPin + "],\"operation\":{\"operationId\":\"apply\","
                    + "\"state\":\"pending\",\"mode\":\"apply\",\"revision\":3}}";
            fixture.json(200, applying);
            fixture.json(200, applying);
            ManagedExtensionPackages packages = fixture.client().extensionPackages();
            var options = new ManagedExtensionPackages.ImportOptions(ManagedExtensionPackages.SourceKind.SKILL,
                    ManagedExtensionPackages.Platform.LINUX, ManagedExtensionPackages.Architecture.ANY, "example");
            ManagedExtensionPackages.Publication publication = packages.importPackage("work", source, options, "publish-key");
            assertEquals("publish", publication.getOperationId());
            assertTrue(publication.isSettled());
            ManagedExtensionPin published = packages.getPublishedPin("work", publication);
            assertNull(published.getSettingsRevision());
            assertEquals(publishDigest, published.getPackageDigest());
            var settings = packages.getSettings("work", published.getExtensionId());
            assertEquals(List.of("API_KEY"), settings.getConfiguredKeys());
            var update = packages.saveSettings("work", published.getExtensionId(), settings.getRevision(),
                    Map.of("API_KEY", "fixture-value"), "settings-key");
            assertEquals("settled", update.getState());
            var pinWithSettings = published.withSettingsRevision(update.getRevision());
            assertEquals(2L, pinWithSettings.getSettingsRevision());
            ManagedExtensionPackages.Configuration configuration = packages.apply("session", 2, List.of(pinWithSettings), "apply-key");
            assertEquals("apply", configuration.getOperation().getId());
            assertTrue(configuration.getExtensions().isEmpty());
            assertEquals(4, configuration.getRequestedExtensions().get(0).getPackageRevision());
            assertEquals("apply", packages.lookupConfigurationOperation("session", "apply-key").getOperation().getId());

            String workspaceExtensions = "/gateway/v1/agents/workspaces/work/extensions";
            String uri = fixture.requests.get(0).uri.toString();
            Request upload = fixture.request(0, "POST", uri, "publish-key");
            assertEquals(workspaceExtensions + "/imports", upload.uri.getPath());
            assertEquals("fixture", new String(upload.body, StandardCharsets.UTF_8));
            assertEquals(Map.of("sourceKind", "skill", "target", Map.of("platform", "linux", "arch", "any"),
                    "sourceDigest", digest, "compilerVersion", 1, "packageName", "example"),
                    JsonSupport.parseObject(upload.uri.getQuery().substring("metadata=".length()), "import metadata"));
            fixture.request(1, "GET", workspaceExtensions + "/ext/packages/4?packageDigest=" + publishDigest, null);
            fixture.request(2, "GET", workspaceExtensions + "/ext/settings", null);
            assertEquals(Map.of("expectedRevision", 1, "values", Map.of("API_KEY", "fixture-value")),
                    fixture.request(3, "POST", workspaceExtensions + "/ext/settings", "settings-key").json());
            assertEquals(Map.of("expectedConfigRevision", 2, "extensions", List.of(JsonSupport.parseObject(selectedPin, "pin"))),
                    fixture.request(4, "POST", SESSION + "/extensions", "apply-key").json());
            assertEquals(Map.of("idempotencyKey", "apply-key"),
                    fixture.request(5, "POST", SESSION + "/extensions/operations/lookup", null).json());
        }
    }

    @Test
    void typedActionUsesServerRevisionsAndCatalogsExposeTypedEntries() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.json(200, "{\"id\":\"approval\",\"session_id\":\"session\",\"kind\":\"permission\","
                    + "\"input_revision\":2,\"policy_revision\":\"r1\",\"options\":[{\"id\":\"allow_once\",\"label\":\"Allow once\"}]}");
            fixture.json(202, "{\"id\":\"operation\",\"type\":\"action_response\",\"status\":\"pending\"}");
            fixture.json(200, "{\"session_id\":\"session\",\"catalogs\":[{\"catalog_id\":\"catalog\",\"catalog_revision\":3,"
                    + "\"hooks\":[{\"hook_id\":\"hook\",\"event_name\":\"SessionStart\",\"type\":\"command\",\"once\":true}]}]}");
            fixture.json(200, "{\"session_id\":\"session\",\"servers\":[{\"server_id\":\"mcp\",\"server_revision\":2,"
                    + "\"tools\":[{\"name\":\"example_tool\",\"input_schema\":{\"type\":\"object\"}}],"
                    + "\"resources\":[],\"prompts\":[{\"name\":\"example_prompt\"}]}]}");
            ManagedSessions sessions = fixture.client().sessions();
            ManagedAction action = sessions.getAction("session", "approval");
            assertEquals("Allow once", action.getOptions().get(0).getLabel());
            assertThrows(IllegalArgumentException.class,
                    () -> sessions.answerQuestions(action, List.of(new ManagedAction.Answer("q", null, "answer")), "wrong-kind"));
            assertEquals("operation", sessions.decidePermission(action, action.getOptions().get(0).getId(), "decision").getId());
            assertTrue(sessions.getHookCatalog("session").getCatalogs().get(0).getHooks().get(0).isOnce());
            ManagedMcpCatalog.Server mcp = sessions.getMcpCatalog("session").getServers().get(0);
            assertEquals("example_tool", mcp.getTools().get(0).getName());
            assertTrue(mcp.getPrompts().get(0).getArguments().isEmpty());

            fixture.request(0, "GET", SESSION + "/actions/approval", null);
            assertEquals(Map.of("kind", "permission", "option_id", "allow_once", "input_revision", 2, "policy_revision", "r1"),
                    fixture.request(1, "POST", SESSION + "/actions/approval/responses", "decision").json());
            fixture.request(2, "GET", SESSION + "/hook-catalog", null);
            fixture.request(3, "GET", SESSION + "/mcp-catalog", null);
        }
    }

    @Test
    void createsWithFullAssetSelectionAndListsWithEncodedFilters() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.json(202, "{\"id\":\"session\"}");
            fixture.json(200, "{\"data\":[],\"has_more\":true,\"next_cursor\":\"next\"}");
            fixture.json(200, "{\"extensions\":[]}");
            ManagedAgentClient client = fixture.client("/gateway/路由");
            String body = "x".repeat(400_000);
            List<Map<String, String>> skills = List.of(
                    Map.of("name", "one", "description", "First", "body", body),
                    Map.of("name", "two", "description", "Second", "body", body),
                    Map.of("name", "three", "description", "Third", "body", body));
            var selection = Map.of("agent_id", "qwen-code", "workspace", Map.of("workspace_id", "workspace"),
                    "skills", skills, "extensionPins", List.of());
            assertEquals("session", client.createSession(selection, "create-key").get("id"));
            assertEquals("next", client.listSessions("next+/=", 40, "unarchived", "研发 & +")
                    .get("next_cursor"));
            client.extensions().catalog("workspace");

            String prefix = "/gateway/%E8%B7%AF%E7%94%B1/v1/agents";
            Request create = fixture.request(0, "POST", prefix + "/sessions", "create-key");
            assertTrue(create.body.length > 1024 * 1024);
            assertEquals(selection, create.json());
            fixture.request(1, "GET", prefix + "/sessions"
                    + "?cursor=next%2B%2F%3D&limit=40&archive_state=unarchived&title_query=%E7%A0%94%E5%8F%91%20%26%20%2B",
                    null);
            fixture.request(2, "GET", prefix + "/workspaces/workspace/extensions", null);
        }
    }

    @Test
    void preservesCommandFieldsAndUsesTheExpectedStatusForEachOperation() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.json(202, "{\"turn_id\":\"turn\",\"operation_id\":\"submit\",\"replayed\":true}");
            fixture.json(202, "{\"turn_id\":\"turn\",\"operation_id\":\"cancel\"}");
            fixture.json(202, "{\"id\":\"approval\",\"status\":\"queued\"}");
            fixture.json(202, "{\"state\":\"waiting\",\"turnId\":\"turn\",\"nextTurnAllowed\":false}");
            fixture.json(202, "{\"id\":\"close\"}");
            fixture.json(200, "{\"id\":\"close\",\"status\":\"completed\"}");
            fixture.json(200, "{\"sessionId\":\"session\",\"revision\":2,\"supported\":true,"
                    + "\"servers\":[],\"availableServers\":[]}");
            ManagedAgentClient client = fixture.client();
            var command = Map.of("action", "disable", "serverId", "mcp-server", "expectedRevision", 1);
            var response = Map.of("kind", "permission", "input_revision", 2, "policy_revision", "hosted-tool-approval/1",
                    "option_id", "allow_once");
            assertEquals(true, client.submitText("session", "hello", "message-key").get("replayed"));
            assertEquals("cancel", client.cancelTurn("session", "turn", "cancel-key").get("operation_id"));
            assertEquals("approval", client.respondToAction("session", "approval", response, "approval-key").get("id"));
            assertEquals("turn", client.recheckRecovery("session", "turn").get("turnId"));
            assertEquals("close", client.closeSession("session", "close-key").get("id"));
            assertEquals("completed", client.getSessionOperation("session", "close").get("status"));
            assertEquals("session", client.submitMcpManagement("session", command, "mcp-key").get("sessionId"));

            assertEquals(Map.of("type", "agent.session.input.message", "input",
                    List.of(Map.of("type", "input_text", "text", "hello"))),
                    fixture.request(0, "POST", SESSION + "/events", "message-key").json());
            assertEquals(Map.of("type", "agent.session.cancel", "turn_id", "turn"),
                    fixture.request(1, "POST", SESSION + "/events", "cancel-key").json());
            assertEquals(response, fixture.request(2, "POST", SESSION + "/actions/approval/responses", "approval-key").json());
            assertEquals(Map.of("turnId", "turn"),
                    fixture.request(3, "POST", SESSION + "/recovery/recheck", null).json());
            assertEquals(0, fixture.request(4, "POST", SESSION + "/close", "close-key").body.length);
            fixture.request(5, "GET", SESSION + "/operations/close", null);
            assertEquals(command, fixture.request(6, "POST", SESSION + "/mcp-management/commands", "mcp-key").json());
        }
    }

    @Test
    void consumesEventsAndReconnectsWithoutAdvancingPastResync() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.sse(":keepalive\n\nid: 8\nevent: agent.item.updated\ndata: {\"sequence\":8,\n"
                    + "data: \"type\":\"agent.item.updated\"}\n\n"
                    + "event: agent.session.resync_required\ndata: {\"snapshot_through_sequence\":12}\n\n");
            fixture.json(200, "{\"data\":[],\"snapshot_through_sequence\":13}");
            fixture.sse("id: 15\nevent: turn.completed\ndata: {\"sequence\":15}\n\n"
                    + "id: 14\nevent: agent.item.updated\ndata: {\"sequence\":14}\n\n");
            ManagedAgentClient client = fixture.client();
            try (ManagedAgentEventStream stream = client.streamEvents("session", 7)) {
                assertEquals(7, stream.getLastEventId());
                ManagedAgentEventStream.Event event = stream.next();
                assertEquals("agent.item.updated", event.getType());
                assertEquals(8L, event.getId());
                assertEquals(8, ((Number) event.getPayload().get("sequence")).intValue());
                assertFalse(event.isResyncRequired());
                ManagedAgentEventStream.Event resync = stream.next();
                assertTrue(resync.isResyncRequired());
                assertNull(resync.getId());
                assertEquals(8, stream.getLastEventId());
                assertNull(stream.next());
            }
            long snapshotSequence = ((Number) client.listItems("session", null, null, null)
                    .get("snapshot_through_sequence")).longValue();
            try (ManagedAgentEventStream stream = client.streamEvents("session", snapshotSequence)) {
                assertEquals(15L, stream.next().getId());
                assertThrows(DaemonProtocolException.class, stream::next);
                assertEquals(15, stream.getLastEventId());
            }
            Request first = fixture.request(0, "GET", SESSION + "/events", null);
            assertEquals("text/event-stream", first.headers.getFirst("Accept"));
            assertEquals("7", first.headers.getFirst("Last-Event-ID"));
            fixture.request(1, "GET", SESSION + "/items", null);
            assertEquals("13", fixture.request(2, "GET", SESSION + "/events", null).headers.getFirst("Last-Event-ID"));
        }
    }

    @Test
    void closingTheStreamDiscardsBufferedEvents() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.sse("id: 1\nevent: turn.started\ndata: {\"sequence\":1}\n\n"
                    + "id: 2\nevent: turn.completed\ndata: {\"sequence\":2}\n\n");
            try (ManagedAgentEventStream stream = fixture.client().streamEvents("session", 0)) {
                assertEquals(1L, stream.next().getId());
                stream.close();
                assertThrows(DaemonTransportException.class, stream::next);
                assertEquals(1, stream.getLastEventId());
            }
        }
    }

    @Test
    void surfacesHttpFailuresAndDoesNotRetryOrFollowRedirects() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.json(409, "{\"error\":{\"code\":\"cursor_expired\",\"request_id\":\"request-1\"}}");
            fixture.json(401, "{\"error\":{\"code\":\"invalid_signature\"}}");
            fixture.json(503, "{\"error\":{\"code\":\"delivery_unavailable\"}}");
            fixture.replies.add(new Reply(307, "application/json", "{}", SESSION));
            fixture.json(200, "{}");
            ManagedAgentClient client = fixture.client();
            DaemonHttpException expired = assertThrows(DaemonHttpException.class,
                    () -> client.listEvents("session", 5L, 10));
            assertEquals(409, expired.getStatusCode());
            assertEquals("cursor_expired", expired.getErrorCode());
            assertEquals("request-1", expired.getBodyField("request_id"));
            DaemonHttpException unauthorized = assertThrows(DaemonHttpException.class,
                    () -> client.streamEvents("session", 5));
            assertEquals(401, unauthorized.getStatusCode());
            assertEquals("invalid_signature", unauthorized.getErrorCode());
            DaemonHttpException unavailable = assertThrows(DaemonHttpException.class,
                    () -> client.submitText("session", "hello", "message-key"));
            assertEquals(503, unavailable.getStatusCode());
            assertEquals("delivery_unavailable", unavailable.getErrorCode());
            assertEquals(307, assertThrows(DaemonHttpException.class,
                    () -> client.cancelTurn("session", "turn", "cancel-key")).getStatusCode());
            assertThrows(DaemonProtocolException.class, () -> client.streamEvents("session", 5));
            assertEquals(5, fixture.requests.size());
        }
    }

    private static final class Fixture implements AutoCloseable {
        final HttpServer server;
        final Queue<Reply> replies = new ConcurrentLinkedQueue<>();
        final List<Request> requests = new CopyOnWriteArrayList<>();

        Fixture() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                try {
                    requests.add(new Request(exchange.getRequestMethod(), exchange.getRequestURI(),
                            exchange.getRequestHeaders(), exchange.getRequestBody().readAllBytes()));
                    Reply reply = replies.poll();
                    if (reply == null) {
                        exchange.sendResponseHeaders(500, -1);
                        return;
                    }
                    exchange.getResponseHeaders().set("Content-Type", reply.type);
                    if (reply.location != null) {
                        exchange.getResponseHeaders().set("Location", reply.location);
                    }
                    exchange.sendResponseHeaders(reply.status, reply.body.length);
                    exchange.getResponseBody().write(reply.body);
                } finally {
                    exchange.close();
                }
            });
            server.start();
        }

        ManagedAgentClient client() {
            return client("/gateway");
        }

        ManagedAgentClient client(String basePath) {
            return new ManagedAgentClient(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + basePath),
                    "tenant", "actor", SIGNING_KEY);
        }

        void json(int status, String body) {
            replies.add(new Reply(status, "application/json", body, null));
        }

        void sse(String body) {
            replies.add(new Reply(200, "text/event-stream; charset=utf-8", body, null));
        }

        Request request(int index, String method, String route, String key) throws GeneralSecurityException {
            Request request = requests.get(index);
            assertEquals(method, request.method);
            assertEquals(route, request.uri.toString());
            assertEquals(key, request.headers.getFirst("Idempotency-Key"));
            assertEquals("tenant", request.headers.getFirst("X-Qwen-Tenant-Id"));
            assertEquals("actor", request.headers.getFirst("X-Qwen-Actor-Id"));
            String digest = hex(MessageDigest.getInstance("SHA-256").digest(request.body));
            String query = request.uri.getRawQuery();
            String expected = String.join("\n", "qwen-broker-auth-v1", method, request.uri.getRawPath(),
                    query == null ? "" : query, "tenant", "actor",
                    request.headers.getFirst("X-Qwen-Signature-Timestamp"), digest, key == null ? "" : key);
            Mac hmac = Mac.getInstance("HmacSHA256");
            hmac.init(new SecretKeySpec(SIGNING_KEY, "HmacSHA256"));
            assertEquals("v1=" + hex(hmac.doFinal(expected.getBytes(StandardCharsets.UTF_8))),
                    request.headers.getFirst("X-Qwen-Signature"));
            return request;
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }

    private static String hex(byte[] bytes) {
        return String.format("%064x", new java.math.BigInteger(1, bytes));
    }

    private static final class Request {
        final String method;
        final URI uri;
        final Headers headers;
        final byte[] body;

        Request(String method, URI uri, Headers headers, byte[] body) {
            this.method = method;
            this.uri = uri;
            this.headers = headers;
            this.body = body;
        }

        Map<String, Object> json() {
            return JsonSupport.parseObject(new String(body, StandardCharsets.UTF_8), "test request");
        }
    }

    private static final class Reply {
        final int status;
        final String type;
        final byte[] body;
        final String location;

        Reply(int status, String type, String body, String location) {
            this.status = status;
            this.type = type;
            this.body = body.getBytes(StandardCharsets.UTF_8);
            this.location = location;
        }
    }
}
