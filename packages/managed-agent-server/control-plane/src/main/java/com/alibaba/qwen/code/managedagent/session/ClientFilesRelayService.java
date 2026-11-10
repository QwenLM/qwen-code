package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Binding;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Registration;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Status;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ClientFilesRelay;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

/**
 * Ephemeral client filesystem registrations. The browser keeps its directory
 * grant and runs the MCP server; this service relays opaque JSON-RPC between
 * the Runtime and the browser through a bounded TTL queue. Registrations are
 * session state, not journal records: no file content, credential or directory
 * path is persisted or projected.
 */
@Service
public class ClientFilesRelayService {
    public static final String SERVER_ID = "local-files";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final long POLL_INTERVAL_MILLIS = 100;

    private final ClientFilesRelay relay;
    private final ManagedAgentService agentService;
    private final ManagedWorkspaceRegistry workspaces;
    private final ManagedAgentSettings settings;
    private final ObjectMapper json;

    public ClientFilesRelayService(ClientFilesRelay relay, ManagedAgentService agentService,
            ManagedWorkspaceRegistry workspaces, ManagedAgentSettings settings,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.relay = relay;
        this.agentService = agentService;
        this.workspaces = workspaces;
        this.settings = settings;
        this.json = json;
    }

    public Registration register(String tenant, String actor, String session) {
        requireEnabled();
        requireSessionId(session);
        requireExecutionAuthority(tenant, actor, session);
        long now = System.currentTimeMillis();
        Binding previous = relay.find(tenant, session);
        byte[] secret = new byte[32];
        RANDOM.nextBytes(secret);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        long expiresAt = now + settings.getClientFiles().getBindingTtl().toMillis();
        Binding binding = relay.register(tenant, session, actor, SERVER_ID,
                DigestUtils.sha256Hex(token), expiresAt, now);
        if (previous != null && previous.active() && previous.generation() != binding.generation()) {
            relay.failQueued(tenant, session, previous.generation(), ClientFilesModels.ERROR_OFFLINE, now);
        }
        return new Registration(binding.serverId(), binding.generation(), token, binding.expiresAt());
    }

    public Status unregister(String tenant, String actor, String session) {
        requireEnabled();
        requireSessionId(session);
        SessionRecord visible = agentService.requireReadableSession(tenant, actor, session);
        Binding binding = relay.find(tenant, session);
        boolean owner = binding != null && binding.actorId().equals(actor);
        if (!owner && !mayExecute(visible, actor)) {
            throw error(403, "client_files_execution_forbidden");
        }
        if (binding == null) {
            throw error(404, "client_files_not_found");
        }
        long now = System.currentTimeMillis();
        relay.close(tenant, session, binding.generation(), now);
        relay.failQueued(tenant, session, binding.generation(), ClientFilesModels.ERROR_OFFLINE, now);
        return new Status(binding.serverId(), binding.generation(), ClientFilesModels.STATE_CLOSED,
                binding.expiresAt());
    }

    public Status status(String tenant, String actor, String session) {
        requireEnabled();
        requireSessionId(session);
        agentService.requireReadableSession(tenant, actor, session);
        Binding binding = relay.find(tenant, session);
        if (binding == null) {
            return null;
        }
        return new Status(binding.serverId(), binding.generation(), binding.state(), binding.expiresAt());
    }

    public List<QueuedRequest> requests(String tenant, String actor, String session, long generation) {
        requireEnabled();
        requireSessionId(session);
        agentService.requireReadableSession(tenant, actor, session);
        Binding binding = requireOwnedBinding(tenant, actor, session, generation);
        return relay.queued(tenant, session, binding.generation(),
                settings.getClientFiles().getQueueDepth());
    }

    public void respond(String tenant, String actor, String session, long generation,
            String requestId, String responseJson, String errorCode) {
        requireEnabled();
        requireSessionId(session);
        agentService.requireReadableSession(tenant, actor, session);
        Binding binding = requireOwnedBinding(tenant, actor, session, generation);
        if (requestId == null || requestId.isBlank() || requestId.length() > 128) {
            throw error(400, "client_files_invalid");
        }
        boolean answer = responseJson != null;
        if (answer == (errorCode != null)) {
            throw error(400, "client_files_invalid");
        }
        String payload = answer ? responseJson : errorCode;
        requirePayloadSize(payload);
        long now = System.currentTimeMillis();
        boolean settled = answer
                ? relay.answer(tenant, session, binding.generation(), requestId, responseJson, now)
                : relay.fail(tenant, session, binding.generation(), requestId, errorCode, now);
        if (!settled) {
            throw error(404, "client_files_request_not_found");
        }
    }

