package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

@Service
public class ManagedExtensionManagementService {
    private final SessionPolicyStore store;
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;
    private final ManagedExtensionPackageService packages;
    private final ObjectMapper json;
    private final HarnessConnector harness;

    public ManagedExtensionManagementService(SessionPolicyStore store, ManagedAgentService sessions,
            ManagedExtensionRecordStore records, ManagedExtensionPackageService packages,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json, HarnessConnector harness) {
        this.store = store;
        this.sessions = sessions;
        this.records = records;
        this.packages = packages;
        this.json = json;
        this.harness = harness;
    }

    public JsonNode query(String tenant, String actor, String sessionId, String operationId) {
        // Extension management serves only Workspace Sessions: the raw
        // filter-admitted actor never needs a byte-bounded principal (R7-1).
        return query(tenant, actor, null, sessionId, operationId);
    }

    public JsonNode query(SessionPrincipal principal, String sessionId,
            String operationId) {
        return query(principal.tenantId(), principal.userId(), principal,
                sessionId, operationId);
    }

    private JsonNode query(String tenant, String actor,
            SessionPrincipal principal, String sessionId, String operationId) {
        SessionRecord session = principal == null
                ? sessions.requireReadableSession(tenant, actor, sessionId)
                : sessions.requireReadableSession(principal, sessionId);
        if (session.workspace() == null) {
            if (operationId != null) {
                throw missing();
            }
            return empty(sessionId, false);
        }
        boolean supported = packages.supported()
                && harness.supportsSessionExtensions();
        JsonNode latest = records.currentMcpSettings(tenant, sessionId);
        if (!ManagedConfigInstall.isPackageConfig(latest)) {
            if (operationId != null) {
                throw missing();
            }
            return withSelfService(empty(sessionId, supported), tenant, actor, session, supported);
        }
        JsonNode selected = latest;
        if (operationId != null) {
            if (!ManagedConfigInstall.uuid(operationId)) {
                throw invalid();
            }
            for (int step = 0; !operationId.equals(selected.path("operationId").asText()); step++) {
                if (step >= 4096 || selected.path("previousRecordRef").isNull()) {
                    throw missing();
                }
                selected = read(tenant, sessionId, selected.get("previousRecordRef"));
                if (!ManagedConfigInstall.isPackageConfig(selected)) {
                    throw missing();
                }
            }
        }
        return withSelfService(snapshot(tenant, sessionId, selected, supported), tenant, actor, session, supported);
    }

    public JsonNode lookup(String tenant, String actor, String sessionId, String key) {
        ManagedAgentService.validateIdempotencyKey(key);
        return query(tenant, actor, sessionId, applyOperationId(tenant, actor, sessionId, key));
    }

    public JsonNode lookup(SessionPrincipal principal, String sessionId,
            String key) {
        ManagedAgentService.validateIdempotencyKey(key);
        return query(principal, sessionId,
                applyOperationId(principal.tenantId(), principal.userId(),
                        principal, sessionId, key));
    }

    private JsonNode withSelfService(ObjectNode result, String tenant, String actor, SessionRecord session, boolean supported) {
        boolean enabled = supported && packages.selfServiceSupported();
        result.putObject("selfService").put("supported", enabled).put("canApply", enabled && store.canApplyExtensions(session)
                && "ACTIVE".equals(session.status()) && packages.canPublish(tenant, actor, session.workspace().getWorkspaceId()))
                .put("runtimeSkillImportSupported", packages.runtimeSkillImportEnabled() && harness.supportsRuntimeSkillImport());
        return result;
    }

    private static String applyOperationId(String tenant, String actor, String sessionId, String key) {
        return applyOperationId(tenant, actor, null, sessionId, key);
    }

    // A subjectless principal keeps the pre-ownership operation identity so
    // keys recorded before the subject column existed still replay; only an
    // actual subject joins the identity (the commandKey rule).
    private static String applyOperationId(String tenant, String actor,
            SessionPrincipal principal, String sessionId, String key) {
        StringBuilder identity = new StringBuilder("managed-extension-apply\0")
                .append(tenant).append('\0')
                .append(actor).append('\0');
        if (principal != null && principal.actorPresent()) {
            identity.append(principal.actorSubjectId()).append('\0');
        }
        return UUID.nameUUIDFromBytes(identity.append(sessionId).append('\0')
                .append(key).toString().getBytes(StandardCharsets.UTF_8)).toString();
    }

    public JsonNode submit(String tenant, String actor, String sessionId, String key, JsonNode command) {
        return submit(tenant, actor, null, sessionId, key, command);
    }

