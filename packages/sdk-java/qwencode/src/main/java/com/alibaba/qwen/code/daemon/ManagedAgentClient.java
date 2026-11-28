package com.alibaba.qwen.code.daemon;

import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.encode;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.hex;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.identity;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.sha256;

/**
 * Signed client for the standalone Managed Agent Server's public API.
 * Structured requests and responses follow the public OpenAPI contract.
 * Write methods take caller-owned idempotency keys and never replay a mutation.
 */
public final class ManagedAgentClient {
    private static final String API = "v1/agents";
    private static final String SESSIONS = API + "/sessions";
    private static final String WORKSPACES = API + "/workspaces";
    private static final int MAXIMUM_JSON_BYTES = 8 * 1024 * 1024;

    private final ManagedHttpTransport transport;
    private final ManagedExtensionsClient extensions;

    public ManagedAgentClient(URI baseUri, String tenantId, String actorId, byte[] signingKey) {
        this.transport = new ManagedHttpTransport(baseUri, tenantId, actorId, signingKey);
        this.extensions = new ManagedExtensionsClient(transport);
    }

    /** Uses the same endpoint and credentials for package publication and session configuration. */
    public ManagedExtensionsClient extensions() {
        return extensions;
    }

    public ManagedAgentDefinition createAgent(ManagedAgentDefinitionRequest definition, String idempotencyKey) {
        return new ManagedAgentDefinition(write("POST", API, definition.toJson(), idempotencyKey, 202));
    }

    public ManagedAgentDefinition getAgent(String agentId, String revision) {
        return new ManagedAgentDefinition(get(query(API + "/" + segment(agentId), "revision", revision)));
    }

    public ManagedAgentDefinition updateAgent(String agentId, ManagedAgentDefinitionRequest definition, String idempotencyKey) {
        return new ManagedAgentDefinition(write("POST", API + "/" + segment(agentId), definition.toJson(), idempotencyKey, 202));
    }

    public ManagedWorkspace.Page listWorkspaces(String cursor, Integer limit) {
        return new ManagedWorkspace.Page(get(page(WORKSPACES, cursor, limit)));
    }

    public ManagedWorkspace getWorkspace(String workspaceId) {
        return new ManagedWorkspace(get(WORKSPACES + "/" + segment(workspaceId)));
    }

    /** Admits a session with the supplied workspace, skills and extension pins. */
    public ManagedSession createSession(ManagedCreateSessionRequest request, String idempotencyKey) {
        return new ManagedSession(write("POST", SESSIONS, request.toJson(), idempotencyKey, 202));
    }

    /** Use null filters for server defaults. Archive state accepts all, archived or unarchived. */
    public ManagedPage<ManagedSession> listSessions(String cursor, Integer limit, String archiveState, String titleQuery) {
        String route = query(page(SESSIONS, cursor, limit), "archive_state", archiveState);
        return new ManagedPage<>(get(query(route, "title_query", titleQuery)), ManagedSession::new);
    }

    public ManagedSession getSession(String sessionId) {
        return new ManagedSession(get(session(sessionId)));
    }

    public ManagedSession renameSession(String sessionId, String title, String idempotencyKey) {
        return new ManagedSession(write("PATCH", session(sessionId), Map.of("title", title), idempotencyKey, 200));
    }

    public ManagedOperation closeSession(String sessionId, String idempotencyKey) {
        return new ManagedOperation(write("POST", session(sessionId) + "/close", null, idempotencyKey, 202));
    }

    public ManagedOperation archiveSession(String sessionId, String idempotencyKey) {
        return new ManagedOperation(write("POST", session(sessionId) + "/archive", null, idempotencyKey, 202));
    }

    public ManagedSession unarchiveSession(String sessionId, String idempotencyKey) {
        return new ManagedSession(write("POST", session(sessionId) + "/unarchive", null, idempotencyKey, 200));
    }

    public ManagedOperation deleteSession(String sessionId, String idempotencyKey) {
        return new ManagedOperation(write("DELETE", session(sessionId), null, idempotencyKey, 202));
    }

    public ManagedOperation getSessionOperation(String sessionId, String operationId) {
        return new ManagedOperation(get(session(sessionId) + "/operations/" + segment(operationId)));
    }

