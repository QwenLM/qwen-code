package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

@Repository
public class ManagedSessionSkills {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final RequestDigests digests;
    private final ManagedAgentDefinitionStore definitions;

    public ManagedSessionSkills(JdbcTemplate jdbc, ObjectMapper json,
            RequestDigests digests, ManagedAgentDefinitionStore definitions) {
        this.jdbc = jdbc;
        this.json = json;
        this.digests = digests;
        this.definitions = definitions;
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
        var rows = jdbc.query("SELECT result_json FROM ma_request_receipt WHERE namespace = 'SESSION_CREATE_ACTOR'"
                        + " AND tenant_key = ? AND tenant_id = ? AND session_id = ?",
                (row, index) -> row.getString("result_json"), ManagedSchemaKeys.key(tenant), tenant, session);
        if (rows.isEmpty()) {
            return null;
        }
        if (rows.size() != 1) {
            throw conflict();
        }
        return decode(rows.getFirst(), json, digests);
    }

    static List<Map<String, Object>> decode(String value, ObjectMapper json, RequestDigests digests) {
        if (value == null) {
            return null;
        }
        try {
            var snapshot = json.readValue(value, new TypeReference<Map<String, Object>>() { });
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
