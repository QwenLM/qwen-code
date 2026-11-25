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
