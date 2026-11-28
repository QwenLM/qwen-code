package com.alibaba.qwen.code.daemon;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpServer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;

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
    void savesAndReadsTypedAgentDefinitionRevisions() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String digest = "a".repeat(64);
            String revision = "{\"id\":\"agent\",\"object\":\"agent\",\"revision\":\"2\",\"created_at\":12,"
                    + "\"digest\":\"" + digest + "\",\"metadata\":{\"labels\":[\"demo\"],\"owner\":{\"id\":99}}}";
            fixture.json(202, revision);
            fixture.json(202, revision);
            fixture.json(200, revision);
            ManagedAgentClient client = fixture.client();
            var initial = ManagedAgentDefinitionRequest.builder("Start").build();
            var update = ManagedAgentDefinitionRequest.builder("Updated")
                    .model(new ManagedAgentDefinitionRequest.ModelReference("model"))
                    .hostedToolProfile(ManagedAgentDefinitionRequest.HostedToolProfile.SHELL)
                    .approvalPolicy(ManagedAgentDefinitionRequest.ApprovalPolicy.AUTO_EDIT)
                    .skills(List.of(new ManagedAgentDefinitionRequest.StaticSkill("review", "Review", "Review changes", ".")))
                    .mcpServers(List.of(new ManagedMcpServerPin("search", 2, digest)))
                    .hookCatalog(new ManagedAgentDefinitionRequest.HookCatalogPin("hooks", 3, digest))
                    .environmentTemplateId("template")
                    .metadata(Map.of("labels", List.of("demo"), "owner", Map.of("id", 99)))
                    .build();
            assertEquals("agent", client.createAgent(initial, "create-agent").getId());
            ManagedAgentDefinition saved = client.updateAgent("agent", update, "update-agent");
            assertEquals("2", saved.getRevision());
            assertEquals("agent", saved.getObject());
            assertEquals(digest, saved.getDigest());
            assertEquals(12, saved.getCreatedAt());
            assertEquals(Map.of("labels", List.of("demo"), "owner", Map.of("id", 99)), saved.getMetadata());
            assertEquals(digest, client.getAgent("agent", "2").getDigest());

            String path = "/gateway/v1/agents";
            assertEquals(Map.of("model", Map.of(), "instructions", "Start", "tools", List.of(), "permission_policy", Map.of()),
                    fixture.request(0, "POST", path, "create-agent").json());
            assertEquals(Map.of("model", Map.of("id", "model"), "instructions", "Updated",
                            "tools", List.of(Map.of("type", "hosted_profile", "profile", "hosted-workspace-shell/1")),
                            "permission_policy", Map.of("approval_mode", "auto-edit"),
                            "skills", List.of(Map.of("name", "review", "description", "Review", "body", "Review changes",
                                    "base_directory", ".")),
                            "mcp_servers", List.of(Map.of("server_id", "search", "server_revision", 2, "definition_digest", digest)),
                            "hook_catalog", Map.of("catalog_id", "hooks", "catalog_revision", 3, "definition_digest", digest),
                            "environment_template_id", "template", "metadata", saved.getMetadata()),
                    fixture.request(1, "POST", path + "/agent", "update-agent").json());
            fixture.request(2, "GET", path + "/agent?revision=2", null);
        }
    }

    @Test
    void readsTypedWorkspaceAndSessionPagesAndPreservesOmittedPins() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String workspace = "{\"id\":\"work\",\"object\":\"agent.workspace\",\"display_name\":\"Work\","
                    + "\"state\":\"active\",\"can_create_session\":true}";
            String session = "{\"id\":\"session\",\"agent_id\":\"qwen-code\",\"agent_revision\":\"r1\","
                    + "\"status\":\"active\",\"metadata\":{\"title\":\"Review\"},\"workspace\":{"
                    + "\"workspace_id\":\"work\",\"cwd_relative\":\"src\",\"context_revision\":3,\"state\":\"ready\"}}";
            fixture.json(200, "{\"object\":\"list\",\"data\":[" + workspace + "],\"has_more\":false,"
                    + "\"default_workspace\":" + workspace + ",\"capabilities\":{\"workspace_context\":true,\"workspace_binding\":true}}");
            fixture.json(202, session);
            fixture.json(200, "{\"data\":[" + session + "],\"has_more\":true,\"next_cursor\":\"next+\"}");
            ManagedAgentClient client = fixture.client();
            ManagedWorkspace.Page workspaces = client.listWorkspaces(null, 20);
            assertTrue(workspaces.supportsWorkspaceBinding());
            assertTrue(workspaces.getDefaultWorkspace().canCreateSession());
            assertEquals("work", workspaces.getEntries().get(0).getId());
            var request = ManagedCreateSessionRequest.builder("qwen-code").workspace("work", "src")
                    .title("Review").input(List.of(ManagedInput.text("hi"))).build();
            ManagedSession created = client.createSession(request, "create");
            assertEquals(ManagedSession.Status.ACTIVE, created.getStatus());
            assertEquals("Review", created.getTitle());
            assertEquals("src", created.getWorkspace().getCwdRelative());
            assertEquals(3, created.getWorkspace().getContextRevision());
            assertNull(created.getActiveTurn());
            ManagedPage<ManagedSession> page = client.listSessions(null, 10, "unarchived", "Review");
            assertEquals("session", page.getEntries().get(0).getId());
            assertEquals("next+", page.getNextCursor());
            assertTrue(page.hasMore());

            fixture.request(0, "GET", "/gateway/v1/agents/workspaces?limit=20", null);
            assertEquals(Map.of("agent_id", "qwen-code", "workspace", Map.of("workspace_id", "work", "cwd_relative", "src"),
                            "metadata", Map.of("title", "Review"), "input", List.of(Map.of("type", "input_text", "text", "hi"))),
                    fixture.request(1, "POST", SESSIONS, "create").json());
            fixture.request(2, "GET", SESSIONS + "?limit=10&archive_state=unarchived&title_query=Review", null);
        }
    }

    @Test
    void exposesMcpToolSchemaAndUsesThePublishedPinInCommands() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String digest = "b".repeat(64);
            String pin = "\"serverId\":\"search\",\"serverRevision\":2,\"definitionDigest\":\"" + digest + "\"";
            fixture.json(200, "{\"session_id\":\"session\",\"servers\":[{\"server_id\":\"search\",\"server_revision\":2,"
                    + "\"tools\":[{\"name\":\"search\",\"input_schema\":{\"type\":\"object\",\"description\":\"Query parameters\","
                    + "\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"],\"additionalProperties\":false}}],"
                    + "\"resources\":[],\"prompts\":[],\"discovery\":{\"tools\":\"complete\",\"resources\":\"complete\","
                    + "\"prompts\":\"complete\"}}]}");
            fixture.json(200, "{\"sessionId\":\"session\",\"revision\":1,\"supported\":true,\"servers\":[],"
                    + "\"availableServers\":[{" + pin + ",\"transport\":\"stdio\"}]}");
            String snapshot = "{\"sessionId\":\"session\",\"revision\":2,\"supported\":true,\"availableServers\":[],"
                    + "\"servers\":[{" + pin + ",\"state\":\"enabled\"}],\"operation\":{\"operationId\":\"mcp-add\","
                    + "\"action\":\"add\",\"serverId\":\"search\",\"revision\":2,\"state\":\"settled\"}}";
            fixture.json(200, snapshot);
            fixture.json(200, snapshot);
            ManagedAgentClient client = fixture.client();
            ManagedMcpCatalog.Server catalog = client.getMcpCatalog("session").getServers().get(0);
            assertEquals("complete", catalog.getDiscovery().getTools());
            ManagedJsonSchema schema = catalog.getTools().get(0).getInputSchema();
            assertEquals(List.of("object"), schema.getTypes());
            assertEquals("Query parameters", schema.getDescription());
            assertEquals(Map.of("query", Map.of("type", "string")), schema.getProperties());
            assertEquals(List.of("query"), schema.getRequired());
            assertEquals(false, schema.asJson().get("additionalProperties"));
            ManagedMcpManagementSnapshot prior = client.getMcpManagement("session");
            var command = new ManagedMcpManagementCommand(ManagedMcpManagementCommand.Action.ADD, "search",
                    prior.getRevision(), prior.getAvailableServers().get(0).getPin());
            ManagedMcpManagementSnapshot applied = client.submitMcpManagement("session", command, "mcp-key");
            assertEquals("enabled", applied.getServers().get(0).getState());
            assertEquals("settled", client.getMcpManagementOperation("session", applied.getOperation().getOperationId())
                    .getOperation().getState());

            fixture.request(0, "GET", SESSION + "/mcp-catalog", null);
            fixture.request(1, "GET", SESSION + "/mcp-management", null);
            assertEquals(Map.of("action", "add", "serverId", "search", "expectedRevision", 1,
                            "server", Map.of("serverId", "search", "serverRevision", 2, "definitionDigest", digest)),
                    fixture.request(2, "POST", SESSION + "/mcp-management/commands", "mcp-key").json());
            fixture.request(3, "GET", SESSION + "/mcp-management/commands/mcp-add", null);
        }
    }

    @Test
    void readsTypedEventsAndReplaysFromTheirSequence() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String delta = "{\"sequence\":3,\"event_id\":\"opaque\",\"session_id\":\"session\",\"turn_id\":\"turn\","
                    + "\"type\":\"item.output_text.delta\",\"data\":{\"text\":\"你好\"},\"terminal\":false}";
            fixture.json(200, "{\"object\":\"list\",\"data\":[" + delta + "],\"has_more\":true,\"next_cursor\":\"3\"}");
            fixture.sse("id: 4\nevent: turn.failed\ndata: {\"session_id\":\"session\",\"turn_id\":\"turn\","
                    + "\"terminal\":true,\"data\":{\"code\":\"failed\",\"message\":\"Fixture\"}}\n\n");
            ManagedAgentClient client = fixture.client();
            ManagedEventPage page = client.listEvents("session", 2L, 1);
            ManagedAgentEventStream.Event event = page.getEntries().get(0);
            assertEquals("turn", event.getTurnId());
            assertEquals("opaque", event.getEventId());
            assertEquals(3L, event.getSequence());
            assertEquals("你好", event.getOutputTextDelta());
            assertEquals(3L, page.getNextSequence());
            try (ManagedAgentEventStream stream = client.streamEvents("session", page.getNextSequence())) {
                ManagedAgentEventStream.Event terminal = stream.next();
                assertTrue(terminal.isTerminal());
                assertEquals("failed", ((ManagedAgentEventStream.TurnFailed) terminal.getPayload()).getCode());
            }
            fixture.request(0, "GET", SESSION + "/events?after=2&limit=1", null);
            assertEquals("3", fixture.request(1, "GET", SESSION + "/events", null).headers.getFirst("Last-Event-ID"));
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
            var request = ManagedCreateSessionRequest.builder("qwen-code").workspace("workspace")
                    .skills(List.of(new ManagedCreateSessionRequest.Skill("one", "First", body),
                            new ManagedCreateSessionRequest.Skill("two", "Second", body),
                            new ManagedCreateSessionRequest.Skill("three", "Third", body)))
                    .extensionPins(List.of()).build();
            assertEquals("session", client.createSession(request, "create-key").getId());
            assertEquals("next", client.listSessions("next+/=", 40, "unarchived", "研发 & +")
                    .getNextCursor());
            client.extensions().catalog("workspace");

            String prefix = "/gateway/%E8%B7%AF%E7%94%B1/v1/agents";
            Request create = fixture.request(0, "POST", prefix + "/sessions", "create-key");
            assertTrue(create.body.length > 1024 * 1024);
            assertEquals(Map.of("agent_id", "qwen-code", "workspace", Map.of("workspace_id", "workspace"),
                    "skills", skills, "extensionPins", List.of()), create.json());
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
            var command = new ManagedMcpManagementCommand(ManagedMcpManagementCommand.Action.DISABLE, "mcp-server", 1);
            var response = ManagedActionResponse.permission(2, "hosted-tool-approval/1", "allow_once");
            assertTrue(client.submitText("session", "hello", "message-key").isReplayed());
            assertEquals("cancel", client.cancelTurn("session", "turn", "cancel-key").getOperationId());
            assertEquals("approval", client.respondToAction("session", "approval", response, "approval-key").getId());
            assertEquals("turn", client.recheckRecovery("session", "turn").getTurnId());
            assertEquals("close", client.closeSession("session", "close-key").getId());
            assertEquals("completed", client.getSessionOperation("session", "close").getStatus());
            assertEquals("session", client.submitMcpManagement("session", command, "mcp-key").getSessionId());

            assertEquals(Map.of("type", "agent.session.input.message", "input",
                    List.of(Map.of("type", "input_text", "text", "hello"))),
                    fixture.request(0, "POST", SESSION + "/events", "message-key").json());
            assertEquals(Map.of("type", "agent.session.cancel", "turn_id", "turn"),
                    fixture.request(1, "POST", SESSION + "/events", "cancel-key").json());
            assertEquals(Map.of("kind", "permission", "input_revision", 2, "policy_revision", "hosted-tool-approval/1",
                            "option_id", "allow_once"),
                    fixture.request(2, "POST", SESSION + "/actions/approval/responses", "approval-key").json());
            assertEquals(Map.of("turnId", "turn"),
                    fixture.request(3, "POST", SESSION + "/recovery/recheck", null).json());
            assertEquals(0, fixture.request(4, "POST", SESSION + "/close", "close-key").body.length);
            fixture.request(5, "GET", SESSION + "/operations/close", null);
            assertEquals(Map.of("action", "disable", "serverId", "mcp-server", "expectedRevision", 1),
                    fixture.request(6, "POST", SESSION + "/mcp-management/commands", "mcp-key").json());
        }
    }

    @Test
    void sendsTextAndOptionQuestionAnswersWithTheActionRevisions() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.json(202, "{\"id\":\"respond\",\"type\":\"action_response\",\"status\":\"pending\"}");
            ManagedActionResponse response = ManagedActionResponse.question(3, "policy", List.of(
                    new ManagedAction.Answer("text-question", List.of(), "Free-form answer"),
                    new ManagedAction.Answer("choice-question", List.of("option"), null)));
            assertEquals("respond", fixture.client().respondToAction("session", "action", response, "key").getId());
            assertEquals(Map.of("kind", "question", "input_revision", 3, "policy_revision", "policy",
                            "answers", List.of(Map.of("question_id", "text-question", "text", "Free-form answer"),
                                    Map.of("question_id", "choice-question", "option_ids", List.of("option")))),
                    fixture.request(0, "POST", SESSION + "/actions/action/responses", "key").json());
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
                assertEquals(8L, event.getSequence());
                assertFalse(event.isResyncRequired());
                ManagedAgentEventStream.Event resync = stream.next();
                assertTrue(resync.isResyncRequired());
                assertNull(resync.getId());
                assertEquals(8, stream.getLastEventId());
                assertNull(stream.next());
            }
            long snapshotSequence = client.listItems("session", null, null, null).getSnapshotThroughSequence();
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
