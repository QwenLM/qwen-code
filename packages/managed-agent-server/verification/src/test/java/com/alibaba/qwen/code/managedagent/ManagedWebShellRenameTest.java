package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
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
class ManagedWebShellRenameTest {
    private static final String WEB_SHELL = "/api/agent/web-shell/v1";
    private static final String TENANT = TenantContextFilter.HEADER;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    @Qualifier("managedJdbcTemplate")
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
        assertThat(harness.renameCount()).isEqualTo(sends + 2);

        // An offline Harness no longer refuses the rename: the SQL title is
        // the display authority, so the mutation still answers 200. The
        // capability advertisement stays conservative, and the best-effort
        // journal notification is skipped while the Harness is unavailable.
        harness.setAvailable(false);
        get(tenant, session).andExpect(jsonPath("$.capabilities.rename").value(false));
        rename(tenant, session, "offline", "third title")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("third title"))
                .andExpect(jsonPath("$.replayed").value(false));
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("third title");
        assertThat(harness.renameCount()).isEqualTo(sends + 2);
        rename(tenant, session, "first", "first title")
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "true"))
                .andExpect(jsonPath("$.title").value("third title"))
                .andExpect(jsonPath("$.replayed").value(true));
        assertThat(harness.renameCount()).isEqualTo(sends + 2);

        jdbc.update("UPDATE ma_session SET status='DELETED', deleted_at=? WHERE tenant_id=? AND session_id=?",
                System.currentTimeMillis(), tenant, session);
        get(tenant, session).andExpect(status().isNotFound());
        rename(tenant, session, "first", "first title")
                .andExpect(status().isOk()).andExpect(jsonPath("$.title").value("third title"))
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
    void aFailedTitleNotificationNeverFailsTheRenameOrResends() throws Exception {
        String tenant = tenant();
        String session = create(tenant, false);
        int sends = harness.renameCount();
        harness.failNextRename();
        // The notification is best-effort: its failure is logged and swallowed,
        // and the confirmed SQL title still answers 200.
        rename(tenant, session, "unknown", "pending title")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("pending title"))
                .andExpect(jsonPath("$.replayed").value(false));
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("pending title");
        assertThat(harness.renameCount()).isEqualTo(sends + 1);
        // The same-key replay answers the recorded outcome without resending.
        rename(tenant, session, "unknown", "pending title")
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "true"))
                .andExpect(jsonPath("$.replayed").value(true));
        assertThat(harness.renameCount()).isEqualTo(sends + 1);
    }

    @Test
    void aLegacyFailedReceiptRetrySettlesAndNotifies() throws Exception {
        String tenant = tenant();
        String session = create(tenant, false);
        int sends = harness.renameCount();
        // A pre-upgrade binary left a FAILED RENAME_SESSION receipt. The
        // same-key retry re-settles under a new revision: it reports replayed,
        // but a fresh settlement must still send the journal notification.
        String digest = new RequestDigests().digest(Map.of(
                "sessionId", session, "title", "revived title"));
        store.beginSessionMutation(tenant, "RENAME_SESSION", "legacy", digest,
                session, SessionMutationKind.RENAME);
        store.abandonSessionMutation(tenant, "RENAME_SESSION", "legacy", session);
        rename(tenant, session, "legacy", "revived title")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("revived title"))
                .andExpect(jsonPath("$.replayed").value(true));
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("revived title");
        assertThat(harness.renameCount()).isEqualTo(sends + 1);
    }

    @Test
    void consecutiveRenamesCarryIncreasingNotificationRevisions() throws Exception {
        String tenant = tenant();
        String session = create(tenant, false);
        rename(tenant, session, "rev-1", "first title").andExpect(status().isOk());
        long first = harness.renameRevision(session);
        rename(tenant, session, "rev-2", "second title").andExpect(status().isOk());
        long second = harness.renameRevision(session);
        assertThat(first).isPositive();
        assertThat(second).isGreaterThan(first);
        // A COMPLETED replay settles no new revision and sends no notification,
        // so the recorded revision and the send count both stay put.
        int sends = harness.renameCount();
        rename(tenant, session, "rev-2", "second title")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.replayed").value(true));
        assertThat(harness.renameCount()).isEqualTo(sends);
        assertThat(harness.renameRevision(session)).isEqualTo(second);
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
        JsonNode response = mapper.readTree(mvc.perform(post(WEB_SHELL + "/sessions/create").principal(tenantActor(tenant))
                        .header(TENANT, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("idempotencyKey", UUID.randomUUID().toString(),
                                "agentId", "qwen-code", "title", "original", "input", input))))
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());
        String id = response.get("sessionId").asText();
        // Creation requires a trusted actor; these probes read and rename
        // anonymously, so restore the genuine legacy row-less state.
        jdbc.update("DELETE FROM ma_session_principal WHERE tenant_id = ? AND session_id = ?", tenant, id);
        jdbc.update("UPDATE ma_request_receipt SET actor_id = NULL WHERE tenant_id = ? AND session_id = ?"
                + " AND namespace = 'SESSION_COMMAND' AND operation = 'CREATE_SESSION'", tenant, id);
        return id;
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

    private static com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor tenantActor(String tenant) {
        return new com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor() {
            @Override
            public String tenantId() {
                return tenant;
            }

            @Override
            public String actorId() {
                return "actor-a";
            }

            @Override
            public String getName() {
                return "actor-a";
            }
        };
    }
}
