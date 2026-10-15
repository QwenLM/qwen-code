package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:workspace-search-admission;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.harness.workspace-search-enabled=true"
})
@AutoConfigureMockMvc
class ManagedWorkspaceSearchAdmissionTest {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper json;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ManagedAgentStore sessions;

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void bothCreationSurfacesPersistSearchProfileAndReuseTheReceipt(boolean webShell) throws Exception {
        String tenant = "search-" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage',"
                + " 'Workspace', ?, ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "owner".getBytes(StandardCharsets.UTF_8));
        String route = webShell ? "/api/agent/web-shell/v1/sessions/create" : "/v1/agents/sessions";
        Map<String, Object> body = webShell
                ? Map.of("idempotencyKey", "create", "agentId", "qwen-code", "input", java.util.List.of(),
                        "workspace", Map.of("workspaceId", "workspace", "cwdRelative", "."))
                : Map.of("agent_id", "qwen-code", "input", java.util.List.of(),
                        "workspace", Map.of("workspace_id", "workspace", "cwd_relative", "."));
        String sessionId = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            var result = mvc.perform(post(route).header(TenantContextFilter.HEADER, tenant)
                    .header("Idempotency-Key", "create")
                    .principal(new AuthenticatedTenantActor() {
                        @Override public String tenantId() { return tenant; }
                        @Override public String actorId() { return "owner"; }
                        @Override public String getName() { return "owner"; }
                    })
                    .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
                    .andExpect(status().isAccepted()).andReturn();
            String returned = json.readTree(result.getResponse().getContentAsString())
                    .path(webShell ? "sessionId" : "id").asText();
            if (sessionId == null) {
                sessionId = returned;
            }
            assertThat(returned).isEqualTo(sessionId).isNotBlank();
            var session = sessions.requireSession(tenant, returned);
            assertThat(session.toolProfile()).isEqualTo(WorkspaceToolProfiles.FILES_SEARCH);
            assertThat(session.workspace().getWorkspaceId()).isEqualTo("workspace");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?",
                Integer.class, tenant)).isOne();
    }
}
