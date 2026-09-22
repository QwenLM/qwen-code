package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.ManagedSessionStoreController;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.SessionEventHub;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-agent;MODE=MySQL;"
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
class ManagedAgentServerIntegrationTest {
    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ApplicationContext applicationContext;

    @Autowired
    private FixtureHarness harness;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private SessionEventHub eventHub;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Test
    void requiresTenantHeader() throws Exception {
        mvc.perform(get("/v1/agents/sessions"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_tenant"));

        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, "tenant-header")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("invalid_request"));

        assertThat(applicationContext.getBeansOfType(
                ManagedSessionStoreController.class)).isEmpty();
    }

    @Test
    void createsReplaysAndStreamsATenantScopedTurn() throws Exception {
        String tenant = "tenant-create";
        String body = """
                {"agent_id":"qwen-code","metadata":{"title":"demo"},
                 "input":[{"type":"text","text":"hello"}]}
                """;
        MvcResult first = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Authorization", "Bearer ignored-by-design")
                        .header("Idempotency-Key", "create-key")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "false"))
                .andExpect(jsonPath("$.object").value("agent.session"))
                .andExpect(jsonPath("$.metadata.title").value("demo"))
                .andReturn();
        String sessionId = objectMapper.readTree(
                first.getResponse().getContentAsString()).get("id").asText();
        assertThat(UUID.fromString(sessionId).toString()).isEqualTo(sessionId);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " INFORMATION_SCHEMA.COLUMNS WHERE"
                        + " LOWER(TABLE_NAME) = 'managed_agent_session' AND"
                        + " LOWER(COLUMN_NAME) = 'harness_session_id'",
                Integer.class)).isZero();

        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            MvcResult events = events(tenant, sessionId);
            JsonNode data = objectMapper.readTree(
                    events.getResponse().getContentAsString()).get("data");
            assertThat(data).extracting(node -> node.get("type").asText())
                    .contains("item.output_text.delta", "turn.completed");
            assertThat(data.get(data.size() - 1).get("terminal").asBoolean())
                    .isTrue();
        });
        assertThat(harness.hasSession(sessionId)).isTrue();

        JsonNode allEvents = objectMapper.readTree(events(tenant, sessionId)
                .getResponse().getContentAsString()).get("data");
        long firstSequence = allEvents.get(0).get("sequence").asLong();
        MvcResult resumed = mvc.perform(get(
                        "/v1/agents/sessions/{id}/events", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Last-Event-ID", firstSequence)
                        .accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk()).andReturn();
        assertThat(objectMapper.readTree(
                        resumed.getResponse().getContentAsString())
                .get("data")).allMatch(event ->
                        event.get("sequence").asLong() > firstSequence);

        int submitsBeforeReplay = harness.submitCount();
        MvcResult replay = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create-key")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "true"))
                .andReturn();
        assertThat(objectMapper.readTree(
                replay.getResponse().getContentAsString()).get("id").asText())
                .isEqualTo(sessionId);
        assertThat(harness.submitCount()).isEqualTo(submitsBeforeReplay);

        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create-key")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body.replace("hello", "changed")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("idempotency_conflict"));

        mvc.perform(get("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, "tenant-other"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code")
                        .value("session_not_found"));
    }

    @Test
    void managesThePublicSessionLifecycle() throws Exception {
        String tenant = "tenant-lifecycle-" + UUID.randomUUID();
        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-create")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString()).get("id").asText();

        int renames = harness.renameCount();
        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant + "-other")
                        .header("Idempotency-Key", "lifecycle-other-tenant")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"not allowed\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code")
                        .value("session_not_found"));
        assertThat(harness.renameCount()).isEqualTo(renames);

        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"managed title\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "false"))
                .andExpect(jsonPath("$.metadata.title")
                        .value("managed title"));
        assertThat(harness.renameCount()).isEqualTo(renames + 1);
        assertThat(harness.title(sessionId)).isEqualTo("managed title");
        assertThat(store.requireSession(tenant, sessionId).harnessBootId())
                .isNotNull();

        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"managed title\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "true"));
        assertThat(harness.renameCount()).isEqualTo(renames + 1);

        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"different\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("idempotency_conflict"));

        JsonNode events = objectMapper.readTree(events(tenant, sessionId)
                .getResponse().getContentAsString()).get("data");
        assertThat(events).filteredOn(event -> "session.updated".equals(
                        event.get("type").asText()))
                .hasSize(1);

        int closes = harness.closeCount();
        harness.setAvailable(false);
        try {
            mvc.perform(post("/v1/agents/sessions/{id}/archive", sessionId)
                            .header(TenantContextFilter.HEADER, tenant)
                            .header("Idempotency-Key", "lifecycle-archive"))
                    .andExpect(status().isServiceUnavailable())
                    .andExpect(jsonPath("$.error.code")
                            .value("hosted_harness_unavailable"));
        } finally {
            harness.setAvailable(true);
        }
        mvc.perform(post("/v1/agents/sessions/{id}/archive", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-archive"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "true"))
                .andExpect(jsonPath("$.status").value("archived"));
        assertThat(harness.closeCount()).isEqualTo(closes + 1);

        mvc.perform(post("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "archived-turn")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"agent.session.input.message\","
                                + "\"input\":[{\"type\":\"text\","
                                + "\"text\":\"blocked\"}]}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_not_active"));

        mvc.perform(post("/v1/agents/sessions/{id}/unarchive", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-unarchive"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("active"));

        mvc.perform(delete("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-delete"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "false"))
                .andExpect(jsonPath("$.object")
                        .value("agent.session.deleted"))
                .andExpect(jsonPath("$.deleted").value(true));

        mvc.perform(get("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isNotFound());
        mvc.perform(get("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.id == '%s')]"
                        .formatted(sessionId)).isEmpty());
        mvc.perform(delete("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-delete"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "true"));
    }

    @Test
    void rejectsArchivalUntilTheActiveTurnSettles() throws Exception {
        String tenant = "tenant-archive-active-" + UUID.randomUUID();
        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "archive-active-create")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":["
                                + "{\"type\":\"text\",\"text\":\"hold\"}]}"))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString()).get("id").asText();
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                assertThat(harness.hasHeldTurn()).isTrue());
        int closes = harness.closeCount();

        try {
            mvc.perform(post("/v1/agents/sessions/{id}/archive", sessionId)
                            .header(TenantContextFilter.HEADER, tenant)
                            .header("Idempotency-Key", "archive-active"))
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code")
                            .value("turn_active"));
            assertThat(harness.closeCount()).isEqualTo(closes);
        } finally {
            harness.releaseHeldTurns();
        }

        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                assertThat(store.findActiveTurn(tenant, sessionId))
                        .isEmpty());
        mvc.perform(post("/v1/agents/sessions/{id}/archive", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "archive-active"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("archived"));
        assertThat(store.requireSession(tenant, sessionId).harnessBootId())
                .isNotNull();
    }

    @Test
    void deletesAnArchivedSessionWhileTheHarnessIsUnavailable()
            throws Exception {
        String tenant = "tenant-archived-delete-" + UUID.randomUUID();
        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "archived-delete-create")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":["
                                + "{\"type\":\"text\",\"text\":\"hello\"}]}"))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString()).get("id").asText();
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> {
            assertThat(store.findActiveTurn(tenant, sessionId)).isEmpty();
            assertThat(store.requireSession(tenant, sessionId).harnessBootId())
                    .isNotNull();
        });
        mvc.perform(post("/v1/agents/sessions/{id}/archive", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "archived-delete-archive"))
                .andExpect(status().isOk());

        harness.setAvailable(false);
        try {
            mvc.perform(delete("/v1/agents/sessions/{id}", sessionId)
                            .header(TenantContextFilter.HEADER, tenant)
                            .header("Idempotency-Key",
                                    "archived-delete-delete"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.deleted").value(true));
        } finally {
            harness.setAvailable(true);
        }
    }

    @Test
    void retriesAPendingRenameWithTheSameIdempotencyKey() throws Exception {
        String tenant = "tenant-rename-retry-" + UUID.randomUUID();
        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "rename-retry-create")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString()).get("id").asText();
        harness.failNextRename();

        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "rename-retry")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"retry title\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error.code")
                        .value("hosted_harness_unavailable"));

        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "another-rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"blocked\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_operation_active"));

        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "rename-retry")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"retry title\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay",
                        "true"))
                .andExpect(jsonPath("$.metadata.title")
                        .value("retry title"));

        JsonNode events = objectMapper.readTree(events(tenant, sessionId)
                .getResponse().getContentAsString()).get("data");
        assertThat(events).filteredOn(event -> "session.updated".equals(
                        event.get("type").asText()))
                .hasSize(1);
    }

    @Test
    void webShellAdapterUsesTheSameDurableCore() throws Exception {
        String tenant = "tenant-web";
        MvcResult created = mvc.perform(post(
                        "/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"requestId":"trace-1",
                                 "idempotencyKey":"web-create",
                                 "agentId":"qwen-code",
                                 "title":"web",
                                 "metadata":{"clientId":"browser-1"},
                                 "input":[]}
                                """))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("accepted"))
                .andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString())
                .get("sessionId").asText();

        mvc.perform(post("/api/agent/web-shell/v1/turns/submit")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"requestId":"trace-2",
                                 "idempotencyKey":"web-turn",
                                 "sessionId":"%s",
                                 "input":[{"type":"text","text":"hi"}]}
                                """.formatted(sessionId)))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.sessionId").value(sessionId))
                .andExpect(jsonPath("$.turnId").isNotEmpty());

        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                mvc.perform(post(
                                "/api/agent/web-shell/v1/transcript/query")
                                .header(TenantContextFilter.HEADER, tenant)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"sessionId\":\"" + sessionId
                                        + "\",\"limit\":100}"))
                        .andExpect(status().isOk())
                        .andExpect(jsonPath("$.events[?(@.type =="
                                + " 'turn.completed')]").isNotEmpty()));

        mvc.perform(post("/api/agent/web-shell/v1/sessions/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + sessionId + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.activeTurn.status")
                        .value("completed"));

        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            MvcResult transcript = mvc.perform(post(
                            "/api/agent/web-shell/v1/transcript/query")
                            .header(TenantContextFilter.HEADER, tenant)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"sessionId\":\"" + sessionId
                                    + "\",\"limit\":2}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.hasMore").value(false))
                    .andReturn();
            JsonNode body = objectMapper.readTree(
                    transcript.getResponse().getContentAsString());
            assertThat(body.get("coveredSequence").asLong())
                    .isEqualTo(body.get("lastSequence").asLong());
            assertThat(body.get("items")).hasSize(2);
            assertThat(body.get("items").get(0).get("content").get(0)
                    .get("text").asText()).isEqualTo("hi");
            assertThat(body.get("items").get(1).get("content").get(0)
                    .get("text").asText()).isEqualTo("hello");
        });

        MvcResult firstItems = mvc.perform(get(
                        "/v1/agents/sessions/{id}/items", sessionId)
                        .param("limit", "1")
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(1))
                .andExpect(jsonPath("$.has_more").value(true))
                .andExpect(jsonPath("$.next_cursor").isNotEmpty())
                .andExpect(jsonPath("$.snapshot_through_sequence")
                        .isNumber()).andReturn();
        String after = objectMapper.readTree(firstItems.getResponse()
                .getContentAsString()).get("next_cursor").asText();
        mvc.perform(get("/v1/agents/sessions/{id}/items", sessionId)
                        .param("after", after).param("limit", "1")
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(1))
                .andExpect(jsonPath("$.has_more").value(false));
    }

    @Test
    void replaysASubmitWhileTheOriginalTurnIsStillActive() throws Exception {
        String tenant = "tenant-active-replay";
        MvcResult created = mvc.perform(post(
                        "/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"active-create",
                                 "agentId":"qwen-code","input":[]}
                                """))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString())
                .get("sessionId").asText();
        String submit = """
                {"idempotencyKey":"active-turn","sessionId":"%s",
                 "input":[{"type":"text","text":"hold"}]}
                """.formatted(sessionId);

        MvcResult first = mvc.perform(post(
                        "/api/agent/web-shell/v1/turns/submit")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(submit))
                .andExpect(status().isAccepted()).andReturn();
        String turnId = objectMapper.readTree(
                first.getResponse().getContentAsString())
                .get("turnId").asText();
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                assertThat(harness.hasHeldTurn()).isTrue());
        int submitsBeforeReplay = harness.submitCount();

        mvc.perform(post("/api/agent/web-shell/v1/turns/submit")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(submit))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.turnId").value(turnId))
                .andExpect(jsonPath("$.replayed").value(true));
        assertThat(harness.submitCount()).isEqualTo(submitsBeforeReplay);

        String cancel = """
                {"idempotencyKey":"active-cancel","sessionId":"%s",
                 "turnId":"%s"}
                """.formatted(sessionId, turnId);
        int cancellations = harness.cancelCount();
        mvc.perform(post("/api/agent/web-shell/v1/turns/cancel")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(cancel))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.replayed").value(false));
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                assertThat(harness.cancelCount())
                        .isEqualTo(cancellations + 1));
        mvc.perform(post("/api/agent/web-shell/v1/turns/cancel")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(cancel))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.replayed").value(true));
        assertThat(harness.cancelCount()).isEqualTo(cancellations + 1);
        mvc.perform(post("/api/agent/web-shell/v1/turns/cancel")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(cancel.replace("active-cancel",
                                "active-cancel-other")))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.replayed").value(false));
        assertThat(harness.cancelCount()).isEqualTo(cancellations + 1);
        harness.releaseHeldTurns();
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                mvc.perform(post(
                                "/api/agent/web-shell/v1/transcript/query")
                                .header(TenantContextFilter.HEADER, tenant)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"sessionId\":\"" + sessionId
                                        + "\",\"limit\":100}"))
                        .andExpect(status().isOk())
                        .andExpect(jsonPath("$.events[?(@.type =="
                                + " 'turn.cancelled')]").isNotEmpty()));
    }

    @Test
    void concurrentSameKeySubmitsCreateOneTurn() throws Exception {
        String tenant = "tenant-concurrent-replay";
        MvcResult created = mvc.perform(post(
                        "/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"concurrent-create",
                                 "agentId":"qwen-code","input":[]}
                                """))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString())
                .get("sessionId").asText();
        List<Map<String, Object>> input = List.of(Map.of(
                "type", "text", "text", "race"));
        CyclicBarrier gate = new CyclicBarrier(2);
        Callable<Admission> submit = () -> {
            gate.await();
            return store.insertTurnCommand(tenant, "SUBMIT_TURN",
                    "concurrent-turn", "sha256:" + "a".repeat(64),
                    sessionId, input, "sha256:" + "b".repeat(64));
        };

        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            Future<Admission> left = executor.submit(submit);
            Future<Admission> right = executor.submit(submit);
            Admission first = left.get(5, TimeUnit.SECONDS);
            Admission second = right.get(5, TimeUnit.SECONDS);

            assertThat(first.turnId()).isEqualTo(second.turnId());
            assertThat(List.of(first.replayed(), second.replayed()))
                    .containsExactlyInAnyOrder(false, true);
        }
    }

    @Test
    void commitsHarnessEventsAsOneReplayableBatch() throws Exception {
        String tenant = "tenant-batch-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "batch-create",
                "sha256:" + "a".repeat(64), "qwen-code", null,
                List.of(), null);
        List<Map<String, Object>> input = List.of(Map.of(
                "type", "text", "text", "batch"));
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "batch-turn", "sha256:" + "b".repeat(64),
                session.sessionId(), input, "sha256:" + "c".repeat(64));
        String owner = "batch-owner";
        assertThat(store.claimTurn(tenant, session.sessionId(),
                turn.turnId(), owner, Duration.ofMinutes(1))).isPresent();
        store.recordAdmission(tenant, session.sessionId(), turn.turnId(),
                owner, "batch-epoch", 0);
        long before = store.requireSession(tenant, session.sessionId())
                .lastSequence();
        ProjectedEvent first = new ProjectedEvent(
                "item.output_text.delta", Map.of("text", "one"), false,
                null, null, null);
        ProjectedEvent second = new ProjectedEvent(
                "item.output_text.delta", Map.of("text", "two"), false,
                null, null, null);
        List<HarnessEvent> batch = List.of(
                new HarnessEvent(1, "boot:batch-epoch:1", first),
                new HarnessEvent(2, "boot:batch-epoch:2", null),
                new HarnessEvent(3, "boot:batch-epoch:3", second));

        try (SessionEventHub.Subscription subscription = eventHub.subscribe(
                tenant, session.sessionId())) {
            store.recordHarnessEvents(tenant, session.sessionId(),
                    turn.turnId(), owner, "batch-epoch", batch);
            SessionEventHub.Delivery delivery = subscription.await(before,
                    Duration.ofSeconds(1));
            assertThat(delivery.overflowed()).isFalse();
            assertThat(delivery.events()).extracting(event -> event.sequence())
                    .containsExactly(before + 1, before + 2);
        }

        store.recordHarnessEvents(tenant, session.sessionId(), turn.turnId(),
                owner, "batch-epoch", batch);
        assertThat(store.findEvents(tenant, session.sessionId(), before, 100))
                .extracting(event -> event.data().get("text"))
                .containsExactly("one", "two");
        assertThat(store.findTurn(tenant, session.sessionId(), turn.turnId()))
                .get().extracting(record -> record.harnessLastEventId())
                .isEqualTo(3L);

        ProjectedEvent terminal = new ProjectedEvent("turn.completed",
                Map.of(), true, "COMPLETED", null, null);
        store.recordHarnessEvents(tenant, session.sessionId(), turn.turnId(),
                owner, "batch-epoch", List.of(new HarnessEvent(4,
                        "boot:batch-epoch:4", terminal)));
        assertThat(store.findTurn(tenant, session.sessionId(), turn.turnId()))
                .get().extracting(record -> record.status())
                .isEqualTo("COMPLETED");
        assertThat(store.findEvents(tenant, session.sessionId(), before, 100))
                .extracting(event -> event.sequence())
                .containsExactly(before + 1, before + 2, before + 3);
        store.materializeNextBatch(tenant, session.sessionId(), 200);
        assertThat(store.findSnapshot(tenant, session.sessionId()))
                .get().satisfies(snapshot -> {
                    assertThat(snapshot.coveredSequence())
                            .isEqualTo(before + 3);
                    assertThat(snapshot.items()).filteredOn(item ->
                            "assistant".equals(item.role()))
                            .singleElement().satisfies(item ->
                                    assertThat(item.content())
                                            .singleElement()
                                            .extracting(part -> part.text())
                                            .isEqualTo("onetwo"));
                });
        assertThat(store.materializeNextBatch(tenant, session.sessionId(),
                200).advanced()).isFalse();
    }

    @Test
    void transfersHarnessGenerationOnlyBeforeAdmissionUnderDispatchLease() {
        String tenant = "tenant-harness-takeover-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "takeover-create",
                "sha256:" + "d".repeat(64), "qwen-code", null,
                List.of(), null);
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "takeover-turn", "sha256:" + "e".repeat(64),
                session.sessionId(), List.of(),
                "sha256:" + "f".repeat(64));
        String owner = "takeover-owner";
        assertThat(store.claimTurn(tenant, session.sessionId(),
                turn.turnId(), owner, Duration.ofMinutes(1))).isPresent();

        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-a")).isTrue();
        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-b")).isTrue();
        assertThat(store.requireSession(tenant, session.sessionId())
                .harnessBootId()).isEqualTo("boot-b");

        store.markSubmissionAttempted(tenant, session.sessionId(),
                turn.turnId(), owner);
        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-c")).isFalse();
        assertThat(store.requireSession(tenant, session.sessionId())
                .harnessBootId()).isEqualTo("boot-b");

        store.releaseTurnLease(tenant, session.sessionId(), turn.turnId(),
                owner);
        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-d")).isFalse();
        assertThat(store.requireSession(tenant, session.sessionId())
                .harnessBootId()).isEqualTo("boot-b");
    }

    @Test
    void doesNotPublishRolledBackEvents() throws Exception {
        String tenant = "tenant-rollback-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "rollback-create",
                "sha256:" + "d".repeat(64), "qwen-code", null,
                List.of(), null);
        long before = store.requireSession(tenant, session.sessionId())
                .lastSequence();

        try (SessionEventHub.Subscription subscription = eventHub.subscribe(
                tenant, session.sessionId())) {
            TransactionTemplate transaction = new TransactionTemplate(
                    transactionManager);
            assertThatThrownBy(() -> transaction.executeWithoutResult(
                    ignored -> {
                        store.appendPublicEventIfAbsent(tenant,
                                session.sessionId(), null, "test.event",
                                Map.of(), false, "rollback-source");
                        throw new IllegalStateException("roll back");
                    })).isInstanceOf(IllegalStateException.class);

            SessionEventHub.Delivery delivery = subscription.await(before,
                    Duration.ofMillis(20));
            assertThat(delivery.events()).isEmpty();
            assertThat(store.requireSession(tenant, session.sessionId())
                    .lastSequence()).isEqualTo(before);
        }
    }

    @Test
    void resolvesAnUncertainSubmitBeforeCancelling() throws Exception {
        String tenant = "tenant-uncertain-cancel";
        MvcResult created = mvc.perform(post(
                        "/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"uncertain-create",
                                 "agentId":"qwen-code","input":[]}
                                """))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString())
                .get("sessionId").asText();
        MvcResult submitted = mvc.perform(post(
                        "/api/agent/web-shell/v1/turns/submit")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"uncertain-turn",
                                 "sessionId":"%s",
                                 "input":[{"type":"text",
                                           "text":"uncertain"}]}
                                """.formatted(sessionId)))
                .andExpect(status().isAccepted()).andReturn();
        String turnId = objectMapper.readTree(
                submitted.getResponse().getContentAsString())
                .get("turnId").asText();
        await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                assertThat(harness.hasUncertainRetry()).isTrue());
        int cancellations = harness.cancelCount();

        mvc.perform(post("/api/agent/web-shell/v1/turns/cancel")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"uncertain-cancel",
                                 "sessionId":"%s","turnId":"%s"}
                                """.formatted(sessionId, turnId)))
                .andExpect(status().isAccepted());
        harness.releaseUncertainRetries();

        await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                assertThat(harness.cancelCount())
                        .isEqualTo(cancellations + 1));
        await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                mvc.perform(post(
                                "/api/agent/web-shell/v1/transcript/query")
                                .header(TenantContextFilter.HEADER, tenant)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"sessionId\":\"" + sessionId
                                        + "\",\"limit\":100}"))
                        .andExpect(status().isOk())
                        .andExpect(jsonPath("$.events[?(@.type =="
                                + " 'turn.cancelled')]").isNotEmpty()));
    }

    private MvcResult events(String tenant, String sessionId)
            throws Exception {
        return mvc.perform(get("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andReturn();
    }

    @TestConfiguration
    static class FixtureConfiguration {
        @Bean
        @Primary
        FixtureHarness fixtureHarness() {
            return new FixtureHarness();
        }
    }

    static final class FixtureHarness implements HarnessConnector {
        private final Map<String, String> promptIds =
                new ConcurrentHashMap<>();
        private final AtomicInteger submits = new AtomicInteger();
        private final AtomicInteger cancels = new AtomicInteger();
        private final AtomicInteger renames = new AtomicInteger();
        private final AtomicInteger closes = new AtomicInteger();
        private final AtomicInteger renameFailures = new AtomicInteger();
        private final Map<String, String> titles = new ConcurrentHashMap<>();
        private final Map<String, CountDownLatch> gates =
                new ConcurrentHashMap<>();
        private final Set<String> cancelled =
                ConcurrentHashMap.newKeySet();
        private final Set<String> sessions = ConcurrentHashMap.newKeySet();
        private final Map<String, AtomicInteger> uncertainAttempts =
                new ConcurrentHashMap<>();
        private final Map<String, CountDownLatch> uncertainGates =
                new ConcurrentHashMap<>();
        private final Set<String> uncertainRetries =
                ConcurrentHashMap.newKeySet();
        private volatile boolean available = true;

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public Attachment createOrLoad(String tenantId, String sessionId,
                boolean created) {
            sessions.add(sessionId);
            return new Attachment(
                    "11111111-1111-4111-8111-111111111111");
        }

        @Override
        public Admission submit(String tenantId, String sessionId,
                String promptId,
                List<Map<String, Object>> input, String payloadDigest) {
            promptIds.put(sessionId, promptId);
            boolean held = input.stream().anyMatch(block ->
                    "hold".equals(block.get("text")));
            if (held) {
                gates.put(sessionId, new CountDownLatch(1));
            }
            submits.incrementAndGet();
            boolean uncertain = input.stream().anyMatch(block ->
                    "uncertain".equals(block.get("text")));
            if (uncertain) {
                int attempt = uncertainAttempts.computeIfAbsent(
                        sessionId, ignored -> new AtomicInteger())
                        .incrementAndGet();
                if (attempt == 1) {
                    throw new IllegalStateException(
                            "fixture submit outcome is unknown");
                }
                CountDownLatch gate = uncertainGates.computeIfAbsent(
                        sessionId, ignored -> new CountDownLatch(1));
                uncertainRetries.add(sessionId);
                try {
                    gate.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                } finally {
                    uncertainRetries.remove(sessionId);
                }
            }
            return new Admission(0, "epoch-1");
        }

        @Override
        public SourceStream stream(String tenantId, String sessionId,
                long lastEventId,
                String eventEpoch) {
            String promptId = promptIds.get(sessionId);
            CountDownLatch gate = gates.get(sessionId);
            Queue<SourceEvent> events = new ArrayDeque<>();
            if (lastEventId < 1) {
                events.add(new SourceEvent(1L, "session_update", Map.of(
                        "update", Map.of(
                                "sessionUpdate", "agent_message_chunk",
                                "content", Map.of("type", "text", "text",
                                        "hello"))), promptId, Map.of()));
            }
            if (lastEventId < 2) {
                events.add(new SourceEvent(2L, "turn_complete", Map.of(
                        "stopReason", "end_turn"), promptId, Map.of()));
            }
            return new SourceStream() {
                @Override
                public String eventEpoch() {
                    return "epoch-1";
                }

                @Override
                public SourceEvent next() {
                    SourceEvent event = events.poll();
                    if (event != null && event.id() == 2L) {
                        if (gate != null) {
                            try {
                                gate.await(5, TimeUnit.SECONDS);
                            } catch (InterruptedException error) {
                                Thread.currentThread().interrupt();
                                return null;
                            }
                        }
                        if (cancelled.contains(sessionId)) {
                            return new SourceEvent(2L, "turn_complete",
                                    Map.of("stopReason", "cancelled"),
                                    promptId, Map.of());
                        }
                    }
                    return event;
                }

                @Override
                public void close() {
                }
            };
        }

        @Override
        public void cancel(String tenantId, String sessionId) {
            cancelled.add(sessionId);
            cancels.incrementAndGet();
        }

        @Override
        public void rename(String tenantId, String sessionId, String title) {
            renames.incrementAndGet();
            if (renameFailures.getAndUpdate(value -> Math.max(0,
                    value - 1)) > 0) {
                throw new IllegalStateException("fixture rename failure");
            }
            titles.put(sessionId, title);
        }

        @Override
        public void closeSession(String tenantId, String sessionId) {
            closes.incrementAndGet();
            sessions.remove(sessionId);
        }

        boolean hasSession(String sessionId) {
            return sessions.contains(sessionId);
        }

        int submitCount() {
            return submits.get();
        }

        int renameCount() {
            return renames.get();
        }

        int closeCount() {
            return closes.get();
        }

        String title(String sessionId) {
            return titles.get(sessionId);
        }

        void failNextRename() {
            renameFailures.incrementAndGet();
        }

        void setAvailable(boolean value) {
            available = value;
        }

        int cancelCount() {
            return cancels.get();
        }

        boolean hasHeldTurn() {
            return !gates.isEmpty();
        }

        void releaseHeldTurns() {
            gates.values().forEach(CountDownLatch::countDown);
            gates.clear();
        }

        boolean hasUncertainRetry() {
            return !uncertainRetries.isEmpty();
        }

        void releaseUncertainRetries() {
            uncertainGates.values().forEach(CountDownLatch::countDown);
            uncertainGates.clear();
        }

    }
}