    /**
     * The Runtime-facing MCP leg. Returns the browser's JSON-RPC response, a
     * structured offline error once the request expires, or {@code null} for
     * a notification (the controller answers 202).
     */
    public String mcp(String tenant, String session, String token, String body) {
        requireEnabled();
        requireSessionId(session);
        Binding binding = relay.find(tenant, session);
        requireCredential(binding, token);
        requirePayloadSize(body);
        JsonNode request = parse(body);
        JsonNode method = request.get("method");
        if (method == null || !method.isTextual() || method.asText().isBlank()) {
            throw error(400, "client_files_invalid");
        }
        long now = System.currentTimeMillis();
        JsonNode id = request.get("id");
        if (id == null || id.isNull()) {
            enqueue(binding, "n-" + UUID.randomUUID(), body, now);
            return null;
        }
        String requestId = id.asText();
        if (requestId.isBlank() || requestId.length() > 128) {
            throw error(400, "client_files_invalid");
        }
        enqueue(binding, requestId, body, now);
        long deadline = now + settings.getClientFiles().getRequestTtl().toMillis();
        while (System.currentTimeMillis() < deadline) {
            QueuedRequest row = relay.request(tenant, session, binding.generation(), requestId);
            if (row == null) {
                break;
            }
            if (ClientFilesModels.REQUEST_ANSWERED.equals(row.state())) {
                return row.responseJson();
            }
            if (!ClientFilesModels.REQUEST_QUEUED.equals(row.state())) {
                break;
            }
            try {
                Thread.sleep(POLL_INTERVAL_MILLIS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return offlineError(id);
    }

    @Scheduled(fixedDelay = 30_000)
    public void expireRequests() {
        if (!settings.getClientFiles().isEnabled()) {
            return;
        }
        relay.expireBefore(System.currentTimeMillis(), 64);
    }

    private void enqueue(Binding binding, String requestId, String body, long now) {
        if (relay.queuedCount(binding.tenantId(), binding.sessionId(), binding.generation())
                >= settings.getClientFiles().getQueueDepth()) {
            throw error(409, "client_files_queue_full");
        }
        relay.enqueue(binding.tenantId(), binding.sessionId(), binding.generation(), requestId,
                body, now + settings.getClientFiles().getRequestTtl().toMillis(), now);
    }

    private SessionRecord requireExecutionAuthority(String tenant, String actor, String session) {
        SessionRecord visible = agentService.requireReadableSession(tenant, actor, session);
        if (!mayExecute(visible, actor)) {
            throw error(403, "client_files_execution_forbidden");
        }
        return visible;
    }

    private boolean mayExecute(SessionRecord session, String actor) {
        return "ACTIVE".equals(session.status()) && session.deletedAt() == null
                && session.workspace() != null
                && workspaces.accessOf(session.tenantId(), actor,
                        session.workspace().getWorkspaceId()).canCreate();
    }

    private Binding requireBinding(String tenant, String session) {
        Binding binding = relay.find(tenant, session);
        if (binding == null) {
            throw error(404, "client_files_not_found");
        }
        return binding;
    }

    private Binding requireOwnedBinding(String tenant, String actor, String session, long generation) {
        Binding binding = requireBinding(tenant, session);
        if (!binding.actorId().equals(actor) || !binding.active()
                || binding.expiresAt() <= System.currentTimeMillis()) {
            throw error(404, "client_files_not_found");
        }
        if (binding.generation() != generation) {
            throw error(409, "client_files_generation_conflict");
        }
        return binding;
    }

    private void requireCredential(Binding binding, String token) {
        boolean valid = binding != null && binding.active()
                && binding.expiresAt() > System.currentTimeMillis()
                && token != null
                && MessageDigest.isEqual(
                        DigestUtils.sha256Hex(token).getBytes(StandardCharsets.US_ASCII),
                        binding.tokenHash().getBytes(StandardCharsets.US_ASCII));
        if (!valid) {
            throw error(403, "client_files_credential_invalid");
        }
    }

    private void requirePayloadSize(String payload) {
        if (payload == null
                || payload.getBytes(StandardCharsets.UTF_8).length > settings.getClientFiles().getMaxPayloadBytes()) {
            throw error(400, "client_files_payload_too_large");
        }
    }

    private JsonNode parse(String body) {
        try {
            JsonNode node = json.readTree(body);
            if (node == null || !node.isObject()) {
                throw error(400, "client_files_invalid");
            }
            return node;
        } catch (ManagedAgentException refused) {
            throw refused;
        } catch (Exception malformed) {
            throw error(400, "client_files_invalid");
        }
    }

    private String offlineError(JsonNode id) {
        ObjectNode response = json.createObjectNode();
        response.put("jsonrpc", "2.0");
        response.set("id", id);
        ObjectNode error = response.putObject("error");
        error.put("code", -32000);
        error.put("message", ClientFilesModels.ERROR_OFFLINE);
        return response.toString();
    }

    private void requireEnabled() {
        if (!settings.getClientFiles().isEnabled()) {
            throw error(503, "client_files_disabled");
        }
    }

    private static void requireSessionId(String session) {
        if (session == null || session.isBlank() || session.length() > 128) {
            throw error(400, "client_files_invalid");
        }
    }

    private static ManagedAgentException error(int status, String code) {
        return new ManagedAgentException(status, code, "Client files relay refused the request.");
    }
}
