package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Binding;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Registration;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Status;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ClientFilesRelay;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.annotation.PreDestroy;
import org.apache.commons.codec.digest.DigestUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Ephemeral client filesystem registrations. The browser keeps its directory
 * grant and runs the MCP server; this service relays opaque JSON-RPC between
 * the Runtime and the browser through a bounded TTL queue. Registrations are
 * session state, not journal records. The queue rows carry the size-bounded
 * JSON-RPC bodies — which may include file content — only until they settle or
 * expire, and are then deleted by the retention sweep; no credential or
 * directory path is persisted, and no file content enters the journal or public
 * events beyond the normal durable tool-result policy.
 */
@Service
public class ClientFilesRelayService {
    public static final String SERVER_ID = "local-files";
    private static final Logger LOG = LoggerFactory.getLogger(ClientFilesRelayService.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final long POLL_INTERVAL_MILLIS = 100;

    private final ClientFilesRelay relay;
    private final ManagedAgentService agentService;
    private final ManagedWorkspaceRegistry workspaces;
    private final ManagedAgentSettings settings;
    private final HarnessConnector harness;
    private final ObjectMapper json;

    /**
     * Pending MCP waiters, settled by one shared poller instead of one
     * blocking servlet thread per in-flight request. A response POST also
     * completes its waiters directly (fast path).
     */
    private final ConcurrentHashMap<WaiterKey, CopyOnWriteArrayList<Waiter>> waiters =
            new ConcurrentHashMap<>();
    private final ScheduledExecutorService waiterPoller =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "client-files-waiter-poller");
                thread.setDaemon(true);
                return thread;
            });

    public ClientFilesRelayService(ClientFilesRelay relay, ManagedAgentService agentService,
            ManagedWorkspaceRegistry workspaces, ManagedAgentSettings settings,
            HarnessConnector harness,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.relay = relay;
        this.agentService = agentService;
        this.workspaces = workspaces;
        this.settings = settings;
        this.harness = harness;
        this.json = json;
        waiterPoller.scheduleWithFixedDelay(this::settleWaiters,
                POLL_INTERVAL_MILLIS, POLL_INTERVAL_MILLIS, TimeUnit.MILLISECONDS);
    }

    @PreDestroy
    void shutdown() {
        waiterPoller.shutdownNow();
    }

    private record WaiterKey(String tenant, String session, long generation, String requestId) { }

    private static final class Waiter {
        private final long deadline;
        private final JsonNode id;
        private final CompletableFuture<String> future = new CompletableFuture<>();

        private Waiter(long deadline, JsonNode id) {
            this.deadline = deadline;
            this.id = id;
        }
    }

    public Registration register(String tenant, String actor, String session, String connectionId) {
        requireEnabled();
        requireSessionId(session);
        requireConnectionId(connectionId);
        requireExecutionAuthority(tenant, actor, session);
        String relayUrl = requireRelayUrl();
        long now = System.currentTimeMillis();
        Binding previous = relay.find(tenant, session);
        byte[] secret = new byte[32];
        RANDOM.nextBytes(secret);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        long expiresAt = now + settings.getClientFiles().getBindingTtl().toMillis();
        Binding binding = relay.register(tenant, session, actor, SERVER_ID,
                DigestUtils.sha256Hex(token), expiresAt, now, connectionId);
        if (previous != null && previous.active() && previous.generation() != binding.generation()) {
            relay.failQueued(tenant, session, previous.generation(), ClientFilesModels.ERROR_OFFLINE, now);
        }
        int toolCount;
        try {
            Map<String, Object> registered = harness.clientFilesOperation(tenant, session, Map.of(
                    "action", "register",
                    "serverId", binding.serverId(),
                    "generation", binding.generation(),
                    "url", relayEndpoint(relayUrl, session),
                    "token", token));
            toolCount = registered.get("toolCount") instanceof Number count
                    ? count.intValue() : 0;
        } catch (RuntimeException cause) {
            LOG.warn("Client files registration dispatch failed for session {}", session, cause);
            if (previous != null && previous.active()) {
                // The harness keeps its previous client and credential when the
                // dispatch is refused; put the previous credential back so the
                // session keeps serving. Fenced on this attempt still owning the
                // active binding, and monotonic, so a late compensation cannot
                // clobber a newer registration or reopen a revoked binding.
                relay.restore(tenant, session, binding.generation(), previous,
                        System.currentTimeMillis());
            }
            throw error(503, "client_files_relay_unavailable");
        }
        return new Registration(binding.serverId(), binding.generation(), token, binding.expiresAt(),
                toolCount, binding.connectionId());
    }

    public Status unregister(String tenant, String actor, String session, String connectionId) {
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
        // A stale teardown (an old tab whose registration was already replaced)
        // must not close the newer binding or drop its harness catalog.
        if (connectionId != null && !connectionId.equals(binding.connectionId())) {
            return new Status(binding.serverId(), binding.generation(), binding.state(),
                    binding.expiresAt(), binding.connectionId());
        }
        long now = System.currentTimeMillis();
        relay.close(tenant, session, binding.generation(), now);
        relay.failQueued(tenant, session, binding.generation(), ClientFilesModels.ERROR_OFFLINE, now);
        // The binding is already closed, so a Harness that cannot be reached
        // must not fail the teardown; its own session cleanup drops the tools.
        try {
            harness.clientFilesOperation(tenant, session, Map.of("action", "unregister"));
        } catch (RuntimeException ignored) {
            // best-effort dispatch
        }
        return new Status(binding.serverId(), binding.generation(), ClientFilesModels.STATE_CLOSED,
                binding.expiresAt(), binding.connectionId());
    }

    public Status status(String tenant, String actor, String session) {
        requireEnabled();
        requireSessionId(session);
        agentService.requireReadableSession(tenant, actor, session);
        Binding binding = relay.find(tenant, session);
        if (binding == null) {
            return null;
        }
        // An expired binding can no longer serve (the credential and ownership
        // checks refuse it by expiry), so report it closed even before the
        // sweep flips the row.
        String state = binding.expiresAt() <= System.currentTimeMillis()
                ? ClientFilesModels.STATE_CLOSED : binding.state();
        return new Status(binding.serverId(), binding.generation(), state, binding.expiresAt(),
                binding.connectionId());
    }

    /**
     * Tears down a registration whose SSE downlink dropped (a closed tab or a
     * lost connection), so the harness stops advertising tools no browser will
     * answer. Generation-fenced and idempotent: a stale stream callback for a
     * binding that already closed or rotated is a no-op, and an idle emitter
     * timeout does not call this — the bridge reopens that stream.
     */
    public void streamClosed(String tenant, String actor, String session, long generation) {
        requireEnabled();
        requireSessionId(session);
        Binding binding = relay.find(tenant, session);
        if (binding == null || !binding.active() || binding.generation() != generation
                || !binding.actorId().equals(actor)) {
            return;
        }
        long now = System.currentTimeMillis();
        relay.close(tenant, session, generation, now);
        relay.failQueued(tenant, session, generation, ClientFilesModels.ERROR_OFFLINE, now);
        try {
            harness.clientFilesOperation(tenant, session, Map.of("action", "unregister"));
        } catch (RuntimeException ignored) {
            // best-effort dispatch; the harness session cleanup also drops it
        }
    }

    /**
     * Lifecycle-initiated teardown when the harness detaches or the Session
     * closes: the harness-local catalog is gone, so the binding must not keep
     * reporting active (the panel would show connected while the model has no
     * client-file tools). No actor/generation fence — the lifecycle owns the
     * whole Session. Registrations stay ephemeral; no durable recovery.
     */
    public void closeForSession(String tenant, String session) {
        if (!settings.getClientFiles().isEnabled()) {
            return;
        }
        Binding binding = relay.find(tenant, session);
        if (binding == null || !binding.active()) {
            return;
        }
        long now = System.currentTimeMillis();
        relay.close(tenant, session, binding.generation(), now);
        relay.failQueued(tenant, session, binding.generation(), ClientFilesModels.ERROR_OFFLINE, now);
    }

    public List<QueuedRequest> requests(String tenant, String actor, String session, long generation) {
        requireEnabled();
        requireSessionId(session);
        Binding binding = requireDeliveryAuthority(tenant, actor, session, generation);
        return relay.queued(tenant, session, binding.generation(),
                settings.getClientFiles().getQueueDepth(), System.currentTimeMillis());
    }

    /**
     * Correlates a downlink with the registration that opened it: even when the
     * actor and generation match, a stream carrying a different connection
     * identity belongs to another tab's registration and must not drain this
     * binding's requests.
     */
    public void requireStreamConnection(String tenant, String actor, String session,
            long generation, String connectionId) {
        requireEnabled();
        requireSessionId(session);
        Binding binding = requireDeliveryAuthority(tenant, actor, session, generation);
        // The identity is mandatory: an omitted connectionId must be refused,
        // not short-circuited, or a second client of the same actor could attach
        // to the queue and settle another registration's requests.
        if (connectionId == null || !connectionId.equals(binding.connectionId())) {
            throw error(409, "client_files_generation_conflict");
        }
    }

    public void respond(String tenant, String actor, String session, long generation,
            String requestId, String responseJson, String errorCode) {
        requireEnabled();
        requireSessionId(session);
        Binding binding = requireDeliveryAuthority(tenant, actor, session, generation);
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
        // Fast path: settle the waiters now instead of at the next poll tick.
        // A null answer means failure; each waiter keeps its original id node
        // so a numeric JSON-RPC id is not coerced to a string.
        completeWaiters(tenant, session, binding.generation(), requestId,
                answer ? responseJson : null);
    }

    /**
     * The internal MCP leg carries no tenant context: the binding is resolved
     * by Session and the relay credential is the only admission.
     */
    public CompletableFuture<String> mcpSession(String session, String token, String body) {
        requireEnabled();
        requireSessionId(session);
        Binding binding = relay.findBySession(session);
        if (binding == null) {
            throw error(403, "client_files_credential_invalid");
        }
        return mcp(binding.tenantId(), session, token, body);
    }

    /**
     * The Runtime-facing MCP leg. The future completes with the browser's
     * JSON-RPC response, a structured offline error once the request expires,
     * or {@code null} for a notification (the controller answers 202).
     * Validation refusals throw synchronously; the wait itself never blocks
     * the calling (servlet) thread.
     */
    public CompletableFuture<String> mcp(String tenant, String session, String token, String body) {
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
            return CompletableFuture.completedFuture(null);
        }
        String requestId = id.asText();
        if (requestId.isBlank() || requestId.length() > 128) {
            throw error(400, "client_files_invalid");
        }
        try {
            enqueue(binding, requestId, body, now);
        } catch (org.springframework.dao.DuplicateKeyException retried) {
            // A retried JSON-RPC id attaches to the existing queue row; the
            // waiter shares its answer (or its settled failure).
        }
        long deadline = now + settings.getClientFiles().getRequestTtl().toMillis();
        Waiter waiter = new Waiter(deadline, id);
        // Publish atomically: a separate computeIfAbsent + add lets a concurrent
        // settleWaiters removal detach the fresh list between the two calls,
        // stranding the waiter's future until the controller timeout.
        waiters.compute(new WaiterKey(tenant, session, binding.generation(), requestId),
                (key, list) -> {
                    CopyOnWriteArrayList<Waiter> target =
                            list == null ? new CopyOnWriteArrayList<>() : list;
                    target.add(waiter);
                    return target;
                });
        return waiter.future;
    }

    /**
     * One shared poller settles every pending waiter: answered rows complete
     * with the response, settled/missing rows and expired deadlines complete
     * with the structured offline error.
     */
    void settleWaiters() {
        long now = System.currentTimeMillis();
        waiters.forEach((key, list) -> {
            for (Waiter waiter : list) {
                String answer;
                if (now >= waiter.deadline) {
                    answer = offlineError(waiter.id);
                } else {
                    QueuedRequest row;
                    try {
                        row = relay.request(key.tenant(), key.session(), key.generation(),
                                key.requestId());
                    } catch (RuntimeException unavailable) {
                        // Transient store failure: retry next tick; the
                        // deadline still bounds the wait.
                        continue;
                    }
                    if (row != null && ClientFilesModels.REQUEST_QUEUED.equals(row.state())) {
                        continue;
                    }
                    answer = row != null && ClientFilesModels.REQUEST_ANSWERED.equals(row.state())
                            ? row.responseJson() : offlineError(waiter.id);
                }
                list.remove(waiter);
                waiter.future.complete(answer);
            }
            // Remove only if still empty, atomically against a concurrent mcp()
            // compute that may have added a waiter to this same list.
            waiters.computeIfPresent(key, (k, l) -> l.isEmpty() ? null : l);
        });
    }

    private void completeWaiters(String tenant, String session, long generation,
            String requestId, String responseJson) {
        List<Waiter> list = waiters.remove(new WaiterKey(tenant, session, generation, requestId));
        if (list != null) {
            for (Waiter waiter : list) {
                waiter.future.complete(responseJson != null
                        ? responseJson : offlineError(waiter.id));
            }
        }
    }

    @Scheduled(fixedDelay = 30_000)
    public void expireRequests() {
        if (!settings.getClientFiles().isEnabled()) {
            return;
        }
        long now = System.currentTimeMillis();
        // Drain the expiry backlog within a bounded total so a mass disconnect
        // does not leave expired rows occupying queue slots for many ticks.
        for (int batch = 0; batch < 16; batch++) {
            if (relay.expireBefore(now, 64) < 64) {
                break;
            }
        }
        // Close bindings whose deadline passed so status stops reporting active
        // for a credential the relay already refuses.
        relay.closeExpiredBindings(now, 64);
        // Drop settled rows past a retention cutoff that exceeds request-ttl, so
        // answered rows stay readable until waiters settle but the bounded queue
        // does not grow for the life of a long-lived Session.
        long retention = settings.getClientFiles().getRequestTtl().toMillis() + 60_000;
        relay.deleteSettledBefore(now - retention, 256);
    }

    private void enqueue(Binding binding, String requestId, String body, long now) {
        if (relay.queuedCount(binding.tenantId(), binding.sessionId(), binding.generation(), now)
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

    /**
     * Delivery and settlement re-apply the execution authority registration
     * demanded: an actor demoted after registering must not keep reading and
     * writing the user's directory for the rest of the binding TTL. On refusal
     * the binding is closed and its queued rows failed so the stream ends and
     * the Runtime receives the structured offline error.
     */
    private Binding requireDeliveryAuthority(String tenant, String actor, String session,
            long generation) {
        SessionRecord visible = agentService.requireReadableSession(tenant, actor, session);
        Binding binding = requireOwnedBinding(tenant, actor, session, generation);
        if (!mayExecute(visible, actor)) {
            long now = System.currentTimeMillis();
            relay.close(tenant, session, binding.generation(), now);
            relay.failQueued(tenant, session, binding.generation(),
                    ClientFilesModels.ERROR_OFFLINE, now);
            throw error(403, "client_files_execution_forbidden");
        }
        return binding;
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

    private String requireRelayUrl() {
        String configured = settings.getClientFiles().getRelayUrl();
        if (configured == null || configured.isBlank()) {
            throw error(503, "client_files_relay_unconfigured");
        }
        URI uri;
        try {
            uri = URI.create(configured);
        } catch (IllegalArgumentException invalid) {
            throw error(503, "client_files_relay_unconfigured");
        }
        if ((!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme()))
                || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null) {
            throw error(503, "client_files_relay_unconfigured");
        }
        return configured.replaceAll("/+$", "");
    }

    private static String relayEndpoint(String relayUrl, String session) {
        return relayUrl + "/internal/managed-client-files/v1/sessions/" + session + "/mcp";
    }

    private static void requireSessionId(String session) {
        if (session == null || session.isBlank() || session.length() > 128) {
            throw error(400, "client_files_invalid");
        }
    }

    private static void requireConnectionId(String connectionId) {
        if (connectionId == null || connectionId.isBlank() || connectionId.length() > 64) {
            throw error(400, "client_files_invalid");
        }
    }

    private static ManagedAgentException error(int status, String code) {
        return new ManagedAgentException(status, code, "Client files relay refused the request.");
    }
}
