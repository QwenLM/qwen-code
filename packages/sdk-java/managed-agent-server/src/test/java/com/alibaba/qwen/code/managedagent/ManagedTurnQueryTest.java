package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/**
 * The public Turn read model: a Session's Turns newest first across pages,
 * their public fields, cursor and limit validation, and the Session checks
 * that a read shares with the other Session routes. Turns are written
 * directly, with a dispatch lease no worker can take over.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-turn-query;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
@AutoConfigureMockMvc
@Import(ManagedAgentServerIntegrationTest.FixtureConfiguration.class)
class ManagedTurnQueryTest {
    private static final String TENANT = TenantContextFilter.HEADER;
    private static final long NEVER = Long.MAX_VALUE / 2;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ManagedAgentStore store;

    @ParameterizedTest
    @ValueSource(longs = {1_000, 2_000})
    void latestTurnAndEnvironmentFollowAdmissionOrder(long firstCreatedAt)
            throws Exception {
        String tenant = tenant();
        String sessionId = emptySession(tenant);
        turn(tenant, sessionId, "turn_z", "COMPLETED", firstCreatedAt,
                3_000L, null);
        turn(tenant, sessionId, "turn_a", "RUNNING", 1_000, null, null);
        store.appendPublicEventIfAbsent(tenant, sessionId, "turn_z",
                "turn.accepted", Map.of("input", List.of()), false,
                "accepted:first");
        store.appendPublicEventIfAbsent(tenant, sessionId, "turn_z",
                "environment.ready", Map.of(), false, "ready:first");
        store.appendPublicEventIfAbsent(tenant, sessionId, "turn_a",
                "turn.accepted", Map.of("input", List.of()), false,
                "accepted:second");

        assertThat(store.findLatestTurns(tenant, List.of(sessionId))
                .get(sessionId))
                .satisfies(turn -> assertThat(turn.turnId()).isEqualTo("turn_a"));
        assertThat(store.findLatestEnvironmentEvents(tenant,
                store.findLatestTurns(tenant, List.of(sessionId)))).isEmpty();

        store.appendPublicEventIfAbsent(tenant, sessionId, "turn_a",
                "environment.ready", Map.of(), false, "ready:second");
        store.appendPublicEventIfAbsent(tenant, sessionId, "turn_z",
                "environment.failed", Map.of("code", "runtime_warm_failed"),
                false, "failed:first");

        assertThat(store.findLatestEnvironmentEvents(tenant,
                store.findLatestTurns(tenant, List.of(sessionId)))
                .get(sessionId))
                .satisfies(event -> {
                    assertThat(event.turnId()).isEqualTo("turn_a");
                    assertThat(event.type()).isEqualTo("environment.ready");
                });
    }

    @Test
    void pagesNewestFirstAndBreaksTiesByTurnId() throws Exception {
        String tenant = tenant();
        String sessionId = emptySession(tenant);
        // The oldest Turn has the largest ID, so an order by ID alone differs.
        turn(tenant, sessionId, "turn_z1", "COMPLETED", 500, 900L, null);
        turn(tenant, sessionId, "turn_a1", "COMPLETED", 1_000, 2_000L, null);
        turn(tenant, sessionId, "turn_b1", "CANCELLED", 5_000, 7_000L, null);
        turn(tenant, sessionId, "turn_b2", "FAILED", 5_000, 6_000L,
                "harness_unavailable");
        turn(tenant, sessionId, "turn_c1", "RUNNING", 9_000, null, null);
        turn(tenant, sessionId, "turn_c2", "ACCEPTED", 9_000, null, null);

        // Every limit puts page boundaries elsewhere, also between two Turns
        // created at the same time.
        for (int limit = 1; limit <= 6; limit++) {
            List<String> order = new ArrayList<>();
            List<Boolean> hasMore = new ArrayList<>();
            String cursor = null;
            do {
                // A cursor that repeats a Turn would page for ever.
                assertThat(hasMore).as("limit %d", limit).hasSizeLessThan(7);
                JsonNode page = list(tenant, sessionId, cursor,
                        Integer.toString(limit));
                page.get("data").forEach(turn -> order.add(turn.get("id")
                        .asText()));
                hasMore.add(page.get("has_more").asBoolean());
                cursor = page.get("next_cursor").isNull() ? null
                        : page.get("next_cursor").asText();
            } while (cursor != null);
            assertThat(order).as("limit %d", limit).containsExactly(
                    "turn_c2", "turn_c1", "turn_b2", "turn_b1", "turn_a1",
                    "turn_z1");
            int pages = (6 + limit - 1) / limit;
            assertThat(hasMore).as("limit %d", limit).hasSize(pages)
                    .endsWith(false);
            assertThat(hasMore.subList(0, pages - 1)).doesNotContain(false);
        }

        // A page that ends at the oldest Turn reports no more.
        JsonNode exact = list(tenant, sessionId, null, "6");
        assertThat(exact.get("data")).hasSize(6);
        assertThat(exact.get("has_more").asBoolean()).isFalse();
        assertThat(exact.get("next_cursor").isNull()).isTrue();
        assertThat(list(tenant, sessionId, null, null).get("data"))
                .hasSize(6);
        for (String firstPage : List.of("", "  ")) {
            assertThat(list(tenant, sessionId, firstPage, "1")
                    .at("/data/0/id").asText()).isEqualTo("turn_c2");
        }

        // Without a limit a page holds 20 Turns.
        String longSession = emptySession(tenant);
        for (int index = 0; index < 25; index++) {
            turn(tenant, longSession, "turn_long%02d".formatted(index),
                    "COMPLETED", 1_000 + index, 2_000L + index, null);
        }
        JsonNode first = list(tenant, longSession, null, null);
        assertThat(first.get("data")).hasSize(20);
        assertThat(first.get("has_more").asBoolean()).isTrue();
        assertThat(list(tenant, longSession, first.get("next_cursor")
                .asText(), null).get("data")).hasSize(5);
    }

    @Test
    void showsEachStoredStatusWithItsOutcome() throws Exception {
        String tenant = tenant();
        String sessionId = emptySession(tenant);
        List<String> statuses = List.of("ACCEPTED", "RUNNING", "CANCELLING",
                "COMPLETED", "FAILED", "CANCELLED");
        for (int index = 0; index < statuses.size(); index++) {
            boolean settled = index >= 3;
            turn(tenant, sessionId, "turn_status" + index,
                    statuses.get(index), 10_000 + index * 1_000,
                    settled ? 20_500L + index * 1_000 : null,
                    "FAILED".equals(statuses.get(index)) ? "model_error"
                            : null);
        }
        for (int index = 0; index < statuses.size(); index++) {
            String turnId = "turn_status" + index;
            JsonNode turn = objectMapper.readTree(turnRead(tenant, sessionId,
                    turnId).andExpect(status().isOk()).andReturn()
                    .getResponse().getContentAsString());
            assertThat(turn.get("object").asText()).isEqualTo("agent.turn");
            assertThat(turn.get("session_id").asText()).isEqualTo(sessionId);
            assertThat(turn.get("status").asText())
                    .isEqualTo(statuses.get(index).toLowerCase());
            assertThat(turn.get("input_item_id").asText())
                    .isEqualTo("item_" + turnId + "_input");
            assertThat(turn.get("created_at").asLong()).isEqualTo(10 + index);
            if (index >= 3) {
                assertThat(turn.get("completed_at").asLong())
                        .isEqualTo(20 + index);
            } else {
                assertThat(turn.has("completed_at")).isFalse();
            }
            assertThat(turn.path("error_code").asText())
                    .isEqualTo(index == 4 ? "model_error" : "");
        }
        JsonNode page = list(tenant, sessionId, null, null);
        for (JsonNode listed : page.get("data")) {
            assertThat(listed).isEqualTo(objectMapper.readTree(turnRead(tenant,
                    sessionId, listed.get("id").asText()).andReturn()
                    .getResponse().getContentAsString()));
        }
    }

    // The read model never parses a Turn's input, so it serves a Turn whose
    // stored input it could not read.
    @Test
    void readsTurnsWithoutTheirInput() throws Exception {
        String tenant = tenant();
        String sessionId = emptySession(tenant);
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, created_at, updated_at, completed_at)"
                        + " VALUES (?, ?, 'turn_input', ?, 'not json',"
                        + " 'digest', 'COMPLETED', 1000, 1000, 2000)",
                tenant, sessionId, UUID.randomUUID().toString());
        assertThat(list(tenant, sessionId, null, null).at("/data/0/id")
                .asText()).isEqualTo("turn_input");
        turnRead(tenant, sessionId, "turn_input").andExpect(status().isOk());
    }

    @Test
    void rejectsBadLimitsAndMalformedCursors()
            throws Exception {
        String tenant = tenant();
        String sessionId = emptySession(tenant);
        turn(tenant, sessionId, "turn_a1", "COMPLETED", 1_000, 2_000L, null);
        for (String limit : List.of("0", "101", "-1")) {
            error(mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                    .header(TENANT, tenant).param("limit", limit)), 400,
                    "invalid_limit");
        }
        // A limit that is not a 32-bit integer never reaches the range
        // check.
        for (String limit : List.of("abc", "2147483648")) {
            error(mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                    .header(TENANT, tenant).param("limit", limit)), 400,
                    "invalid_request");
        }
        // A request is validated before its Session is looked up.
        String unknown = UUID.randomUUID().toString();
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns", unknown)
                .header(TENANT, tenant).param("limit", "0")), 400,
                "invalid_limit");
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns", unknown)
                .header(TENANT, tenant).param("cursor", "bad")), 400,
                "invalid_cursor");
        error(turnRead(tenant, unknown, "t".repeat(65)), 400,
                "invalid_request");
        assertThat(list(tenant, sessionId, null, "100").get("data"))
                .hasSize(1);
        for (String raw : List.of("5000", "5000:", ":turn_a1", "-1:turn_a1",
                "01:turn_a1", "9999999999999999999:turn_a1",
                "5000:turn a1", "5000:" + "t".repeat(65))) {
            error(mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                    .header(TENANT, tenant).param("cursor", cursor(raw))),
                    400, "invalid_cursor");
        }
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                .header(TENANT, tenant).param("cursor", "not base64!")), 400,
                "invalid_cursor");
        assertThat(list(tenant, sessionId,
                cursor(Long.MAX_VALUE + ":turn_z"), null).get("data"))
                .hasSize(1);
        assertThat(list(tenant, sessionId, cursor("1000:turn_a1"), null)
                .get("data")).isEmpty();
        // Cursors that the server accepts though it would not write them:
        // with base64 padding, and with a Turn ID of the full 64 characters.
        // "999:turn_a1" is 11 bytes, so its encoding needs padding.
        String padded = Base64.getUrlEncoder().encodeToString(
                "999:turn_a1".getBytes(StandardCharsets.UTF_8));
        assertThat(padded).endsWith("=");
        assertThat(list(tenant, sessionId, padded, null).get("data"))
                .isEmpty();
        // Older than the only Turn, so an ignored cursor would list it.
        assertThat(list(tenant, sessionId, cursor("999:" + "t".repeat(64)),
                null).get("data")).isEmpty();
    }

    @Test
    void readsOnlyTheTurnsOfAReadableSessionOfTheTenant() throws Exception {
        String tenant = tenant();
        String sessionId = emptySession(tenant);
        String otherSession = emptySession(tenant);
        turn(tenant, sessionId, "turn_own", "COMPLETED", 1_000, 2_000L, null);
        turn(tenant, otherSession, "turn_other", "COMPLETED", 3_000, 4_000L,
                null);

        assertThat(list(tenant, sessionId, null, null).get("data"))
                .extracting(turn -> turn.get("id").asText())
                .containsExactly("turn_own");
        error(turnRead(tenant, sessionId, "turn_other"), 404,
                "turn_not_found");
        String otherTenant = tenant + "-other";
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                .header(TENANT, otherTenant)), 404, "session_not_found");
        error(turnRead(otherTenant, sessionId, "turn_own"), 404,
                "session_not_found");
        error(turnRead(tenant, sessionId, "t".repeat(64)), 404,
                "turn_not_found");
        error(turnRead(tenant, sessionId, "t".repeat(65)), 400,
                "invalid_request");
        // The path schema counts characters: 33 characters outside the
        // Basic Multilingual Plane are 66 UTF-16 units.
        error(turnRead(tenant, sessionId, "\uD83D\uDE00".repeat(33)), 404,
                "turn_not_found");
        error(turnRead(tenant, sessionId, "\uD83D\uDE00".repeat(65)), 400,
                "invalid_request");
        error(turnRead(tenant, sessionId, "turn_own "), 404,
                "turn_not_found");
        String unknown = UUID.randomUUID().toString();
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns", unknown)
                .header(TENANT, tenant)), 404, "session_not_found");
        error(turnRead(tenant, unknown, "turn_own"), 404, "session_not_found");

        jdbc.update("UPDATE managed_agent_session SET status = 'ARCHIVED'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, sessionId);
        turnRead(tenant, sessionId, "turn_own").andExpect(status().isOk());
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED',"
                        + " deleted_at = 1 WHERE tenant_id = ? AND"
                        + " session_id = ?", tenant, sessionId);
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                .header(TENANT, tenant)), 404, "session_not_found");
        error(turnRead(tenant, sessionId, "turn_own"), 404, "session_not_found");
    }

    @Test
    void readsABoundSessionOnlyWithAReadGrant() throws Exception {
        String tenant = tenant();
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, 'ws-a', 1, 'storage-a', 'ws-a',"
                        + " 'config', 'policy', 'ACTIVE')", tenant);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, 'ws-a', ?, TRUE, TRUE)", tenant,
                "actor-a".getBytes(StandardCharsets.UTF_8));
        String sessionId = objectMapper.readTree(mvc.perform(post(
                        "/v1/agents/sessions").header(TENANT, tenant)
                        .header("Idempotency-Key", "bound")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"agent_id":"qwen-code","input":[],
                                 "workspace":{"workspace_id":"ws-a"}}
                                """))
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString())
                .get("id").asText();
        turn(tenant, sessionId, "turn_bound", "COMPLETED", 1_000, 2_000L,
                null);

        mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                        .header(TENANT, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id").value("turn_bound"));
        mvc.perform(get("/v1/agents/sessions/{id}/turns/{turn}", sessionId,
                        "turn_bound").header(TENANT, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk());
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns", sessionId)
                .header(TENANT, tenant).principal(actor(tenant, "actor-b"))),
                404, "session_not_found");
        error(mvc.perform(get("/v1/agents/sessions/{id}/turns/{turn}",
                sessionId, "turn_bound").header(TENANT, tenant)
                .principal(actor(tenant, "actor-b"))), 404,
                "session_not_found");
    }

    private JsonNode list(String tenant, String sessionId, String cursor,
            String limit) throws Exception {
        MockHttpServletRequestBuilder request = get(
                "/v1/agents/sessions/{id}/turns", sessionId)
                .header(TENANT, tenant);
        if (cursor != null) {
            request.param("cursor", cursor);
        }
        if (limit != null) {
            request.param("limit", limit);
        }
        return objectMapper.readTree(mvc.perform(request)
                .andExpect(status().isOk()).andReturn().getResponse()
                .getContentAsString());
    }

    private ResultActions turnRead(String tenant, String sessionId,
            String turnId) throws Exception {
        return mvc.perform(get("/v1/agents/sessions/{id}/turns/{turn}",
                sessionId, turnId).header(TENANT, tenant));
    }

    private static void error(ResultActions result, int status, String code)
            throws Exception {
        result.andExpect(status().is(status))
                .andExpect(jsonPath("$.error.code").value(code));
    }

    private void turn(String tenant, String sessionId, String turnId,
            String status, long createdAt, Long completedAt,
            String errorCode) {
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, dispatch_owner, dispatch_lease_until,"
                        + " error_code, created_at, updated_at, completed_at)"
                        + " VALUES (?, ?, ?, ?, '[]', 'digest', ?,"
                        + " 'turn-query-test', ?, ?, ?, ?, ?)",
                tenant, sessionId, turnId, UUID.randomUUID().toString(),
                status, NEVER, errorCode, createdAt, createdAt, completedAt);
    }

    private String emptySession(String tenant) throws Exception {
        return objectMapper.readTree(mvc.perform(post("/v1/agents/sessions")
                        .header(TENANT, tenant)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString())
                .get("id").asText();
    }

    private static String cursor(String raw) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                raw.getBytes(StandardCharsets.UTF_8));
    }

    private static String tenant() {
        return "tenant-turns-" + UUID.randomUUID();
    }

    private static AuthenticatedTenantActor actor(String tenant,
            String actorId) {
        return new AuthenticatedTenantActor() {
            @Override
            public String getName() {
                return actorId;
            }

            @Override
            public String tenantId() {
                return tenant;
            }

            @Override
            public String actorId() {
                return actorId;
            }
        };
    }
}
