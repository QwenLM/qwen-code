package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

/**
 * AgentDefinition revisions (D8a): creation and replay, append-only
 * revisions with an unchanged update adding none, revision reads, the
 * idempotency conflicts, tenant scope and request validation.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-agent-definition;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
@AutoConfigureMockMvc
@Import(ManagedAgentServerIntegrationTest.FixtureConfiguration.class)
class ManagedAgentDefinitionTest {
    private static final String TENANT = TenantContextFilter.HEADER;
    private static final String DEFINITION = """
            {"model":{"id":"qwen3-coder-plus","temperature":0},
             "instructions":"Review the change.",
             "tools":[{"name":"read_file"}],
             "permission_policy":{"mode":"default"},
             "metadata":{"team":"review"}}
            """;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void createsAndReplaysTheFirstRevision() throws Exception {
        String tenant = tenant();
        JsonNode created = json(create(tenant, "create-1", DEFINITION)
                .andExpect(status().isAccepted())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "false")));
        assertThat(created.get("id").asText()).matches("agent_[0-9a-f]{32}");
        assertThat(created.get("object").asText()).isEqualTo("agent");
        assertThat(created.get("revision").asText()).isEqualTo("1");
        assertThat(created.get("digest").asText()).matches("[0-9a-f]{64}");
        assertThat(created.at("/metadata/team").asText()).isEqualTo("review");

        JsonNode replayed = json(create(tenant, "create-1", DEFINITION)
                .andExpect(status().isAccepted())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "true")));
        assertThat(replayed).isEqualTo(created);
        assertThat(rows(tenant)).isEqualTo(1);
    }

    @Test
    void appendsARevisionOnlyWhenTheContentChanges() throws Exception {
        String tenant = tenant();
        JsonNode first = json(create(tenant, "create", DEFINITION)
                .andExpect(status().isAccepted()));
        String agentId = first.get("id").asText();

        // Same content, reordered keys: no new revision.
        JsonNode same = json(update(tenant, agentId, "same", """
                {"permission_policy":{"mode":"default"},
                 "tools":[{"name":"read_file"}],
                 "metadata":{"team":"review"},
                 "instructions":"Review the change.",
                 "model":{"temperature":0,"id":"qwen3-coder-plus"}}
                """).andExpect(status().isAccepted()));
        assertThat(same.get("revision").asText()).isEqualTo("1");
        assertThat(same.get("digest")).isEqualTo(first.get("digest"));
        assertThat(rows(tenant)).isEqualTo(1);

        JsonNode second = json(update(tenant, agentId, "changed",
                DEFINITION.replace("Review the change.", "Review it twice."))
                .andExpect(status().isAccepted()));
        assertThat(second.get("id").asText()).isEqualTo(agentId);
        assertThat(second.get("revision").asText()).isEqualTo("2");
        assertThat(second.get("digest")).isNotEqualTo(first.get("digest"));
        assertThat(rows(tenant)).isEqualTo(2);

        assertThat(json(read(tenant, agentId, null)
                .andExpect(status().isOk())).get("revision").asText())
                .isEqualTo("2");
        assertThat(json(read(tenant, agentId, "1")
                .andExpect(status().isOk())).get("digest"))
                .isEqualTo(first.get("digest"));
        for (String missing : new String[] {"3", "0", "01", "latest"}) {
            read(tenant, agentId, missing).andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.error.code").value("agent_not_found"));
        }
    }

    @Test
    void absentAndNullOptionalFieldsStoreTheSameContent() throws Exception {
        String tenant = tenant();
        JsonNode absent = json(create(tenant, "absent", DEFINITION)
                .andExpect(status().isAccepted()));
        JsonNode explicit = json(create(tenant, "explicit",
                DEFINITION.replace("\"metadata\"",
                        "\"skills\":null,\"mcp_servers\":null,\"metadata\""))
                .andExpect(status().isAccepted()));
        assertThat(explicit.get("id")).isNotEqualTo(absent.get("id"));
        assertThat(explicit.get("digest")).isEqualTo(absent.get("digest"));
    }

    @Test
    void refusesAReusedKeyWithADifferentRequest() throws Exception {
        String tenant = tenant();
        String agentId = json(create(tenant, "key", DEFINITION)
                .andExpect(status().isAccepted())).get("id").asText();
        create(tenant, "key", DEFINITION.replace("review\"}", "other\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        // The create command owns the key, so an update cannot reuse it.
        update(tenant, agentId, "key", DEFINITION)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        // The request digest covers the agent ID: an update key reused on
        // another agent with the same body conflicts instead of replaying
        // the first agent's revision.
        String otherId = json(create(tenant, "other", DEFINITION)
                .andExpect(status().isAccepted())).get("id").asText();
        update(tenant, agentId, "update-key", DEFINITION)
                .andExpect(status().isAccepted());
        update(tenant, otherId, "update-key", DEFINITION)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        assertThat(rows(tenant)).isEqualTo(2);
    }

    @Test
    void scopesDefinitionsToTheirTenant() throws Exception {
        String tenant = tenant();
        String other = tenant();
        String agentId = json(create(tenant, "scoped", DEFINITION)
                .andExpect(status().isAccepted())).get("id").asText();
        read(other, agentId, null).andExpect(status().isNotFound());
        update(other, agentId, "scoped", DEFINITION)
                .andExpect(status().isNotFound());
        // The same key in another tenant is a separate command.
        create(other, "scoped", DEFINITION).andExpect(status().isAccepted())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "false"));
        // Only server-generated IDs name a definition.
        read(tenant, "qwen-code", null).andExpect(status().isNotFound());
        update(tenant, "qwen-code", "named", DEFINITION)
                .andExpect(status().isNotFound());
        mvc.perform(post("/v1/agents").header("Idempotency-Key", "no-tenant")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(DEFINITION))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_tenant"));
    }

    @Test
    void scopesMatrixParametersBeforeDefinitionAdmission() throws Exception {
        String tenant = tenant();
        String path = "/v1/agents;jsessionid=abc";
        mvc.perform(post(path).header("Idempotency-Key", "matrix")
                        .contentType(MediaType.APPLICATION_JSON).content(DEFINITION))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_tenant"));
        assertThat(rows(tenant)).isZero();
        mvc.perform(post(path).header(TENANT, tenant)
                        .header("Idempotency-Key", "matrix")
                        .contentType(MediaType.APPLICATION_JSON).content(DEFINITION))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.revision").value("1"));
        assertThat(rows(tenant)).isEqualTo(1);
    }

    @Test
    void validatesTheRequest() throws Exception {
        String tenant = tenant();
        create(tenant, "bad key", DEFINITION)
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("invalid_idempotency_key"));
        create(tenant, "no-instructions",
                DEFINITION.replace("\"instructions\":\"Review the change.\",", ""))
                .andExpect(status().isBadRequest());
        create(tenant, "no-tools",
                DEFINITION.replace("\"tools\":[{\"name\":\"read_file\"}],", ""))
                .andExpect(status().isBadRequest());
        // Array items must be objects; a null item is refused, not stored.
        create(tenant, "null-tool", DEFINITION.replace(
                "[{\"name\":\"read_file\"}]", "[null]"))
                .andExpect(status().isBadRequest());
        for (String field : new String[] {"skills", "mcp_servers"}) {
            create(tenant, "null-" + field, DEFINITION.replace("\"metadata\"",
                    "\"" + field + "\":[null],\"metadata\""))
                    .andExpect(status().isBadRequest());
        }
        assertThat(rows(tenant)).isZero();
    }

    private ResultActions create(String tenant, String key, String body)
            throws Exception {
        return mvc.perform(post("/v1/agents").header(TENANT, tenant)
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).content(body));
    }

    private ResultActions update(String tenant, String agentId, String key,
            String body) throws Exception {
        return mvc.perform(post("/v1/agents/{id}", agentId)
                .header(TENANT, tenant).header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).content(body));
    }

    private ResultActions read(String tenant, String agentId, String revision)
            throws Exception {
        var request = get("/v1/agents/{id}", agentId).header(TENANT, tenant);
        if (revision != null) {
            request.param("revision", revision);
        }
        return mvc.perform(request);
    }

    private int rows(String tenant) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_definition"
                + " WHERE tenant_id = ?", Integer.class, tenant);
    }

    private JsonNode json(ResultActions result) throws Exception {
        return objectMapper.readTree(result.andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8));
    }

    private static String tenant() {
        return "tenant-agents-" + UUID.randomUUID();
    }
}
