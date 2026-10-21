package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.session.SessionRenameCoordinator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-web-shell-rename;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=50ms",
        "qwen.managed-agent.events.poll-interval=10ms",
        "qwen.managed-agent.events.materialize-interval=10ms"
})
@AutoConfigureMockMvc
@Import(ManagedAgentServerIntegrationTest.FixtureConfiguration.class)
@MockitoBean(types = SessionRenameCoordinator.class)
class ManagedWebShellRenameTest {
    private static final String WEB_SHELL = "/api/agent/web-shell/v1";
    private static final String TENANT = TenantContextFilter.HEADER;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private FixtureHarness harness;

    @AfterEach
    void restoreHarness() {
        harness.setAvailable(true);
        harness.releaseHeldTurns();
    }

    @Test
    void confirmsAnEmptySessionRenameAndReplaysTheCurrentPersistedTitle() throws Exception {
        String tenant = tenant();
        String session = create(tenant, false);
        get(tenant, session).andExpect(jsonPath("$.capabilities.rename").value(true))
                .andExpect(jsonPath("$.activeTurn").doesNotExist());
        int sends = harness.renameCount();

        rename(tenant, session, "first", "first title")
                .andExpect(status().isOk())
                .andExpect(header().string("X-Request-Id", "rename-trace"))
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "false"))
                .andExpect(jsonPath("$.sessionId").value(session))
                .andExpect(jsonPath("$.title").value("first title"))
                .andExpect(jsonPath("$.replayed").value(false));
        assertThat(harness.title(session)).isEqualTo("first title");
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("first title");
        rename(tenant, session, "first", "conflicting title").andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        rename(tenant, session, "second", "second title").andExpect(status().isOk());

        harness.setAvailable(false);
        get(tenant, session).andExpect(jsonPath("$.capabilities.rename").value(false));
        rename(tenant, session, "offline", "third title").andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error.code").value("hosted_harness_disabled"));
        rename(tenant, session, "first", "first title")
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "true"))
                .andExpect(jsonPath("$.title").value("second title"))
                .andExpect(jsonPath("$.replayed").value(true));
        assertThat(harness.renameCount()).isEqualTo(sends + 2);

        jdbc.update("UPDATE ma_session SET status='DELETED', deleted_at=? WHERE tenant_id=? AND session_id=?",
                System.currentTimeMillis(), tenant, session);
        get(tenant, session).andExpect(status().isNotFound());
        rename(tenant, session, "first", "first title")
                .andExpect(status().isOk()).andExpect(jsonPath("$.title").value("second title"))
                .andExpect(jsonPath("$.replayed").value(true));
        rename(tenant, session, "fresh", "third title").andExpect(status().isNotFound());
        assertThat(harness.renameCount()).isEqualTo(sends + 2);
    }

    @Test
    void anActiveTurnDoesNotSuppressTheRenameCapabilityOrMutation() throws Exception {
        String tenant = tenant();
        String session = create(tenant, true);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                get(tenant, session).andExpect(jsonPath("$.capabilities.rename").value(true))
                        .andExpect(jsonPath("$.activeTurn.status").value("running")));
        rename(tenant, session, "active", "working title").andExpect(status().isOk());
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("working title");
        assertThat(harness.title(session)).isEqualTo("working title");
    }

    @Test
    void anUnknownHarnessOutcomeIsNeverACompletedResponseOrResent() throws Exception {
        String tenant = tenant();
        String session = create(tenant, false);
        harness.failNextRename();
        rename(tenant, session, "unknown", "pending title")
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error.code").value("hosted_harness_unavailable"));
        int sends = harness.renameCount();
        rename(tenant, session, "unknown", "pending title")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("operation_outcome_unknown"));
        assertThat(harness.renameCount()).isEqualTo(sends);
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("original");
    }

    @Test
    void retainsNamedValidationAndTenantIsolationErrors() throws Exception {
        String tenant = tenant();
        String session = create(tenant, false);
        for (String title : List.of("", " ", "\u00a0", "\ufeff", "bad\nname", "x".repeat(257))) {
            rename(tenant, session, UUID.randomUUID().toString(), title)
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_title"));
        }
        for (String key : List.of("", "x".repeat(129), "space key")) {
            rename(tenant, session, key, "new title").andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_idempotency_key"));
        }
        rename(tenant(), session, "foreign", "new title").andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("session_not_found"));
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("original");
    }

    @ParameterizedTest
    @ValueSource(strings = {"CLOSING", "CLOSED", "ARCHIVED"})
    void inactiveSessionsAdvertiseNoFreshRename(String lifecycle) throws Exception {
        String tenant = tenant();
        String session = create(tenant, false);
        jdbc.update("UPDATE ma_session SET status=? WHERE tenant_id=? AND session_id=?", lifecycle, tenant, session);
        get(tenant, session).andExpect(jsonPath("$.capabilities.rename").value(false));
        rename(tenant, session, "inactive", "new title").andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("session_state_conflict"));
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("original");
    }

    private String create(String tenant, boolean activeTurn) throws Exception {
        List<Map<String, String>> input = activeTurn ? List.of(Map.of("type", "text", "text", "hold")) : List.of();
        JsonNode response = mapper.readTree(mvc.perform(post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("idempotencyKey", UUID.randomUUID().toString(),
                                "agentId", "qwen-code", "title", "original", "input", input))))
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());
        return response.get("sessionId").asText();
    }

    private ResultActions get(String tenant, String session) throws Exception {
        return mvc.perform(post(WEB_SHELL + "/sessions/get").header(TENANT, tenant)
                .contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(Map.of("sessionId", session))));
    }

    private ResultActions rename(String tenant, String session, String key, String title) throws Exception {
        return mvc.perform(post(WEB_SHELL + "/sessions/rename").header(TENANT, tenant)
                .contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(Map.of("requestId", "rename-trace",
                        "sessionId", session, "idempotencyKey", key, "title", title))));
    }

    private static String tenant() {
        return "tenant-web-rename-" + UUID.randomUUID();
    }
}
