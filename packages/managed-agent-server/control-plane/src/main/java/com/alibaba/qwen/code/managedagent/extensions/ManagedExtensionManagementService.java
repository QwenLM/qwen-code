package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
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
        SessionRecord session = sessions.requireReadableSession(tenant, actor, sessionId);
        if (session.workspace() == null) {
            return empty(sessionId, false);
        }
        boolean supported = packages.list(tenant, actor, session.workspace().getWorkspaceId()).supported()
                && harness.supportsSessionExtensions();
        JsonNode latest = records.currentMcpSettings(tenant, sessionId);
        if (!ManagedConfigInstall.isPackageConfig(latest)) {
            if (operationId != null) {
                throw missing();
            }
            return empty(sessionId, supported);
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
        return snapshot(tenant, sessionId, selected, supported);
    }

    public JsonNode submit(String tenant, String actor, String sessionId, String key, JsonNode command) {
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
        String operationId = UUID.nameUUIDFromBytes(("managed-extension-apply\0" + tenant + "\0" + actor + "\0" + sessionId + "\0" + key)
                .getBytes(StandardCharsets.UTF_8)).toString();
        SessionRecord session = store.requireExtensionManagement(tenant, actor, sessionId, operationId, true);
        packages.requireExecutionAccess(tenant, actor, session.workspace().getWorkspaceId());
        if (!harness.supportsSessionExtensions()) {
            throw unsupported();
        }
        for (JsonNode pin : command.get("extensions")) {
            packages.get(tenant, actor, session.workspace().getWorkspaceId(), pin.get("extensionId").asText(),
                    pin.get("packageRevision").asLong(), pin.get("packageDigest").asText());
        }
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("operationId", operationId);
        request.put("actorKey", DigestUtils.sha256Hex(actor));
        request.put("expectedRevision", command.get("expectedConfigRevision").asLong());
        request.put("extensions", json.convertValue(command.get("extensions"), List.class));
        return invoke(() -> harness.applyExtensions(tenant, sessionId, request), sessionId, operationId);
    }

    public JsonNode resume(String tenant, String actor, String sessionId, String operationId, boolean recoverPrevious) {
        if (!ManagedConfigInstall.uuid(operationId)) {
            throw invalid();
        }
        SessionRecord session = store.requireExtensionManagement(tenant, actor, sessionId, operationId, true);
        JsonNode current = records.currentMcpSettings(tenant, sessionId);
        if (!ManagedConfigInstall.isPackageConfig(current) || !operationId.equals(current.path("operationId").asText())) {
            throw missing();
        }
        if (!harness.supportsSessionExtensions() || session.workspace() == null) {
            throw unsupported();
        }
        packages.requireExecutionAccess(tenant, actor, session.workspace().getWorkspaceId());
        return invoke(() -> harness.continueExtensionOperation(tenant, sessionId, operationId, recoverPrevious), sessionId, operationId);
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
        JsonNode value = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
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
