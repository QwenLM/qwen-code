package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedMcpOAuthConfiguration;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedMcpOAuthConfiguration.Provider;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Attempt;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Credential;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Scope;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class ManagedMcpOAuthService {
    @org.springframework.beans.factory.annotation.Autowired
    private org.springframework.beans.factory.ObjectProvider<
                    com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector>
            harness;

    private static final String NOTICE =
            "Only you may drive personal authorization. Session history and results remain visible"
                    + " under Workspace read permissions.";
    private final ManagedMcpOAuthConfiguration settings;
    private final McpOAuthRepository repository;
    private final ManagedExtensionPackageService packages;
    private final ManagedExtensionRecordStore records;
    private final ManagedAgentService sessions;
    private final com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore stateStore;
    private final ManagedMcpOAuthClient client;
    private final ObjectMapper json;
    private final SecureRandom random = new SecureRandom();

    public ManagedMcpOAuthService(
            ManagedMcpOAuthConfiguration settings,
            McpOAuthRepository repository,
            ManagedExtensionPackageService packages,
            ManagedExtensionRecordStore records,
            ManagedAgentService sessions,
            ManagedMcpOAuthClient client,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore stateStore) {
        this.settings = settings;
        this.repository = repository;
        this.packages = packages;
        this.records = records;
        this.sessions = sessions;
        this.stateStore = stateStore;
        this.client = client;
        this.json = json;
    }

    public JsonNode query(String tenant, String actor, String sessionId, List<Pin> requested) {
        SessionRecord session = requireCredentialManagement(tenant, actor, sessionId);
        ObjectNode result =
                json.createObjectNode()
                        .put("supported", supported(session))
                        .put("canAuthorize", false)
                        .put("notice", NOTICE);
        ArrayNode servers = result.putArray("servers");
        ArrayNode providers = result.putArray("providers");
        if (!supported(session)) {
            if (session.workspace() != null
                    && packages.canPublish(tenant, actor, session.workspace().getWorkspaceId())) {
                for (Credential grant : repository.credentials(scope(session, actor))) {
                    JsonNode binding = grant.binding();
                    String serverId = binding.path("serverId").asText();
                    ObjectNode row = servers.addObject()
                            .put("serverId", serverId)
                            .put("serverName", serverId.substring(serverId.lastIndexOf(':') + 1))
                            .put("providerId", binding.path("providerId").asText())
                            .put("resourceUri", binding.path("resourceUri").asText())
                            .put("credentialId", grant.id())
                            .put("generation", grant.generation())
                            .put("actorOwned", true)
                            .put("state", authorizationState(grant));
                    row.set("pin", binding.path("pin"));
                    row.set("scopes", binding.path("scopes"));
                }
            }
            return result;
        }
        result.put("canAuthorize", true);
        for (var entry : settings.getProviders().entrySet()) {
            providers
                    .addObject()
                    .put("providerId", entry.getKey())
                    .put("resourceUri", entry.getValue().getResourceUri())
                    .set("scopes", json.valueToTree(entry.getValue().getScopes()));
        }
        List<Pin> pins = requested == null ? currentPins(tenant, sessionId) : requested;
        if (pins.size() > 32 || pins.stream().anyMatch(pin -> pin == null || pin.extensionId() == null)) {
            throw invalid();
        }
        pins = List.copyOf(pins);
        List<Credential> grants = repository.credentials(scope(session, actor));
        for (Pin pin : pins) {
            JsonNode inspection = inspect(tenant, actor, session.workspace().getWorkspaceId(), pin);
            for (JsonNode server : inspection.path("mcpServers")) {
                if (!server.path("recipe").has("auth")) {
                    continue;
                }
                JsonNode binding = binding(pin, server.path("name").asText(), server.get("recipe"));
                ObjectNode row =
                        servers.addObject()
                                .put("serverId", binding.path("serverId").asText())
                                .put("serverName", server.path("name").asText())
                                .put("providerId", binding.path("providerId").asText())
                                .put("resourceUri", binding.path("resourceUri").asText())
                                .put("state", "unauthorized")
                                .put("actorOwned", false);
                row.set("pin", json.valueToTree(pin));
                row.set("scopes", binding.get("scopes"));
                for (Credential grant : grants) {
                    if (sameBinding(grant.binding(), binding)) {
                        row.put("credentialId", grant.id())
                                .put("generation", grant.generation())
                                .put("actorOwned", true)
                                .put("state", authorizationState(grant));
                        break;
                    }
                }
            }
        }
        return result;
    }

    public JsonNode start(
            String tenant,
            String actor,
            String sessionId,
            String serverId,
            Pin requested,
            String browserNonce,
            String idempotencyKey) {
        if (serverId == null || !serverId.matches("[A-Za-z0-9._:-]{1,128}")) {
            throw invalid();
        }
        SessionRecord session = requireSession(tenant, actor, sessionId);
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        requireNonce(browserNonce);
        Pin pin = requested;
        if (pin == null) {
            pin =
                    currentPins(tenant, sessionId).stream()
                            .filter(value -> serverId.startsWith(value.extensionId() + ":"))
                            .findFirst()
                            .orElseThrow(ManagedMcpOAuthService::invalid);
        }
        if (pin.extensionId() == null) {
            throw invalid();
        }
        String serverName =
                serverId.substring(Math.min(serverId.length(), pin.extensionId().length() + 1));
        JsonNode declaration =
                declaration(tenant, actor, session.workspace().getWorkspaceId(), pin, serverName);
        if (!serverId.equals(declaration.path("serverId").asText())) {
            throw invalid();
        }
        Provider provider = provider(declaration.path("providerId").asText());
        client.verifyMetadata(provider);
        String callback = callback();
        String state = randomValue();
        String verifier = randomValue();
        String id =
                "mauth_"
                        + UUID.nameUUIDFromBytes(
                                (tenant
                                                + "\0"
                                                + actor
                                                + "\0"
                                                + session.workspace().getWorkspaceId()
                                                + "\0"
                                                + idempotencyKey)
                                        .getBytes(StandardCharsets.UTF_8));
        var payload = json.createObjectNode().put("state", state).put("verifier", verifier);
        Scope scope = scope(session, actor);
        long epoch = 0;
        try {
            epoch = repository.credential(scope, McpOAuthRepository.credentialId(scope, declaration)).generation();
        } catch (ManagedAgentException missing) {
            if (missing.getStatus() != 404) {
                throw missing;
            }
        }
        ((ObjectNode) declaration).put("credentialEpoch", epoch);
        String digest =
                DigestUtils.sha256Hex(
                        declaration.toString() + "\0" + DigestUtils.sha256Hex(browserNonce));
        Attempt attempt =
                repository.createAttempt(
                        new Attempt(
                                id,
                                scope(session, actor),
                                DigestUtils.sha256Hex(state),
                                DigestUtils.sha256Hex(browserNonce),
                                digest,
                                "pending",
                                System.currentTimeMillis() + 600_000,
                                declaration,
                                payload,
                                null));
        if (!digest.equals(attempt.requestDigest())
                || attempt.expiresAt() <= System.currentTimeMillis()
                || !Set.of("pending", "code_received").contains(attempt.state())) {
            throw unavailable();
        }
        Map<String, String> query = new LinkedHashMap<>();
        query.put("response_type", "code");
        query.put("client_id", provider.getClientId());
        query.put("redirect_uri", callback);
        query.put("resource", provider.getResourceUri());
        query.put(
                "scope",
                String.join(" ", ManagedMcpOAuthClient.strings(declaration.get("scopes"))));
        query.put("state", attempt.secrets().path("state").asText());
        query.put("code_challenge_method", "S256");
        query.put(
                "code_challenge",
                Base64.getUrlEncoder()
                        .withoutPadding()
                        .encodeToString(
                                DigestUtils.sha256(attempt.secrets().path("verifier").asText())));
        String endpoint = provider.getAuthorizationEndpoint();
        return json.createObjectNode()
                .put("attemptId", id)
                .put(
                        "authorizationUrl",
                        endpoint
                                + (endpoint.contains("?") ? "&" : "?")
                                + ManagedMcpOAuthClient.form(query))
                .put("expiresAt", attempt.expiresAt());
    }

    public void callback(String state, String issuer, String code) {
        if (!settings.isEnabled()
                || state == null
                || state.length() > 512
                || code == null
                || code.isBlank()
                || code.length() > 8192
                || code.chars().anyMatch(Character::isISOControl)) {
            throw invalid();
        }
        repository.receiveCode(
                DigestUtils.sha256Hex(state), issuer, code, System.currentTimeMillis());
    }

    public void callbackFailure(String state) {
        if (!settings.isEnabled() || state == null || state.length() > 512) {
            throw invalid();
        }
        repository.rejectAttempt(DigestUtils.sha256Hex(state), System.currentTimeMillis());
    }

    public JsonNode status(String tenant, String actor, String sessionId, String attemptId) {
        requireAttemptId(attemptId);
        SessionRecord session = requireCredentialManagement(tenant, actor, sessionId);
        return attemptStatus(repository.attempt(scope(session, actor), attemptId));
    }

    public JsonNode complete(
            String tenant, String actor, String sessionId, String attemptId, String browserNonce) {
        requireAttemptId(attemptId);
        SessionRecord session = requireSession(tenant, actor, sessionId);
        requireNonce(browserNonce);
        Scope scope = scope(session, actor);
        Attempt attempt =
                repository.claimAttempt(
                        scope,
                        attemptId,
                        DigestUtils.sha256Hex(browserNonce),
                        System.currentTimeMillis());
        if ("completed".equals(attempt.state())) {
            return attemptStatus(attempt);
        }
        try {
            Provider provider = checkedProvider(attempt.binding());
            JsonNode tokens =
                    client.exchange(
                            provider,
                            callback(),
                            attempt.secrets().path("code").asText(),
                            attempt.secrets().path("verifier").asText());
            requireGrantedScopes(attempt.binding(), tokens);
            requireSession(tenant, actor, sessionId);
            repository.completeAttempt(
                    scope, attemptId, tokens, expiry(tokens), System.currentTimeMillis());
            return attemptStatus(repository.attempt(scope, attemptId));
        } catch (RuntimeException failure) {
            repository.failAttempt(scope, attemptId);
            throw unavailable();
        }
    }

    public JsonNode revoke(
            String tenant, String actor, String sessionId, String id, long generation) {
        if (id == null || !id.matches("mcred_[0-9a-f-]{36}") || generation < 1) {
            throw invalid();
        }
        SessionRecord session = requireCredentialManagement(tenant, actor, sessionId);
        Scope scope = scope(session, actor);
        Credential previous = repository.credential(scope, id);
        Credential revoked = repository.revoke(scope, id, generation);
        if (!"revoked".equals(previous.state())) {
            try {
                client.revoke(
                        checkedProvider(previous.binding()),
                        previous.secrets()
                                .path("refresh_token")
                                .asText(previous.secrets().path("access_token").asText()));
            } catch (RuntimeException unavailable) {
                /* Revocation has already fenced the local grant. */
            }
        }
        return json.createObjectNode()
                .put("state", "revoked")
                .put("credentialId", id)
                .put("generation", revoked.generation());
    }

    public void validateBindings(
            String tenant, String actor, SessionRecord session, JsonNode bindings, List<Pin> pins) {
        if (!bindings.isArray() || bindings.size() > 32) {
            throw invalid();
        }
        if (!bindings.isEmpty()) {
            requireSession(tenant, actor, session.sessionId());
        }
        var serverIds = new java.util.HashSet<String>();
        for (JsonNode value : bindings) {
            if (!value.isObject()
                    || value.size() != 3
                    || !value.has("serverId")
                    || !value.has("credentialId")
                    || !value.path("credentialGeneration").isIntegralNumber()
                    || !serverIds.add(value.path("serverId").asText())) {
                throw invalid();
            }
            Credential grant =
                    repository.credential(
                            scope(session, actor), value.path("credentialId").asText());
            if (grant.generation() != value.path("credentialGeneration").asLong()
                    || !"active".equals(grant.state())) {
                throw unavailable();
            }
            String serverId = value.path("serverId").asText();
            Pin pin =
                    pins.stream()
                            .filter(entry -> serverId.startsWith(entry.extensionId() + ":"))
                            .findFirst()
                            .orElseThrow(ManagedMcpOAuthService::invalid);
            JsonNode declaration =
                    declaration(
                            tenant,
                            actor,
                            session.workspace().getWorkspaceId(),
                            pin,
                            serverId.substring(pin.extensionId().length() + 1));
            if (!sameBinding(grant.binding(), declaration)) {
                throw unavailable();
            }
        }
    }

    public String accessToken(
            String tenant,
            String actor,
            String sessionId,
            String serverId,
            String credentialId,
            long generation,
            String resourceUri) {
        SessionRecord session = requireSession(tenant, actor, sessionId);
        Scope scope = scope(session, actor);
        Credential grant = repository.credential(scope, credentialId);
        if (grant.generation() != generation
                || !serverId.equals(grant.binding().path("serverId").asText())
                || !resourceUri.equals(grant.binding().path("resourceUri").asText())) {
            throw unavailable();
        }
        Provider provider = checkedProvider(grant.binding());
        long now = System.currentTimeMillis();
        if (!"active".equals(grant.state())) {
            throw unavailable();
        }
        if (grant.expiresAt() <= now + 30_000) {
            if (!grant.secrets().path("refresh_token").isTextual()) {
                throw unavailable();
            }
            String lease = UUID.randomUUID().toString();
            Credential claimed =
                    repository.claimRefresh(
                            scope, credentialId, generation, lease, now, now + 30_000);
            try {
                JsonNode tokens =
                        client.refresh(provider, claimed.secrets().path("refresh_token").asText());
                requireGrantedScopes(claimed.binding(), tokens);
                if (!tokens.has("refresh_token")) {
                    ((ObjectNode) tokens)
                            .set("refresh_token", claimed.secrets().get("refresh_token"));
                }
                grant =
                        repository.completeRefresh(
                                scope, credentialId, generation, lease, tokens, expiry(tokens));
            } catch (RuntimeException unknown) {
                repository.failRefresh(scope, credentialId, generation, lease);
                throw unavailable();
            }
        }
        Credential current = repository.credential(scope, credentialId);
        if (!"active".equals(current.state())
                || current.generation() != generation
                || current.expiresAt() <= System.currentTimeMillis()) {
            throw unavailable();
        }
        return current.secrets().path("access_token").asText();
    }

    public String accessTokenForRuntime(
            String tenant,
            String workspace,
            String sessionId,
            long configRevision,
            String serverId,
            String credentialId,
            long generation,
            String resourceUri,
            String expectedActorKey) {
        JsonNode record = effectiveRecord(tenant, sessionId);
        if (record == null || record.path("configRevision").asLong() != configRevision) {
            throw unavailable();
        }
        JsonNode bundle = records.readRecordResource(tenant, sessionId, record.path("bundleRef"));
        if (bundle.path("formatVersion").asInt() != 2
                || bundle.path("configRevision").asLong() != configRevision
                || !bundle.path("executionActorKey").asText().equals(expectedActorKey)) {
            throw unavailable();
        }
        boolean found = false;
        for (JsonNode binding : bundle.path("mcpAuthBindings")) {
            if (serverId.equals(binding.path("serverId").asText())
                    && credentialId.equals(binding.path("credentialId").asText())
                    && generation == binding.path("credentialGeneration").asLong()) {
                found = true;
            }
        }
        if (!found) {
            throw unavailable();
        }
        Credential grant = repository.findCredential(tenant, workspace, credentialId);
        if (!DigestUtils.sha256Hex(grant.scope().actor())
                .equals(bundle.path("executionActorKey").asText())) {
            throw unavailable();
        }
        SessionRecord session = requireSession(tenant, grant.scope().actor(), sessionId);
        if (!workspace.equals(session.workspace().getWorkspaceId())) {
            throw unavailable();
        }
        String token =
                accessToken(
                        tenant,
                        grant.scope().actor(),
                        sessionId,
                        serverId,
                        credentialId,
                        generation,
                        resourceUri);
        JsonNode current = effectiveRecord(tenant, sessionId);
        if (current == null
                || current.path("configRevision").asLong() != configRevision
                || !current.path("bundleRef").equals(record.path("bundleRef"))) {
            throw unavailable();
        }
        return token;
    }

    private JsonNode effectiveRecord(String tenant, String sessionId) {
        JsonNode record = records.currentMcpSettings(tenant, sessionId);
        for (int step = 0; record != null && step < 4096; step++) {
            if (Set.of("committed", "active", "recovery_required")
                    .contains(record.path("phase").asText())) {
                return record;
            }
            if ("recoverPrevious".equals(record.path("mode").asText())
                    || !record.path("previousRecordRef").isObject()) {
                return null;
            }
            record = records.readRecordResource(tenant, sessionId, record.get("previousRecordRef"));
        }
        return null;
    }

    private JsonNode declaration(
            String tenant, String actor, String workspace, Pin pin, String name) {
        for (JsonNode server : inspect(tenant, actor, workspace, pin).path("mcpServers")) {
            if (name.equals(server.path("name").asText())) {
                return binding(pin, name, server.path("recipe"));
            }
        }
        throw invalid();
    }

    private JsonNode binding(Pin pin, String name, JsonNode recipe) {
        JsonNode auth = recipe.path("auth");
        if (!auth.isObject()
                || auth.size() != 4
                || !"oauth".equals(auth.path("type").asText())
                || !auth.path("providerId").isTextual()
                || !auth.path("resourceUri").isTextual()
                || recipe.has("command")
                || recipe.path("headers").has("Authorization")) {
            throw invalid();
        }
        Provider provider = provider(auth.path("providerId").asText());
        List<String> scopes = ManagedMcpOAuthClient.strings(auth.path("scopes"));
        String url = recipe.path("httpUrl").asText(recipe.path("url").asText());
        if (!provider.getResourceUri().equals(auth.path("resourceUri").asText())
                || !url.equals(provider.getResourceUri())
                || !provider.getScopes().containsAll(scopes)
                || scopes.isEmpty()) {
            throw invalid();
        }
        ObjectNode binding =
                json.createObjectNode()
                        .put("serverId", pin.extensionId() + ":" + name)
                        .put("providerId", auth.path("providerId").asText())
                        .put("resourceUri", provider.getResourceUri())
                        .put("issuer", provider.getIssuer())
                        .put("providerDigest", client.providerDigest(provider));
        binding.set("scopes", json.valueToTree(scopes.stream().sorted().toList()));
        binding.set("pin", json.valueToTree(pin));
        return binding;
    }

    private String authorizationState(Credential grant) {
        return "revoked".equals(grant.state()) ? "revoked"
                : "active".equals(grant.state()) ? "authorized" : "unavailable";
    }

    private boolean sameBinding(JsonNode left, JsonNode right) {
        for (String field :
                List.of(
                        "serverId",
                        "providerId",
                        "resourceUri",
                        "issuer",
                        "providerDigest",
                        "scopes")) {
            if (!left.path(field).equals(right.path(field))) {
                return false;
            }
        }
        return true;
    }

    private JsonNode inspect(String tenant, String actor, String workspace, Pin pin) {
        try {
            return packages.inspection(tenant, actor, workspace, pin);
        } catch (IOException failed) {
            throw unavailable();
        }
    }

    private List<Pin> currentPins(String tenant, String sessionId) {
        JsonNode record = records.currentMcpSettings(tenant, sessionId);
        for (int step = 0; record != null && step < 4096; step++) {
            if ("active".equals(record.path("phase").asText())) {
                JsonNode bundle =
                        records.readRecordResource(tenant, sessionId, record.path("bundleRef"));
                List<Pin> result = new ArrayList<>();
                for (JsonNode entry : bundle.path("packages")) {
                    result.add(json.convertValue(entry.path("pin"), Pin.class));
                }
                return List.copyOf(result);
            }
            if (!record.path("previousRecordRef").isObject()) {
                break;
            }
            record = records.readRecordResource(tenant, sessionId, record.get("previousRecordRef"));
        }
        return List.of();
    }

    private ObjectNode attemptStatus(Attempt attempt) {
        String state =
                attempt.expiresAt() <= System.currentTimeMillis()
                                && !"completed".equals(attempt.state())
                        ? "expired"
                        : attempt.state();
        ObjectNode value =
                json.createObjectNode()
                        .put("attemptId", attempt.id())
                        .put("state", state)
                        .put("expiresAt", attempt.expiresAt());
        if (attempt.credentialId() != null) {
            value.put("credentialId", attempt.credentialId())
                    .put("generation", attempt.binding().path("credentialEpoch").asLong() + 1);
        }
        return value;
    }

    private SessionRecord requireSession(String tenant, String actor, String id) {
        SessionRecord session = requireCredentialManagement(tenant, actor, id);
        if (!supported(session)) {
            throw new ManagedAgentException(
                    409,
                    "unsupported_feature",
                    "Personal MCP OAuth requires an isolated supported execution profile.");
        }
        return session;
    }

    private SessionRecord requireCredentialManagement(String tenant, String actor, String id) {
        SessionRecord session = sessions.requireReadableSession(tenant, actor, id);
        if (session.workspace() == null) {
            throw invalid();
        }
        packages.requireExecutionAccess(tenant, actor, session.workspace().getWorkspaceId());
        return session;
    }

    private boolean supported(SessionRecord session) {
        return settings.isEnabled()
                && session.workspace() != null
                && settings.getIsolatedToolProfiles().contains(session.toolProfile())
                && !settings.getProviders().isEmpty()
                && stateStore.findChildLineage(session.tenantId(), session.sessionId()) == null
                && stateStore.supportsPersonalMcpExecution()
                && harness != null
                && harness.getIfAvailable() != null
                && harness.getObject().supportsPersonalMcpOAuth()
                && settings.getRuntimeTokenProxyBaseUrl() != null
                && !settings.getRuntimeTokenProxyBaseUrl().isBlank()
                && callbackValid();
    }

    private boolean callbackValid() {
        try {
            callback();
            return true;
        } catch (RuntimeException invalid) {
            return false;
        }
    }

    private String callback() {
        URI value = URI.create(settings.getCallbackUri());
        if (value.getHost() == null
                || value.getUserInfo() != null
                || value.getFragment() != null
                || value.getQuery() != null
                || !("https".equals(value.getScheme())
                        || "http".equals(value.getScheme())
                                && Set.of("127.0.0.1", "localhost", "[::1]")
                                        .contains(value.getHost()))
                || !value.getPath().endsWith("/oauth/mcp/callback")) {
            throw unavailable();
        }
        return value.toASCIIString();
    }

    private Provider provider(String id) {
        Provider value = settings.getProviders().get(id);
        if (value == null || value.getClientId() == null || value.getClientId().isBlank()) {
            throw unavailable();
        }
        return value;
    }

    private Provider checkedProvider(JsonNode binding) {
        Provider provider = provider(binding.path("providerId").asText());
        if (!client.providerDigest(provider).equals(binding.path("providerDigest").asText())) {
            throw unavailable();
        }
        return provider;
    }

    private void requireGrantedScopes(JsonNode binding, JsonNode tokens) {
        if (tokens.has("scope")
                && (!tokens.get("scope").isTextual()
                        || !new java.util.HashSet<>(
                                        java.util.Arrays.asList(
                                                tokens.get("scope").asText().split(" +")))
                                .containsAll(
                                        ManagedMcpOAuthClient.strings(binding.get("scopes"))))) {
            throw unavailable();
        }
    }

    private static long expiry(JsonNode tokens) {
        return Math.addExact(
                System.currentTimeMillis(),
                Math.multiplyExact(tokens.path("expires_in").asLong(), 1000));
    }

    private static Scope scope(SessionRecord session, String actor) {
        return new Scope(session.tenantId(), session.workspace().getWorkspaceId(), actor);
    }

    private String randomValue() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static void requireNonce(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{32,128}")) {
            throw invalid();
        }
    }

    private static void requireAttemptId(String value) {
        if (value == null || !value.matches("mauth_[0-9a-f-]{36}")) {
            throw invalid();
        }
    }

    private static ManagedAgentException invalid() {
        return new ManagedAgentException(
                400, "invalid_mcp_oauth_request", "Invalid personal MCP OAuth request.");
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(
                409,
                "oauth_authorization_unavailable",
                "Personal MCP authorization requires attention.");
    }
}