    /** Submits public input blocks and returns the admission receipt. */
    public ManagedTurnAdmission submitTurn(String sessionId, List<ManagedInput> input,
            String idempotencyKey) {
        List<Map<String, Object>> blocks = input.stream().map(ManagedInput::toJson).collect(Collectors.toList());
        return new ManagedTurnAdmission(write("POST", session(sessionId) + "/events",
                Map.of("type", "agent.session.input.message", "input", blocks), idempotencyKey, 202));
    }

    public ManagedTurnAdmission submitText(String sessionId, String text, String idempotencyKey) {
        return submitTurn(sessionId, List.of(ManagedInput.text(text)), idempotencyKey);
    }

    public ManagedTurnAdmission cancelTurn(String sessionId, String turnId, String idempotencyKey) {
        return new ManagedTurnAdmission(write("POST", session(sessionId) + "/events",
                Map.of("type", "agent.session.cancel", "turn_id", turnId), idempotencyKey, 202));
    }

    public ManagedPage<ManagedTurn> listTurns(String sessionId, String cursor, Integer limit) {
        return new ManagedPage<>(get(page(session(sessionId) + "/turns", cursor, limit)), ManagedTurn::new);
    }

    public ManagedTurn getTurn(String sessionId, String turnId) {
        return new ManagedTurn(get(session(sessionId) + "/turns/" + segment(turnId)));
    }

    public ManagedItem.Page listItems(String sessionId, Long after, String cursor, Integer limit) {
        return new ManagedItem.Page(get(query(page(session(sessionId) + "/items", cursor, limit), "after", after)));
    }

    public ManagedEventPage listEvents(String sessionId, Long after, Integer limit) {
        String route = query(session(sessionId) + "/events", "after", after);
        return new ManagedEventPage(get(query(route, "limit", limit)));
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

    public ManagedPage<ManagedAction> listActions(String sessionId, String cursor, Integer limit, Boolean includeChildren) {
        String route = page(session(sessionId) + "/actions", cursor, limit);
        return new ManagedPage<>(get(query(route, "include_children", includeChildren)), ManagedAction::new);
    }

    public ManagedAction getAction(String sessionId, String actionId) {
        return new ManagedAction(get(session(sessionId) + "/actions/" + segment(actionId)));
    }

    public ManagedOperation respondToAction(String sessionId, String actionId, ManagedActionResponse response,
            String idempotencyKey) {
        return new ManagedOperation(write("POST", session(sessionId) + "/actions/" + segment(actionId) + "/responses",
                response.toJson(), idempotencyKey, 202));
    }

    public ManagedRecovery getRecovery(String sessionId) {
        return new ManagedRecovery(get(session(sessionId) + "/recovery"));
    }

    public ManagedRecovery recheckRecovery(String sessionId, String turnId) {
        return new ManagedRecovery(json("POST", session(sessionId) + "/recovery/recheck",
                Map.of("turnId", turnId), null, 202));
    }

    public ManagedResources getResources(String sessionId) {
        return new ManagedResources(get(session(sessionId) + "/resources"));
    }

    public ManagedHookCatalog getHookCatalog(String sessionId) {
        return new ManagedHookCatalog(get(session(sessionId) + "/hook-catalog"));
    }

    public ManagedMcpCatalog getMcpCatalog(String sessionId) {
        return new ManagedMcpCatalog(get(session(sessionId) + "/mcp-catalog"));
    }

    public ManagedMcpManagementSnapshot getMcpManagement(String sessionId) {
        return new ManagedMcpManagementSnapshot(get(session(sessionId) + "/mcp-management"));
    }

    public ManagedMcpManagementSnapshot submitMcpManagement(String sessionId, ManagedMcpManagementCommand command,
            String idempotencyKey) {
        return new ManagedMcpManagementSnapshot(write("POST", session(sessionId) + "/mcp-management/commands",
                command.toJson(), idempotencyKey, 200));
    }

    public ManagedMcpManagementSnapshot getMcpManagementOperation(String sessionId, String operationId) {
        return new ManagedMcpManagementSnapshot(get(session(sessionId) + "/mcp-management/commands/" + segment(operationId)));
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