    public JsonNode submit(SessionPrincipal principal, String sessionId, String key,
            JsonNode command) {
        return submit(principal.tenantId(), principal.userId(), principal,
                sessionId, key, command);
    }

    private JsonNode submit(String tenant, String actor,
            SessionPrincipal principal, String sessionId, String key,
            JsonNode command) {
        ManagedAgentService.validateIdempotencyKey(key);
        if (command == null || !command.isObject() || command.size() != 2 || !command.has("extensions")
                || !command.path("expectedConfigRevision").isIntegralNumber()
                || !command.path("expectedConfigRevision").canConvertToLong()
                || command.path("expectedConfigRevision").longValue() < 0
                || command.path("expectedConfigRevision").longValue() > 9_007_199_254_740_990L) {
            throw invalid();
        }
        try {
            ManagedConfigInstall.pins(command.get("extensions"));
        } catch (ManagedExtensionRecords.InvalidRecordException error) {
            throw invalid();
        }
        String operationId = applyOperationId(tenant, actor, principal, sessionId, key);
        // The unified ownership fence governs the principal twin too: the
        // raw-actor visibility check inside requireExtensionManagement cannot
        // substitute for it (R13-1).
        if (principal == null) {
            sessions.requireReadableSession(tenant, actor, sessionId);
        } else {
            sessions.requireReadableSession(principal, sessionId);
        }
        SessionRecord session = store.requireExtensionManagement(tenant, actor, sessionId, operationId, false);
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("operationId", operationId);
        request.put("actorKey", DigestUtils.sha256Hex(actor));
        request.put("expectedRevision", command.get("expectedConfigRevision").asLong());
        request.put("extensions", json.convertValue(command.get("extensions"), List.class));
        JsonNode previous = records.currentMcpSettings(tenant, sessionId);
        for (int step = 0; ManagedConfigInstall.isPackageConfig(previous); step++) {
            if (operationId.equals(previous.path("operationId").asText())) {
                if (!sameCommand(request, previous.get("command"))) {
                    throw new ManagedAgentException(409, "idempotency_conflict", "The extension operation key was used for another request.");
                }
                return principal == null
                        ? query(tenant, actor, sessionId, operationId)
                        : query(principal, sessionId, operationId);
            }
            if (step >= 4095 || previous.path("previousRecordRef").isNull()) {
                break;
            }
            previous = read(tenant, sessionId, previous.get("previousRecordRef"));
        }
        session = store.requireExtensionManagement(tenant, actor, sessionId, operationId, true);
        packages.requireExecutionAccess(tenant, actor, session.workspace().getWorkspaceId());
        if (!harness.supportsSessionExtensions()) {
            throw unsupported();
        }
        List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> pins = json.convertValue(command.get("extensions"), json.getTypeFactory().constructCollectionType(
                List.class, com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin.class));
        packages.authorizeSelection(tenant, actor, session.workspace().getWorkspaceId(), pins);
        return invoke(() -> harness.applyExtensions(tenant, sessionId, request), sessionId, operationId);
    }

    private boolean sameCommand(Map<String, Object> request, JsonNode saved) {
        try {
            return json.readTree(json.writeValueAsBytes(request)).equals(saved);
        } catch (java.io.IOException error) {
            throw corrupt();
        }
    }

    public JsonNode resume(String tenant, String actor, String sessionId, String operationId, boolean recoverPrevious) {
        return resume(tenant, actor, null, sessionId, operationId,
                recoverPrevious);
    }

    public JsonNode resume(SessionPrincipal principal, String sessionId,
            String operationId, boolean recoverPrevious) {
        return resume(principal.tenantId(), principal.userId(), principal,
                sessionId, operationId, recoverPrevious);
    }

    private JsonNode resume(String tenant, String actor,
            SessionPrincipal principal, String sessionId,
            String operationId, boolean recoverPrevious) {
        if (!ManagedConfigInstall.uuid(operationId)) {
            throw invalid();
        }
        if (principal == null) {
            sessions.requireReadableSession(tenant, actor, sessionId);
        } else {
            sessions.requireReadableSession(principal, sessionId);
        }
        SessionRecord session = store.requireExtensionManagement(tenant,
                actor, sessionId, operationId, true);
        JsonNode current = records.currentMcpSettings(tenant,
                sessionId);
        if (!ManagedConfigInstall.isPackageConfig(current) || !operationId.equals(current.path("operationId").asText())) {
            throw missing();
        }
        if (!harness.supportsSessionExtensions() || session.workspace() == null) {
            throw unsupported();
        }
        packages.requireExecutionAccess(tenant, actor,
                session.workspace().getWorkspaceId());
        return invoke(() -> harness.continueExtensionOperation(tenant,
                sessionId, operationId, recoverPrevious), sessionId, operationId);
    }

