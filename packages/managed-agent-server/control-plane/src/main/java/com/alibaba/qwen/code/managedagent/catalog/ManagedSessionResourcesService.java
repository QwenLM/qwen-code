package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedMcpRecords;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class ManagedSessionResourcesService {
    private static final int MAX_CONFIG_RECORDS = 64;
    private static final int MAX_MCP_RECORDS = 256;
    private static final int MAX_READ_BYTES = 8 * 1024 * 1024;
    private static final int MAX_OUTPUT_BYTES = 1024 * 1024;
    private static final long MAX_REVISION = 9_007_199_254_740_991L;
    private static final List<String> CAPABILITIES = List.of("tools", "resources", "prompts");
    private final ManagedAgentService sessions;
    private final ManagedSessionSkills skills;
    private final ManagedAgentDefinitionStore definitions;
    private final ManagedExtensionRecordStore records;
    private final ObjectMapper json;
    private com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedResourceAccess resources;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void configureResourceAccess(com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedResourceAccess access) {
        this.resources = access;
    }

    public ManagedSessionResourcesService(ManagedAgentService sessions, ManagedSessionSkills skills,
            ManagedAgentDefinitionStore definitions, ManagedExtensionRecordStore records,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.sessions = sessions;
        this.skills = skills;
        this.definitions = definitions;
        this.records = records;
        this.json = json;
    }

    public JsonNode get(String tenant, String actor, String sessionId) {
        sessions.requireReadableSession(tenant, actor, sessionId);
        java.util.function.Supplier<JsonNode> read = () -> new Query(tenant, sessionId)
                .get(sessions.requireReadableSession(tenant, actor, sessionId));
        return resources == null ? read.get() : resources.readSnapshot(tenant, sessionId, read);
    }

    private final class Query {
        private final String tenant;
        private final String sessionId;
        private final ObjectNode result;
        private final ArrayNode reasons;
        private final ArrayNode skillItems;
        private final ArrayNode serverItems;
        private final Map<String, JsonNode> selected = new LinkedHashMap<>();
        private final Map<String, JsonNode> basePins = new LinkedHashMap<>();
        private final Map<String, String> extensions = new LinkedHashMap<>();
        private long remaining = MAX_READ_BYTES;

        Query(String tenant, String sessionId) {
            this.tenant = tenant;
            this.sessionId = sessionId;
            result = json.createObjectNode().put("schemaVersion", 1).put("sessionId", sessionId)
                    .put("readRevision", records.diagnosticReadRevision(tenant, sessionId))
                    .put("availability", "available").put("configCoverage", "complete").put("historyCoverage", "complete")
                    .putNull("activeConfigRevision").putNull("activeOperationPhase").put("outputTruncated", false);
            reasons = result.putArray("coverageReasons");
            skillItems = result.putArray("skills");
            serverItems = result.putArray("servers");
        }

        JsonNode get(SessionRecord session) {
            if (session.workspace() == null || WorkspaceToolProfiles.READ.equals(session.toolProfile())) {
                return result.put("availability", "unsupported");
            }
            attempt("configCoverage", () -> {
                JsonNode catalog = json.valueToTree(skills.effective(session));
                charge(bytes(catalog));
                appendSkills(catalog, "skill", null);
                if (session.agentDefinitionDigest() != null) {
                    Map<String, Object> definition = definitions.pinnedContent(session);
                    charge(bytes(json.valueToTree(definition)));
                    for (Map<String, Object> pin : AgentDefinitionExtensions.mcpServers(definition.get("mcp_servers"), session.toolProfile())) {
                        JsonNode node = json.valueToTree(pin);
                        basePins.put(node.path("serverId").asText(), node);
                    }
                }
                configuration();
            });
            Map<String, JsonNode> attempts = new LinkedHashMap<>();
            Map<String, JsonNode> published = new LinkedHashMap<>();
            List<JsonNode> refs = records.diagnosticMcpRecordRefs(tenant, sessionId, MAX_MCP_RECORDS + 1);
            if (refs.size() > MAX_MCP_RECORDS) {
                partial("historyCoverage", "mcp_history_limit");
            }
            for (JsonNode ref : refs.subList(0, Math.min(refs.size(), MAX_MCP_RECORDS))) {
                if (remaining == 0) {
                    partial("historyCoverage", "resource_read_limit");
                    break;
                }
                attempt("historyCoverage", () -> {
                    JsonNode record = read(ref, "managed-mcp_configuration");
                    ManagedMcpRecords.requireConfiguration(record);
                    ManagedExtensionRecords.count(record.get("configRevision"), 1, MAX_REVISION, "MCP attempt revision");
                    ManagedExtensionRecords.count(record.get("serverRevision"), 1, MAX_REVISION, "MCP server revision");
                    if (record.hasNonNull("catalogRevision")) {
                        ManagedExtensionRecords.count(record.get("catalogRevision"), 1, MAX_REVISION, "MCP catalog revision");
                    }
                    String server = record.path("serverId").asText();
                    if (selected.containsKey(server)) {
                        attempts.merge(server, record, ManagedSessionResourcesService::newer);
                        if (record.hasNonNull("catalogRef")) {
                            published.merge(server, record, (previous, next) -> {
                                boolean before = samePin(selected.get(server), previous);
                                return before != samePin(selected.get(server), next) ? before ? previous : next : newer(previous, next);
                            });
                        }
                    }
                });
            }
            for (var entry : selected.entrySet()) {
                JsonNode pin = entry.getValue();
                String extension = extensions.get(entry.getKey());
                ObjectNode server = serverItems.addObject().put("serverId", entry.getKey())
                        .put("serverRevision", pin.path("serverRevision").asLong()).put("extensionId", extension)
                        .put("origin", extension != null ? "extension" : pinMatches(basePins.get(entry.getKey()), pin) ? "base" : "independent")
                        .put("selectionState", pin.path("state").asText("enabled")).put("liveState", "unknown")
                        .putNull("catalogRevision").putNull("catalogServerRevision").putNull("attemptRevision").putNull("attemptServerRevision")
                        .putNull("lastAttemptState").putNull("lastExecutionState").putNull("releaseState").put("historical", false);
                ObjectNode discovery = server.putObject("discovery");
                for (String kind : CAPABILITIES) {
                    server.putArray(kind);
                    discovery.put(kind, "unknown");
                }
                JsonNode latest = attempts.get(entry.getKey());
                if (latest != null) {
                    server.set("attemptRevision", latest.get("configRevision"));
                    server.set("attemptServerRevision", latest.get("serverRevision"));
                    server.set("lastAttemptState", latest.path("run").get("state"));
                    server.set("lastExecutionState", latest.path("run").get("execution"));
                    server.set("releaseState", latest.get("releaseState"));
                }
                JsonNode catalog = published.get(entry.getKey());
                if (catalog != null) {
                    attempt("historyCoverage", () -> catalog(server, pin, latest, catalog));
                }
            }
            boundOutput();
            if ("partial".equals(result.path("historyCoverage").asText())) {
                for (JsonNode server : serverItems) {
                    ((ObjectNode) server).put("historical", true).putNull("attemptRevision").putNull("attemptServerRevision")
                            .putNull("lastAttemptState").putNull("lastExecutionState").putNull("releaseState");
                    for (String kind : CAPABILITIES) {
                        if (!"unknown".equals(server.path("discovery").path(kind).asText())) {
                            ((ObjectNode) server.get("discovery")).put(kind, "stale");
                        }
                    }
                }
            }
            return result;
        }

        private void configuration() {
            var latest = records.diagnosticConfigRef(tenant, sessionId);
            if (latest.isEmpty()) {
                selected.putAll(basePins);
                return;
            }
            JsonNode current = read(latest.get(), "managed-config_install");
            if (!ManagedConfigInstall.isPackageConfig(current)) {
                require("hosted-mcp-settings".equals(current.path("kind").asText()), "Invalid MCP settings");
                select(current.path("servers"));
                return;
            }
            Set<String> seen = new HashSet<>();
            seen.add(latest.get().path("resourceId").asText());
            for (int count = 1; ; count++) {
                ManagedConfigInstall.require(current);
                if (count == 1) {
                    result.set("activeOperationPhase", current.get("phase"));
                }
                if ("active".equals(current.path("phase").asText())) {
                    bundle(current.get("bundleRef"));
                    return;
                }
                JsonNode previous = current.get("previousRecordRef");
                if (previous.isNull()) {
                    bundle(current.get("previousBundleRef"));
                    return;
                }
                if (count == MAX_CONFIG_RECORDS) {
                    partial("configCoverage", "configuration_history_limit");
                    return;
                }
                require(seen.add(previous.path("resourceId").asText()), "Configuration history cycle");
                JsonNode predecessor = read(previous, "managed-config_install");
                if (!ManagedConfigInstall.isPackageConfig(predecessor)) {
                    bundle(current.get("previousBundleRef"));
                    return;
                }
                current = predecessor;
            }
        }

        private void bundle(JsonNode ref) {
            if (ref == null || ref.isNull()) {
                selected.putAll(basePins);
                return;
            }
            JsonNode bundle = read(ref, "managed-extension-config-bundle");
            require("managed-extension-config-bundle".equals(bundle.path("kind").asText())
                    && bundle.path("formatVersion").asInt() == 1, "Invalid configuration bundle");
            result.put("activeConfigRevision", ManagedExtensionRecords.count(bundle.get("configRevision"), 0, MAX_REVISION, "Configuration revision"));
            select(bundle.path("independentMcpSelections"));
            require(bundle.path("packages").isArray() && bundle.path("packages").size() <= 32, "Invalid package list");
            for (JsonNode pkg : bundle.path("packages")) {
                attempt("configCoverage", () -> {
                    String extension = pkg.path("pin").path("extensionId").asText();
                    require(extension.matches("[A-Za-z0-9._:-]{1,128}"), "Invalid package identity");
                    JsonNode contributionRef = pkg.path("contributionsRef");
                    JsonNode manifest = read(contributionRef, "managed-extension-contributions");
                    long length = ManagedExtensionRecords.count(manifest.get("byteLength"), 1, 2 * 1024 * 1024, "Contribution length");
                    require(manifest.path("parts").isArray() && !manifest.path("parts").isEmpty()
                            && manifest.path("parts").size() <= 32, "Invalid contribution parts");
                    long partBytes = 0;
                    for (JsonNode part : manifest.path("parts")) {
                        ManagedExtensionRecords.durableRef(part, "Contribution part");
                        require("managed-extension-contributions-part".equals(part.path("kind").asText()), "Invalid contribution part kind");
                        partBytes += part.path("byteLength").asLong();
                    }
                    require(partBytes == length, "Contribution parts length conflicts");
                    charge(length + contributionRef.path("byteLength").asLong());
                    JsonNode contributions = records.readExtensionContributions(tenant, sessionId, contributionRef);
                    appendSkills(contributions.path("skills"), "skill", extension);
                    appendSkills(contributions.path("commands"), "command", extension);
                    require(contributions.path("mcpServers").isObject(), "Invalid package MCP servers");
                    contributions.path("mcpServers").fieldNames().forEachRemaining(name -> extensions.put(extension + ":" + name, extension));
                });
            }
            JsonNode effective = bundle.path("mcpServers");
            require(effective.isArray() && effective.size() <= 32, "Invalid effective MCP list");
            for (JsonNode pin : effective) {
                pin(pin);
                String id = pin.path("serverId").asText();
                if (!selected.containsKey(id)) {
                    if (extensions.containsKey(id)) {
                        selected.put(id, pin);
                    } else {
                        partial("configCoverage", "extension_attribution_unavailable");
                    }
                }
            }
        }

        private void select(JsonNode pins) {
            require(pins.isArray() && pins.size() <= 32, "Invalid MCP selections");
            for (JsonNode pin : pins) {
                pin(pin);
                require(Set.of("enabled", "disabled", "removed").contains(pin.path("state").asText()), "Invalid MCP selection state");
                selected.put(pin.path("serverId").asText(), pin);
            }
        }

        private void appendSkills(JsonNode entries, String kind, String extension) {
            require(entries.isArray(), "Invalid skill catalog");
            for (JsonNode skill : entries) {
                require(skill.path("name").isTextual() && skill.path("description").isTextual(), "Invalid skill metadata");
                skillItems.addObject().put("name", skill.path("name").asText()).put("description", skill.path("description").asText())
                        .put("kind", kind).put("origin", extension == null ? "base" : "extension").put("extensionId", extension)
                        .put("modelInvocable", "command".equals(kind) ? skill.path("modelInvocable").asBoolean(false) : skill.path("model_invocable").asBoolean(true))
                        .put("userInvocable", "command".equals(kind) || skill.path("user_invocable").asBoolean(true));
            }
        }

        private void catalog(ObjectNode server, JsonNode pin, JsonNode latest, JsonNode published) {
            JsonNode catalog = read(published.get("catalogRef"), "managed-mcp-catalog");
            for (String field : List.of("serverId", "serverRevision", "configRevision", "connectionGeneration", "catalogRevision")) {
                require(published.path(field).equals(catalog.path(field)), "MCP catalog identity conflicts");
            }
            require(published.path("run").path("definition").path("definitionDigest").equals(catalog.path("definitionDigest")), "MCP catalog pin conflicts");
            boolean historical = !samePin(pin, published) || latest != published
                    || !"enabled".equals(server.path("selectionState").asText()) || !"active".equals(published.path("releaseState").asText());
            server.put("historical", historical);
            server.set("catalogRevision", published.get("catalogRevision"));
            server.set("catalogServerRevision", published.get("serverRevision"));
            for (String kind : CAPABILITIES) {
                require(catalog.path(kind).isArray(), "Invalid MCP catalog capabilities");
                ArrayNode values = (ArrayNode) server.get(kind);
                for (JsonNode capability : catalog.path(kind)) {
                    require(capability.path("name").isTextual(), "Invalid MCP catalog metadata");
                    ObjectNode safe = values.addObject().put("name", capability.path("name").asText());
                    for (String field : List.of("description", "uri", "mimeType")) {
                        if (capability.path(field).isTextual()) {
                            safe.set(field, capability.get(field));
                        }
                    }
                }
                String state = catalog.path("discovery").path(kind).asText();
                require(Set.of("complete", "partial", "failed", "stale").contains(state), "Invalid MCP discovery state");
                ((ObjectNode) server.get("discovery")).put(kind, historical ? "stale" : state);
            }
        }

        private JsonNode read(JsonNode ref, String kind) {
            ManagedExtensionRecords.durableRef(ref, "Diagnostic reference");
            require(kind.equals(ref.path("kind").asText()) && ref.path("schemaVersion").asInt() == 1, "Invalid diagnostic resource kind");
            charge(ref.path("byteLength").asLong());
            var resource = records.readCommittedResource(tenant, sessionId, ref);
            JsonNode value = ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
            require(value != null, "Invalid diagnostic resource");
            return value;
        }

        private void charge(long length) {
            if (length < 0 || length > remaining) {
                remaining = 0;
                throw new ReadLimitException();
            }
            remaining -= length;
        }

        private void attempt(String coverage, Runnable read) {
            try {
                read.run();
            } catch (ReadLimitException error) {
                partial(coverage, "resource_read_limit");
            } catch (InvalidRecordException error) {
                partial(coverage, "invalid_resource");
            } catch (ManagedAgentException error) {
                if (error.getStatus() != 409) {
                    throw error;
                }
                partial(coverage, "resource_unavailable");
            }
        }

        private void partial(String coverage, String reason) {
            result.put(coverage, "partial").put("availability", "partial");
            for (JsonNode existing : reasons) {
                if (reason.equals(existing.asText())) {
                    return;
                }
            }
            reasons.add(reason);
        }

        private void boundOutput() {
            long size = bytes(result);
            if (size <= MAX_OUTPUT_BYTES) {
                return;
            }
            result.put("outputTruncated", true);
            while (!skillItems.isEmpty() && size > MAX_OUTPUT_BYTES - 4096) {
                size -= bytes(skillItems.remove(skillItems.size() - 1)) + 1L;
                partial("configCoverage", "public_output_limit");
            }
            for (JsonNode server : serverItems) {
                for (String kind : CAPABILITIES) {
                    ArrayNode values = (ArrayNode) server.get(kind);
                    while (!values.isEmpty() && size > MAX_OUTPUT_BYTES - 4096) {
                        size -= bytes(values.remove(values.size() - 1)) + 1L;
                        partial("historyCoverage", "public_output_limit");
                        ((ObjectNode) server.get("discovery")).put(kind, "partial");
                    }
                }
            }
        }
    }

    private int bytes(JsonNode node) {
        try {
            return json.writeValueAsBytes(node).length;
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Cannot encode resource diagnostics", error);
        }
    }

    private static void pin(JsonNode pin) {
        require(pin.path("serverId").asText().matches("[A-Za-z0-9._:-]{1,128}")
                && pin.path("definitionDigest").asText().matches("[a-f0-9]{64}"), "Invalid MCP pin");
        ManagedExtensionRecords.count(pin.get("serverRevision"), 1, MAX_REVISION, "MCP server revision");
    }

    private static boolean pinMatches(JsonNode left, JsonNode right) {
        return left != null && left.path("serverId").equals(right.path("serverId"))
                && left.path("serverRevision").asLong() == right.path("serverRevision").asLong()
                && left.path("definitionDigest").equals(right.path("definitionDigest"));
    }

    private static boolean samePin(JsonNode pin, JsonNode record) {
        return pin.path("serverRevision").asLong() == record.path("serverRevision").asLong()
                && pin.path("definitionDigest").equals(record.path("run").path("definition").path("definitionDigest"));
    }

    private static JsonNode newer(JsonNode left, JsonNode right) {
        return left.path("configRevision").asLong() >= right.path("configRevision").asLong() ? left : right;
    }

    private static void require(boolean value, String message) {
        if (!value) {
            throw new InvalidRecordException(message);
        }
    }

    private static final class ReadLimitException extends RuntimeException {
        private static final long serialVersionUID = 1L;
    }
}
