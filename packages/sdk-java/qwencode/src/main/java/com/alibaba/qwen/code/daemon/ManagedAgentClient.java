package com.alibaba.qwen.code.daemon;

import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.encode;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.hex;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.identity;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.sha256;

/**
 * Signed client for the standalone Managed Agent Server's public API.
 * Use {@link #sessions()}, {@link #workspaces()} and {@link #extensionPackages()} for typed operations.
 * The Map methods use the field names in the public OpenAPI contract.
 * Write methods take caller-owned idempotency keys and never replay a mutation.
 */
public final class ManagedAgentClient {
    private static final String API = "v1/agents";
    private static final String SESSIONS = API + "/sessions";
    private static final String WORKSPACES = API + "/workspaces";
    private static final int MAXIMUM_JSON_BYTES = 8 * 1024 * 1024;

    private final ManagedHttpTransport transport;
    private final ManagedExtensionsClient extensions;
    private final ManagedSessions sessions;
    private final ManagedWorkspaces workspaces;
    private final ManagedExtensionPackages extensionPackages;

    public ManagedAgentClient(URI baseUri, String tenantId, String actorId, byte[] signingKey) {
        this.transport = new ManagedHttpTransport(baseUri, tenantId, actorId, signingKey);
        this.extensions = new ManagedExtensionsClient(transport);
        this.sessions = new ManagedSessions(this);
        this.workspaces = new ManagedWorkspaces(this);
        this.extensionPackages = new ManagedExtensionPackages(extensions);
    }

    public ManagedSessions sessions() {
        return sessions;
    }

    public ManagedWorkspaces workspaces() {
        return workspaces;
    }

    public ManagedExtensionPackages extensionPackages() {
        return extensionPackages;
    }

    /** Uses the same endpoint and credentials for package publication and session configuration. */
    public ManagedExtensionsClient extensions() {
        return extensions;
    }

    public Map<String, Object> createAgent(Map<String, ?> definition, String idempotencyKey) {
        return write("POST", API, definition, idempotencyKey, 202);
    }

    public Map<String, Object> getAgent(String agentId, String revision) {
        return get(query(API + "/" + segment(agentId), "revision", revision));
    }

    public Map<String, Object> updateAgent(String agentId, Map<String, ?> definition, String idempotencyKey) {
        return write("POST", API + "/" + segment(agentId), definition, idempotencyKey, 202);
    }

    public Map<String, Object> listWorkspaces(String cursor, Integer limit) {
        return get(page(WORKSPACES, cursor, limit));
    }

    public Map<String, Object> getWorkspace(String workspaceId) {
        return get(WORKSPACES + "/" + segment(workspaceId));
    }

    /** Admits a session with the supplied workspace, skills and extension pins. */
    public Map<String, Object> createSession(Map<String, ?> selection, String idempotencyKey) {
        return write("POST", SESSIONS, selection, idempotencyKey, 202);
    }

    /** Null filters use the server defaults. Use next_cursor from a page to continue. */
    public Map<String, Object> listSessions(String cursor, Integer limit, String archiveState, String titleQuery) {
        String route = query(page(SESSIONS, cursor, limit), "archive_state", archiveState);
        return get(query(route, "title_query", titleQuery));
    }

    public Map<String, Object> getSession(String sessionId) {
        return get(session(sessionId));
    }

    public Map<String, Object> renameSession(String sessionId, String title, String idempotencyKey) {
        return write("PATCH", session(sessionId), Map.of("title", title), idempotencyKey, 200);
    }

    public Map<String, Object> closeSession(String sessionId, String idempotencyKey) {
        return write("POST", session(sessionId) + "/close", null, idempotencyKey, 202);
    }

    public Map<String, Object> archiveSession(String sessionId, String idempotencyKey) {
        return write("POST", session(sessionId) + "/archive", null, idempotencyKey, 202);
    }

    public Map<String, Object> unarchiveSession(String sessionId, String idempotencyKey) {
        return write("POST", session(sessionId) + "/unarchive", null, idempotencyKey, 200);
    }

    public Map<String, Object> deleteSession(String sessionId, String idempotencyKey) {
        return write("DELETE", session(sessionId), null, idempotencyKey, 202);
    }

    public Map<String, Object> getSessionOperation(String sessionId, String operationId) {
        return get(session(sessionId) + "/operations/" + segment(operationId));
    }

    /** Submits public input blocks and returns the admission receipt. */
    public Map<String, Object> submitTurn(String sessionId, List<? extends Map<String, ?>> input,
            String idempotencyKey) {
        return write("POST", session(sessionId) + "/events",
                Map.of("type", "agent.session.input.message", "input", input), idempotencyKey, 202);
    }

    public Map<String, Object> submitText(String sessionId, String text, String idempotencyKey) {
        return submitTurn(sessionId, List.of(Map.of("type", "input_text", "text", text)), idempotencyKey);
    }