    private ObjectNode snapshot(String tenant, String sessionId, JsonNode body, boolean supported) {
        String phase = body.path("phase").asText();
        boolean committed = Set.of("committed", "active", "recovery_required").contains(phase);
        ObjectNode result = empty(sessionId, supported);
        result.put("revision", body.path(committed ? "configRevision" : "previousConfigRevision").asLong());
        JsonNode requestedRef = "recoverPrevious".equals(body.path("mode").asText()) && "preparing".equals(phase)
                ? body.path("restoresBundleRef") : body.path("bundleRef");
        result.set("requestedExtensions", requestedRef.isNull() ? body.path("command").get("extensions") : bundlePins(tenant, sessionId, requestedRef));
        JsonNode active = body;
        for (int step = 0; step < 4096; step++) {
            if ("active".equals(active.path("phase").asText())) {
                result.set("extensions", bundlePins(tenant, sessionId, active.get("bundleRef")));
                break;
            }
            if (active.path("previousRecordRef").isNull()) {
                break;
            }
            active = read(tenant, sessionId, active.get("previousRecordRef"));
            if (!ManagedConfigInstall.isPackageConfig(active)) {
                break;
            }
        }
        ObjectNode operation = result.putObject("operation").put("operationId", body.path("operationId").asText())
                .put("state", phase).put("mode", body.path("mode").asText()).put("revision", body.path("configRevision").asLong());
        if (!body.path("error").isNull()) {
            operation.set("error", body.get("error"));
        }
        return result;
    }

    private ArrayNode bundlePins(String tenant, String sessionId, JsonNode ref) {
        JsonNode bundle = read(tenant, sessionId, ref);
        if (!"managed-extension-config-bundle".equals(bundle.path("kind").asText()) || !bundle.path("packages").isArray()) {
            throw corrupt();
        }
        ArrayNode pins = json.createArrayNode();
        for (JsonNode entry : bundle.get("packages")) {
            pins.add(entry.get("pin"));
        }
        try {
            ManagedConfigInstall.pins(pins);
        } catch (ManagedExtensionRecords.InvalidRecordException error) {
            throw corrupt();
        }
        return pins;
    }

    private JsonNode read(String tenant, String sessionId, JsonNode ref) {
        var resource = records.readCommittedResource(tenant, sessionId, ref);
        JsonNode value = ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
        if (value == null) {
            throw corrupt();
        }
        return value;
    }

    private ObjectNode empty(String sessionId, boolean supported) {
        ObjectNode result = json.createObjectNode().put("sessionId", sessionId).put("supported", supported).put("revision", 0);
        result.putArray("extensions");
        result.putArray("requestedExtensions");
        return result;
    }

    private JsonNode invoke(Supplier<Map<String, Object>> request, String sessionId, String operationId) {
        try {
            JsonNode result = json.valueToTree(request.get());
            if (!sessionId.equals(result.path("sessionId").asText()) || !operationId.equals(result.path("operation").path("operationId").asText())) {
                throw corrupt();
            }
            return result;
        } catch (HarnessHttpFailure error) {
            org.springframework.http.HttpStatus status = org.springframework.http.HttpStatus.resolve(error.getStatusCode());
            if (status != null && status.is4xxClientError() && error.getErrorCode() != null
                    && error.getErrorCode().matches("[a-z][a-z0-9_]{0,127}")) {
                throw new ManagedAgentException(status.value(), error.getErrorCode(), "Extension configuration was refused.");
            }
            throw unavailable();
        } catch (HarnessFailure error) {
            throw unavailable();
        }
    }

    private static ManagedAgentException invalid() { return new ManagedAgentException(400, "invalid_request", "Invalid extension configuration."); }
    private static ManagedAgentException missing() { return new ManagedAgentException(404, "extension_operation_not_found", "The extension operation was not found."); }
    private static ManagedAgentException corrupt() { return new ManagedAgentException(409, "session_config_corrupt", "The saved configuration cannot be verified."); }
    private static ManagedAgentException unsupported() { return new ManagedAgentException(409, "unsupported_feature", "Extension configuration is unavailable."); }
    private static ManagedAgentException unavailable() { return new ManagedAgentException(503, "session_config_outcome_unknown", "Query or continue the original extension operation."); }
}
