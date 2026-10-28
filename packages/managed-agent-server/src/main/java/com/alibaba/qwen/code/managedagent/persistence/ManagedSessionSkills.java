package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Repository
public class ManagedSessionSkills {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final RequestDigests digests;
    private final ManagedAgentDefinitionStore definitions;
    @org.springframework.beans.factory.annotation.Autowired
    @org.springframework.context.annotation.Lazy
    private ManagedExtensionRecordStore resources;

    public ManagedSessionSkills(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            RequestDigests digests, ManagedAgentDefinitionStore definitions) {
        this.jdbc = jdbc;
        this.json = json;
        this.digests = digests;
        this.definitions = definitions;
    }

    public List<Map<String, Object>> fromLaunchReference(String tenant, String session,
            com.fasterxml.jackson.databind.JsonNode ref) {
        if (ref.isNull()) {
            return null;
        }
        var resource = resources.readCommittedResource(tenant, session, ref);
        if (!"managed-agent-skills".equals(resource.kind()) || resource.schemaVersion() != 1) {
            throw conflict();
        }
        try {
            return AgentDefinitionExtensions.sessionSkills(json.readValue(resource.bytes(), new TypeReference<List<Map<String, Object>>>() { }));
        } catch (java.io.IOException error) {
            throw conflict();
        }
    }

    public List<Map<String, Object>> effective(SessionRecord session) {
        List<Map<String, Object>> saved = snapshot(session.tenantId(), session.sessionId());
        if (saved != null) {
            return saved;
        }
        return session.agentDefinitionDigest() == null ? List.of()
                : AgentDefinitionExtensions.skills(definitions.pinnedContent(session).get("skills"),
                        session.workspace() != null);
    }

    public List<Map<String, Object>> snapshot(String tenant, String session) {
        return decode(creationJson(tenant, session), json, digests);
    }

    private String creationJson(String tenant, String session) {
        var rows = jdbc.query("SELECT result_json FROM ma_request_receipt WHERE namespace = 'SESSION_CREATE_ACTOR'"
                        + " AND tenant_key = ? AND tenant_id = ? AND session_id = ?",
                (row, index) -> row.getString("result_json"), ManagedSchemaKeys.key(tenant), tenant, session);
        if (rows.isEmpty()) {
            return null;
        }
        if (rows.size() != 1) {
            throw conflict();
        }
        return rows.getFirst();
    }

    static List<Map<String, Object>> decode(String value, ObjectMapper json, RequestDigests digests) {
        if (value == null) {
            return null;
        }
        try {
            var snapshot = json.readValue(value, new TypeReference<Map<String, Object>>() { });
            if (Integer.valueOf(2).equals(snapshot.get("version"))) {
                requireCreationIntent(snapshot, json, digests);
                return snapshot.get("skills") == null ? null : AgentDefinitionExtensions.sessionSkills(snapshot.get("skills"));
            }
            if (!snapshot.keySet().equals(java.util.Set.of("version", "skills", "digest"))
                    || !Integer.valueOf(1).equals(snapshot.get("version"))) {
                throw conflict();
            }
            var skills = AgentDefinitionExtensions.sessionSkills(snapshot.get("skills"));
            if (skills.isEmpty() || !digests.digest(skills).equals(snapshot.get("digest"))) {
                throw conflict();
            }
            return skills;
        } catch (Exception error) {
            throw conflict();
        }
    }

    public Map<String, Object> initialSelection(String tenant, String session) {
        String value = creationJson(tenant, session);
        if (value == null) {
            return null;
        }
        try {
            var snapshot = json.readValue(value, new TypeReference<Map<String, Object>>() { });
            if (!Integer.valueOf(2).equals(snapshot.get("version"))) {
                decode(value, json, digests);
                return null;
            }
            Map<String, Object> command = requireCreationIntent(snapshot, json, digests);
            String identity = tenant + ":" + session;
            if (!ManagedConfigInstall.derivedOperationId("managed-extension-initial:", identity).equals(command.get("operationId"))
                    || !org.apache.commons.codec.digest.DigestUtils.sha256Hex("managed-extension-initial:" + identity).equals(command.get("actorKey"))) {
                throw conflict();
            }
            return command;
        } catch (java.io.IOException error) {
            throw conflict();
        }
    }

    public void saveInitialSelection(String tenant, String session,
            List<com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Pin> pins) {
        String previous = creationJson(tenant, session);
        List<Map<String, Object>> skills = decode(previous, json, digests);
        if (initialSelection(tenant, session) != null) {
            throw conflict();
        }
        String identity = tenant + ":" + session;
        Map<String, Object> command = Map.of("operationId", ManagedConfigInstall.derivedOperationId("managed-extension-initial:", identity),
                "actorKey", org.apache.commons.codec.digest.DigestUtils.sha256Hex("managed-extension-initial:" + identity),
                "expectedRevision", 0, "extensions", json.convertValue(pins, new TypeReference<List<Map<String, Object>>>() { }));
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("skills", skills);
        content.put("initialSelection", command);
        var snapshot = new LinkedHashMap<>(content);
        snapshot.put("version", 2);
        snapshot.put("digest", digests.digest(content));
        try {
            String value = json.writeValueAsString(snapshot);
            if (jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE namespace='SESSION_CREATE_ACTOR'"
                            + " AND tenant_key=? AND tenant_id=? AND session_id=? AND (result_json IS NULL OR result_json=?)",
                    value, ManagedSchemaKeys.key(tenant), tenant, session, previous) != 1) {
                throw conflict();
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException("Cannot save initial extension selection", error);
        }
    }

    private static Map<String, Object> requireCreationIntent(Map<String, Object> snapshot, ObjectMapper json, RequestDigests digests) {
        if (!snapshot.keySet().equals(java.util.Set.of("version", "skills", "initialSelection", "digest"))
                || !(snapshot.get("initialSelection") instanceof Map<?, ?> raw)) {
            throw conflict();
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> command = (Map<String, Object>) raw;
        if (!command.keySet().equals(java.util.Set.of("operationId", "actorKey", "expectedRevision", "extensions"))
                || !(command.get("operationId") instanceof String operation) || !operation.matches("[a-f0-9-]{36}")
                || !(command.get("actorKey") instanceof String actor) || !actor.matches("[a-f0-9]{64}")
                || !Integer.valueOf(0).equals(command.get("expectedRevision"))) {
            throw conflict();
        }
        ManagedConfigInstall.pins(json.valueToTree(command.get("extensions")));
        if (snapshot.get("skills") != null) {
            AgentDefinitionExtensions.sessionSkills(snapshot.get("skills"));
        }
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("skills", snapshot.get("skills"));
        content.put("initialSelection", command);
        if (!digests.digest(content).equals(snapshot.get("digest"))) {
            throw conflict();
        }
        return command;
    }

    public void save(String tenant, String session, List<Map<String, Object>> skills) {
        try {
            String value = json.writeValueAsString(Map.of("version", 1, "skills", skills,
                    "digest", digests.digest(skills)));
            if (jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE namespace = 'SESSION_CREATE_ACTOR'"
                            + " AND tenant_key = ? AND tenant_id = ? AND session_id = ? AND result_json IS NULL",
                    value, ManagedSchemaKeys.key(tenant), tenant, session) != 1) {
                throw conflict();
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException("Cannot save Session Skills", error);
        }
    }

    private static ManagedAgentException conflict() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "session_skills_conflict",
                "The immutable Session Skills snapshot is invalid.");
    }
}