    public Map<String, Object> cancelTurn(String sessionId, String turnId, String idempotencyKey) {
        return write("POST", session(sessionId) + "/events",
                Map.of("type", "agent.session.cancel", "turn_id", turnId), idempotencyKey, 202);
    }

    public Map<String, Object> listTurns(String sessionId, String cursor, Integer limit) {
        return get(page(session(sessionId) + "/turns", cursor, limit));
    }

    public Map<String, Object> getTurn(String sessionId, String turnId) {
        return get(session(sessionId) + "/turns/" + segment(turnId));
    }

    public Map<String, Object> listItems(String sessionId, Long after, String cursor, Integer limit) {
        return get(query(page(session(sessionId) + "/items", cursor, limit), "after", after));
    }

    public Map<String, Object> listEvents(String sessionId, Long after, Integer limit) {
        String route = query(session(sessionId) + "/events", "after", after);
        return get(query(route, "limit", limit));
    }

    /**
     * Opens a stream after the given sequence. Close the stream when finished.
     * After a resync event, page through Items and reopen at their snapshot sequence.
     */
    public ManagedAgentEventStream streamEvents(String sessionId, long after) {
        if (after < 0) {
            throw new IllegalArgumentException("The event cursor must be nonnegative");
        }
        HttpRequest request = transport.signedRequest("GET", session(sessionId) + "/events",
                hex(sha256().digest()), null)
                .timeout(Duration.ofSeconds(30)).header("Accept", "text/event-stream")
                .header("Last-Event-ID", Long.toString(after)).GET().build();
        return new ManagedAgentEventStream(transport.openEventStream(request), after);
    }

    public Map<String, Object> listActions(String sessionId, String cursor, Integer limit, Boolean includeChildren) {
        return get(query(page(session(sessionId) + "/actions", cursor, limit), "include_children", includeChildren));
    }

    public Map<String, Object> getAction(String sessionId, String actionId) {
        return get(session(sessionId) + "/actions/" + segment(actionId));
    }

    public Map<String, Object> respondToAction(String sessionId, String actionId, Map<String, ?> response,
            String idempotencyKey) {
        return write("POST", session(sessionId) + "/actions/" + segment(actionId) + "/responses",
                response, idempotencyKey, 202);
    }

    public Map<String, Object> getRecovery(String sessionId) {
        return get(session(sessionId) + "/recovery");
    }

    public Map<String, Object> recheckRecovery(String sessionId, String turnId) {
        return json("POST", session(sessionId) + "/recovery/recheck", Map.of("turnId", turnId), null, 202);
    }

    public Map<String, Object> getResources(String sessionId) {
        return get(session(sessionId) + "/resources");
    }

    public Map<String, Object> getHookCatalog(String sessionId) {
        return get(session(sessionId) + "/hook-catalog");
    }

    public Map<String, Object> getMcpCatalog(String sessionId) {
        return get(session(sessionId) + "/mcp-catalog");
    }

    public Map<String, Object> getMcpManagement(String sessionId) {
        return get(session(sessionId) + "/mcp-management");
    }

    public Map<String, Object> submitMcpManagement(String sessionId, Map<String, ?> command, String idempotencyKey) {
        return write("POST", session(sessionId) + "/mcp-management/commands", command, idempotencyKey, 200);
    }

    public Map<String, Object> getMcpManagementOperation(String sessionId, String operationId) {
        return get(session(sessionId) + "/mcp-management/commands/" + segment(operationId));
    }

    private Map<String, Object> get(String route) {
        return json("GET", route, null, null, 200);
    }

    private Map<String, Object> write(String method, String route, Map<String, ?> body, String key, int status) {
        return json(method, route, body, identity(key), status);
    }

    private Map<String, Object> json(String method, String route, Map<String, ?> body, String key, int status) {
        byte[] bytes = body == null ? new byte[0] : JsonSupport.encode(body).getBytes(StandardCharsets.UTF_8);
        HttpRequest.Builder request = transport.signedRequest(method, route, hex(sha256().digest(bytes)), key)
                .timeout(Duration.ofSeconds(30)).header("Accept", "application/json");
        if (body != null) {
            request.header("Content-Type", "application/json; charset=utf-8");
        }
        HttpRequest.BodyPublisher publisher = body == null
                ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(bytes);
        return transport.sendJson(request.method(method, publisher).build(), status, MAXIMUM_JSON_BYTES,
                method + " Managed API");
    }

    private static String session(String id) {
        return SESSIONS + "/" + segment(id);
    }

    private static String segment(String value) {
        if (".".equals(value) || "..".equals(value)) {
            throw new IllegalArgumentException("Invalid Managed path segment");
        }
        return encode(identity(value));
    }

    private static String page(String route, String cursor, Integer limit) {
        return query(query(route, "cursor", cursor), "limit", limit);
    }

    private static String query(String route, String name, Object value) {
        return value == null ? route : route + (route.contains("?") ? "&" : "?") + name + "=" + encode(value.toString());
    }
}
