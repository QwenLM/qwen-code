package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
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
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-agent;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=50ms",
        "qwen.managed-agent.events.poll-interval=10ms"
})
@AutoConfigureMockMvc
@Import(ManagedAgentServerIntegrationTest.FixtureConfiguration.class)
class ManagedAgentServerIntegrationTest {
    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private FixtureHarness harness;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private JdbcTemplate jdbc;

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

        MvcResult newest = mvc.perform(post(
                        "/api/agent/web-shell/v1/transcript/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + sessionId
                                + "\",\"limit\":2}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasMore").value(true))
                .andExpect(jsonPath("$.olderCursor").isNotEmpty())
                .andReturn();
        JsonNode newestBody = objectMapper.readTree(
                newest.getResponse().getContentAsString());
        long newestFirst = newestBody.get("events").get(0)
                .get("sequence").asLong();
        String olderCursor = newestBody.get("olderCursor").asText();
        MvcResult older = mvc.perform(post(
                        "/api/agent/web-shell/v1/transcript/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + sessionId
                                + "\",\"cursor\":\"" + olderCursor
                                + "\",\"limit\":2}"))
                .andExpect(status().isOk()).andReturn();
        assertThat(objectMapper.readTree(
                        older.getResponse().getContentAsString())
                .get("events")).allMatch(event ->
                        event.get("sequence").asLong() < newestFirst);
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

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public Attachment createOrLoad(String sessionId,
                boolean created) {
            sessions.add(sessionId);
            return new Attachment(
                    "11111111-1111-4111-8111-111111111111");
        }

        @Override
        public Admission submit(String sessionId, String promptId,
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
        public SourceStream stream(String sessionId, long lastEventId,
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
        public void cancel(String sessionId) {
            cancelled.add(sessionId);
            cancels.incrementAndGet();
        }

        boolean hasSession(String sessionId) {
            return sessions.contains(sessionId);
        }

        int submitCount() {
            return submits.get();
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
