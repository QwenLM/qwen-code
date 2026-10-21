package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionSkills;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:session-creation-skills;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa",
        "spring.datasource.password=", "qwen.managed-agent.harness.enabled=false"
})
@AutoConfigureMockMvc
class ManagedSessionCreationSkillsTest {
    @Autowired private MockMvc mvc;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Autowired private ManagedAgentStore store;
    @Autowired private ManagedSessionSkills snapshots;
    @MockitoBean private HarnessConnector harness;
    private String tenant;
    private final Map<String, Object> skill = Map.of("name", "review", "description", "Review changes",
            "body", "ORIGINAL_INSTRUCTIONS", "base_directory", "docs");

    @BeforeEach
    void setup() {
        tenant = "skills-" + UUID.randomUUID();
        when(harness.supportsSessionSkills()).thenReturn(true);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?, 'ws', 1, 'storage', 'Test', 'config', 'policy', 'ACTIVE')", tenant);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'ws', ?, 'OPERATOR')",
                tenant, "actor".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void builtinSnapshotParticipatesInIdempotencyAndMetadataCatalog() throws Exception {
        var body = request("qwen-code", List.of(skill));
        String session = create(body, "key", true).get("sessionId").asText();
        assertThat(create(body, "key", true).get("sessionId").asText()).isEqualTo(session);
        assertThat(snapshots.effective(store.requireSession(tenant, session))).containsExactly(skill);
        mvc.perform(post("/api/agent/web-shell/v1/session-skills/query").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsBytes(Map.of("sessionId", session))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.skills[0].name").value("review"))
                .andExpect(jsonPath("$.skills[0].body").doesNotExist());
        ((com.fasterxml.jackson.databind.node.ObjectNode) body.withArray("skills").get(0)).put("body", "CHANGED");
        submit(body, "key", true).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        when(harness.supportsSessionSkills()).thenReturn(false);
        create(request("qwen-code", List.of(skill)), "key", true);
        assertThat(snapshots.effective(store.requireSession(tenant, session))).containsExactly(skill);
        jdbc.update("UPDATE ma_request_receipt SET result_json = REPLACE(result_json, 'ORIGINAL_INSTRUCTIONS', 'TAMPERED')"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        assertThatThrownBy(() -> snapshots.effective(store.requireSession(tenant, session)))
                .hasMessageContaining("snapshot is invalid");
    }

    @Test
    void importsTheFullEnabledCatalogAndPreservesInvocationPolicy() throws Exception {
        var skills = new java.util.ArrayList<Map<String, Object>>();
        for (int i = 0; i < 42; i++) {
            var entry = new java.util.LinkedHashMap<String, Object>();
            entry.put("name", "enabled-" + i);
            entry.put("description", "Enabled Skill");
            entry.put("body", i == 0 ? "x".repeat(404465) : "Instruction");
            if (i == 1) {
                entry.put("model_invocable", false);
            }
            if (i == 2) {
                entry.put("user_invocable", false);
            }
            skills.add(entry);
        }
        String session = create(request("qwen-code", skills), "full-catalog", true).get("sessionId").asText();
        assertThat(snapshots.effective(store.requireSession(tenant, session))).isEqualTo(skills);
        mvc.perform(post("/api/agent/web-shell/v1/session-skills/query").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsBytes(Map.of("sessionId", session))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.skills.length()").value(41))
                .andExpect(result -> assertThat(OpenApiContract.load().validate(
                        "/components/schemas/WebShellSessionSkills",
                        json.readTree(result.getResponse().getContentAsString()))).isEmpty());
    }

    @Test
    void customDefinitionMergesAndPinsWithoutChangingItsIdentity() throws Exception {
        var definition = json.createObjectNode();
        definition.putObject("model");
        definition.put("instructions", "");
        definition.putArray("tools").addObject().put("type", "hosted_profile").put("profile", "hosted-workspace-files/1");
        definition.putObject("permission_policy");
        definition.set("skills", json.valueToTree(List.of(Map.of("name", "default", "description", "Default", "body", "DEFAULT"))));
        var created = mvc.perform(post("/v1/agents").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "definition")
                        .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(definition)))
                .andExpect(status().isAccepted()).andReturn();
        var agent = json.readTree(created.getResponse().getContentAsString());
        String session = create(request(agent.get("id").asText(), List.of(skill)), "custom", false).get("id").asText();
        assertThat(snapshots.effective(store.requireSession(tenant, session))).hasSize(2);
        assertThat(store.requireSession(tenant, session).agentDefinitionDigest()).isEqualTo(agent.get("digest").asText());
        var duplicate = Map.<String, Object>of("name", "default", "description", "Duplicate", "body", "duplicate");
        submit(request(agent.get("id").asText(), List.of(duplicate)), "duplicate", false)
                .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?", Long.class, tenant)).isEqualTo(1);
    }

    @Test
    void refusesUnsupportedUnauthorizedAndInvalidRequestsBeforeCreatingAnything() throws Exception {
        var body = request("qwen-code", List.of(skill));
        when(harness.supportsSessionSkills()).thenReturn(false);
        submit(body, "unsupported", true).andExpect(status().isConflict());
        when(harness.supportsSessionSkills()).thenReturn(true);
        submit(request("qwen-code", List.of(skill, skill)), "duplicate", true).andExpect(status().isConflict());
        var unbound = request("qwen-code", List.of(skill));
        unbound.remove("workspace");
        submit(unbound, "unbound", true).andExpect(status().isBadRequest());
        mvc.perform(post("/api/agent/web-shell/v1/sessions/create").principal(actor("outsider"))
                        .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsBytes(body.put("idempotencyKey", "outsider"))))
                .andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?", Long.class, tenant)).isZero();
    }

    private com.fasterxml.jackson.databind.node.ObjectNode request(String agent, List<Map<String, Object>> skills) {
        var request = json.createObjectNode().put("agentId", agent).put("agent_id", agent);
        request.putArray("input");
        request.putObject("workspace").put("workspaceId", "ws");
        request.set("skills", json.valueToTree(skills));
        return request;
    }

    private JsonNode create(com.fasterxml.jackson.databind.node.ObjectNode body, String key, boolean web) throws Exception {
        return json.readTree(submit(body, key, web).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());
    }

    private org.springframework.test.web.servlet.ResultActions submit(com.fasterxml.jackson.databind.node.ObjectNode body,
            String key, boolean web) throws Exception {
        var value = body.deepCopy();
        value.remove(web ? "agent_id" : "agentId");
        if (web) {
            value.put("idempotencyKey", key);
        } else if (value.has("workspace")) {
            value.withObject("workspace").remove("workspaceId");
            value.withObject("workspace").put("workspace_id", "ws");
        }
        return mvc.perform(post(web ? "/api/agent/web-shell/v1/sessions/create" : "/v1/agents/sessions")
                .principal(actor("actor")).header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(value)));
    }

    private AuthenticatedTenantActor actor(String id) {
        return new AuthenticatedTenantActor() {
            @Override public String tenantId() { return tenant; }
            @Override public String actorId() { return id; }
            @Override public String getName() { return id; }
        };
    }
}
