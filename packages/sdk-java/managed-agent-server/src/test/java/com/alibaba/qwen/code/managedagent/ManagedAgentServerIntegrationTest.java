package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ManagedSessionStoreController;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.service.SessionEventHub;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
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
import org.junit.jupiter.api.AfterEach;
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
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-agent;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.runtime-broker.enabled=false",
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

    @AfterEach
    void settleLeftoverTurnsAndRestoreHarness() {
        // Settle every Turn the test left non-terminal before the scanner
        // re-arms: this H2 database backs only this class, and a leftover
        // ACCEPTED/RUNNING/CANCELLING Turn (what findDispatchable reads)
        // would otherwise be claimed once its dispatch lease expires and
        // poison the counter-sensitive tests that run later in this shared
        // context.
        jdbc.update("UPDATE managed_agent_turn SET status = 'FAILED',"
                + " error_code = 'test_cleanup', completed_at = ?,"
                + " dispatch_owner = NULL, dispatch_lease_until = NULL,"
                + " retry_after = NULL WHERE status IN ('ACCEPTED',"
                + " 'RUNNING', 'CANCELLING')", System.currentTimeMillis());
        harness.setAvailable(true);
    }

    // This context pins the Runtime Broker off (which is also its shipped
    // default), so the dedicated recovery scheduler must not exist: a
    // deployment that never runs the tick should not pay for an idle
    // scheduler thread. The enabled side is pinned by
    // RuntimeBrokerConfigurationIntegrationTest.
    @Test
    void disabledBrokerDoesNotCreateTheRecoveryScheduler() {
        // The ungated sibling proves this context really loads the
        // configuration that declares both schedulers, so the absence below
        // cannot pass for the wrong reason.
        assertThat(applicationContext.containsBean("managedArtifactScheduler")).isTrue();
        assertThat(applicationContext.containsBean("runtimeRecoveryScheduler")).isFalse();
    }

    // Keeps the dispatch recovery scanner from claiming a Turn that the
    // test drives directly through the store: the scanner backs off while
    // the Harness is unavailable.
    private void pauseRecoveryScanning() {
        harness.setAvailable(false);
    }

    @Test
    void allowsRepeatingLifecycleOperationsWithNewCommandKeys() {
        String tenant = "tenant-repeat-" + UUID.randomUUID();
        String sessionId = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "create", "digest-create", "qwen-code", null,
                null, List.of(), null).sessionId();
        store.beginOperation(tenant, sessionId, OperationKind.CLOSE, "",
                "close", "digest-close");
        await().atMost(Duration.ofSeconds(5)).until(() -> "CLOSED".equals(
                store.requireSession(tenant, sessionId).status()));
        for (int cycle = 0; cycle < 2; cycle++) {
            String archive = "archive" + cycle;
            assertThat(store.beginOperation(tenant, sessionId,
                    OperationKind.ARCHIVE, "", archive, "digest-archive")
                    .replayed()).isFalse();
            assertThat(store.beginOperation(tenant, sessionId,
                    OperationKind.ARCHIVE, "", archive, "digest-archive")
                    .replayed()).isTrue();
            String unarchive = "unarchive" + cycle;
            store.beginSessionMutation(tenant, "UNARCHIVE_SESSION", unarchive,
                    "digest-unarchive", sessionId,
                    SessionMutationKind.UNARCHIVE);
            store.completeSessionMutation(tenant, "UNARCHIVE_SESSION",
                    unarchive, sessionId, SessionMutationKind.UNARCHIVE, null,
                    null);
            assertThat(store.beginSessionMutation(tenant, "UNARCHIVE_SESSION",
                    unarchive, "digest-unarchive", sessionId,
                    SessionMutationKind.UNARCHIVE).replayed()).isTrue();
        }
        assertThat(store.requireSession(tenant, sessionId).status())
                .isEqualTo("CLOSED");
        assertThat(store.findEvents(tenant, sessionId, 0, 100))
                .filteredOn(event -> "session.archived".equals(event.type()))
                .hasSize(2);
    }

    @Test
    void retriesReplayTheRevisionTheyWereAdmittedWith() {
        String tenant = "tenant-revision-" + UUID.randomUUID();
        CommandAdmission first = applicationContext
                .getBean(ManagedAgentService.class).createSession(tenant,
                        "revision-create", "qwen-code", "1", null, null,
                        List.of());
        ManagedAgentProperties changed = new ManagedAgentProperties();
        changed.setAgentRevision("2");
        ManagedWorkspaceRegistry workspaces = applicationContext.getBean(
                ManagedWorkspaceRegistry.class);
        ManagedAgentService upgraded = new ManagedAgentService(
                new ManagedAgentStore(jdbc, objectMapper, Clock.systemUTC(),
                        ignored -> {
                        }, workspaces, changed),
                applicationContext.getBean(RequestDigests.class),
                applicationContext.getBean(HarnessCoordinator.class),
                harness, workspaces);

        CommandAdmission retry = upgraded.createSession(tenant,
                "revision-create", "qwen-code", "1", null, null, List.of());
        assertThat(retry.sessionId()).isEqualTo(first.sessionId());
        assertThat(retry.replayed()).isTrue();
        assertThatThrownBy(() -> upgraded.createSession(tenant,
                "revision-create", "qwen-code", "2", null, null, List.of()))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("idempotency_conflict"));
        assertThatThrownBy(() -> upgraded.createSession(tenant,
                "revision-new", "qwen-code", "1", null, null, List.of()))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("unsupported_feature"));
        CommandAdmission omitted = upgraded.createSession(tenant,
                "revision-omitted", "qwen-code", null, null, null,
                List.of());
        assertThat(store.requireSession(tenant, omitted.sessionId())
                .agentRevision()).isEqualTo("2");
        assertThat(store.requireSession(tenant, first.sessionId())
                .agentRevision()).isEqualTo("1");
        assertThat(upgraded.getPublicSession(tenant, null, first.sessionId())
                .agentRevision()).isEqualTo("1");
    }

    @Test
    void answersUnacceptableMediaTypesWithNotAcceptable() throws Exception {
        mvc.perform(get("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, "tenant-xml")
                        .accept(MediaType.APPLICATION_XML))
                .andExpect(status().isNotAcceptable());
    }

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
    void missingSessionIdReturnsNotFound() throws Exception {
        mvc.perform(get("/v1/agents/sessions/")
                        .header(TenantContextFilter.HEADER, "tenant-empty-id"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("not_found"));
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
    void blocksUnknownRuntimeRecoveryWithoutSubmittingTheTurn()
            throws Exception {
        String tenant = "tenant-runtime-recovery";
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.hasUnknownOutcome()).thenReturn(true);
        harness.returnRuntimeRecovery(tenant, recovery);
        int submissions = harness.submitCount();

        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "runtime-recovery-create")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\","
                                + "\"input\":[{\"type\":\"text\","
                                + "\"text\":\"do not replay\"}]}"))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString()).get("id")
                .asText();

        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                mvc.perform(get("/v1/agents/sessions/{id}/events",
                                sessionId)
                                .header(TenantContextFilter.HEADER, tenant)
                                .accept(MediaType.APPLICATION_JSON))
                        .andExpect(status().isOk())
                        .andExpect(jsonPath("$.data[?(@.type =="
                                + " 'turn.failed')].data.code")
                                .value("managed_runtime_recovery_blocked")));
        assertThat(harness.submitCount()).isEqualTo(submissions);
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

        int closes = harness.closeCount(sessionId);
        lifecycle(post("/v1/agents/sessions/{id}/archive", sessionId), tenant,
                "lifecycle-archive-active")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_state_conflict"));
        JsonNode admitted = objectMapper.readTree(lifecycle(
                        post("/v1/agents/sessions/{id}/close", sessionId),
                        tenant, "lifecycle-close")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.session_id").value(sessionId))
                .andExpect(jsonPath("$.type").value("close"))
                .andExpect(jsonPath("$.status").value("pending"))
                .andExpect(jsonPath("$.admission_stage").value("java_durable"))
                .andExpect(jsonPath("$.delivery_state").value("pending"))
                .andExpect(jsonPath("$.receipt_id").doesNotExist())
                .andExpect(jsonPath("$.replayed").value(false))
                .andReturn().getResponse().getContentAsString());
        String closeId = admitted.get("id").asText();
        mvc.perform(post("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "closed-turn")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"agent.session.input.message\","
                                + "\"input\":[{\"type\":\"text\","
                                + "\"text\":\"blocked\"}]}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_not_active"));
        JsonNode closed = awaitOperation(tenant, sessionId, closeId);
        assertThat(closed.get("admission_stage").asText())
                .isEqualTo("harness_confirmed");
        assertThat(closed.get("delivery_state").asText())
                .isEqualTo("confirmed");
        assertThat(closed.get("receipt_id").asText()).startsWith("rcpt_");
        assertThat(closed.get("replayed").asBoolean()).isFalse();
        assertThat(harness.closeCount(sessionId)).isEqualTo(closes + 1);
        mvc.perform(get("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("closed"))
                .andExpect(jsonPath("$.capabilities.session_lifecycle")
                        .value(true));
        lifecycle(post("/v1/agents/sessions/{id}/close", sessionId), tenant,
                "lifecycle-close")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(closeId))
                .andExpect(jsonPath("$.status").value("completed"))
                .andExpect(jsonPath("$.receipt_id")
                        .value(closed.get("receipt_id").asText()))
                .andExpect(jsonPath("$.replayed").value(true));
        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "closed-rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"too late\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_state_conflict"));

        String archiveId = objectMapper.readTree(lifecycle(
                        post("/v1/agents/sessions/{id}/archive", sessionId),
                        tenant, "lifecycle-archive")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.type").value("archive"))
                .andExpect(jsonPath("$.status").value("completed"))
                .andExpect(jsonPath("$.admission_stage").value("java_durable"))
                .andExpect(jsonPath("$.delivery_state").value("confirmed"))
                .andExpect(jsonPath("$.receipt_id").isNotEmpty())
                .andReturn().getResponse().getContentAsString())
                .get("id").asText();
        mvc.perform(get("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("archived"));
        lifecycle(post("/v1/agents/sessions/{id}/archive", sessionId), tenant,
                "lifecycle-archive-again")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_state_conflict"));
        mvc.perform(post("/v1/agents/sessions/{id}/unarchive", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "lifecycle-unarchive"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("closed"));

        String deleteId = objectMapper.readTree(lifecycle(
                        delete("/v1/agents/sessions/{id}", sessionId), tenant,
                        "lifecycle-delete")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.type").value("delete"))
                .andReturn().getResponse().getContentAsString())
                .get("id").asText();
        JsonNode deleted = awaitOperation(tenant, sessionId, deleteId);
        assertThat(deleted.get("admission_stage").asText())
                .isEqualTo("java_durable");
        assertThat(harness.closeCount(sessionId)).isEqualTo(closes + 1);
        mvc.perform(get("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isNotFound());
        mvc.perform(get("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.id == '%s')]"
                        .formatted(sessionId)).isEmpty());
        mvc.perform(get("/v1/agents/sessions/{id}/operations/{op}",
                        sessionId, closeId)
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("completed"));
        lifecycle(delete("/v1/agents/sessions/{id}", sessionId), tenant,
                "lifecycle-delete")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(deleteId))
                .andExpect(jsonPath("$.replayed").value(true));
        lifecycle(delete("/v1/agents/sessions/{id}", sessionId), tenant,
                "lifecycle-delete-again")
                .andExpect(status().isNotFound());
        assertThat(store.findEvents(tenant, sessionId, 0, 100))
                .filteredOn(event -> event.type().startsWith("session.")
                        && !"session.created".equals(event.type())
                        && !event.type().startsWith("session.update"))
                .extracting(event -> event.type(),
                        event -> event.data().get("operationId"))
                .containsExactly(
                        tuple("session.close.requested", closeId),
                        tuple("session.closed", closeId),
                        tuple("session.archived", archiveId),
                        tuple("session.unarchive.requested", null),
                        tuple("session.unarchived", null),
                        tuple("session.delete.requested", deleteId),
                        tuple("session.deleted", deleteId));
    }

    @Test
    void rejectsCloseUntilTheActiveTurnSettles() throws Exception {
        String tenant = "tenant-close-active-" + UUID.randomUUID();
        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "close-active-create")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":["
                                + "{\"type\":\"text\",\"text\":\"hold\"}]}"))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString()).get("id").asText();
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                assertThat(harness.hasHeldTurn()).isTrue());
        int closes = harness.closeCount(sessionId);

        try {
            lifecycle(post("/v1/agents/sessions/{id}/close", sessionId),
                    tenant, "close-active")
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("turn_active"));
            lifecycle(delete("/v1/agents/sessions/{id}", sessionId), tenant,
                    "delete-active")
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("turn_active"));
            assertThat(harness.closeCount(sessionId)).isEqualTo(closes);
        } finally {
            harness.releaseHeldTurns();
        }

        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                assertThat(store.findActiveTurns(tenant,
                        java.util.List.of(sessionId)))
                        .doesNotContainKey(sessionId));
        String closeId = objectMapper.readTree(lifecycle(
                        post("/v1/agents/sessions/{id}/close", sessionId),
                        tenant, "close-active")
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString())
                .get("id").asText();
        awaitOperation(tenant, sessionId, closeId);
        assertThat(harness.closeCount(sessionId)).isEqualTo(closes + 1);
        assertThat(store.requireSession(tenant, sessionId).harnessBootId())
                .isNotNull();
    }

    @Test
    void deletesAClosedSessionWhileTheHarnessIsUnavailable()
            throws Exception {
        String tenant = "tenant-closed-delete-" + UUID.randomUUID();
        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "closed-delete-create")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":["
                                + "{\"type\":\"text\",\"text\":\"hello\"}]}"))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = objectMapper.readTree(
                created.getResponse().getContentAsString()).get("id").asText();
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> {
            assertThat(store.findActiveTurns(tenant,
                    java.util.List.of(sessionId)))
                    .doesNotContainKey(sessionId);
            assertThat(store.requireSession(tenant, sessionId).harnessBootId())
                    .isNotNull();
        });
        awaitOperation(tenant, sessionId, objectMapper.readTree(lifecycle(
                        post("/v1/agents/sessions/{id}/close", sessionId),
                        tenant, "closed-delete-close")
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString())
                .get("id").asText());
        int closes = harness.closeCount(sessionId);

        harness.setAvailable(false);
        try {
            String deleteId = objectMapper.readTree(lifecycle(
                            delete("/v1/agents/sessions/{id}", sessionId),
                            tenant, "closed-delete-delete")
                    .andExpect(status().isAccepted())
                    .andReturn().getResponse().getContentAsString())
                    .get("id").asText();
            awaitOperation(tenant, sessionId, deleteId);
        } finally {
            harness.setAvailable(true);
        }
        assertThat(harness.closeCount(sessionId)).isEqualTo(closes);
        assertThat(store.requireSession(tenant, sessionId).status())
                .isEqualTo("DELETED");
    }

    @Test
    void retriesAFailedRenameWithTheSameIdempotencyKey() throws Exception {
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

        // The answered failure retired its command row, so a different key
        // is admitted instead of wedging on session_operation_active.
        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "another-rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"blocked\"}"))
                .andExpect(status().isOk());

        // The retained failed receipt replays the same content and retries
        // the Harness mutation without duplicating the requested event.
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
                .hasSize(2);
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

        MvcResult submitted = mvc.perform(post(
                                "/api/agent/web-shell/v1/turns/submit")
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
                .andExpect(jsonPath("$.turnId").isNotEmpty())
                .andReturn();
        String turnId = objectMapper.readTree(
                submitted.getResponse().getContentAsString())
                .get("turnId").asText();

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

        store.appendPublicEventIfAbsent(tenant, sessionId, turnId,
                "environment.failed", Map.of(
                        "code", "runtime_warm_failed",
                        "environmentId", "local-runtime"), false,
                "test:environment:failed");
        mvc.perform(post("/api/agent/web-shell/v1/sessions/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + sessionId + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.activeTurn.status")
                        .value("completed"))
                .andExpect(jsonPath("$.environment.state").value("failed"))
                .andExpect(jsonPath("$.environment.environmentId")
                        .value("local-runtime"))
                .andExpect(jsonPath("$.environment.errorCode")
                        .value("runtime_warm_failed"));

        // The snapshot gate defers a caught-up rewrite until 5s after the
        // last one, so the trailing non-terminal event takes that long to
        // be covered.
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
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
                "sha256:" + "a".repeat(64), "qwen-code", null, null,
                List.of(), null);
        List<Map<String, Object>> input = List.of(Map.of(
                "type", "text", "text", "batch"));
        String owner = "batch-owner";
        Admission turn = new TransactionTemplate(transactionManager).execute(status -> {
            Admission admitted = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                    "batch-turn", "sha256:" + "b".repeat(64),
                    session.sessionId(), input, "sha256:" + "c".repeat(64));
            assertThat(store.claimTurn(tenant, session.sessionId(),
                    admitted.turnId(), owner, Duration.ofMinutes(1))).isPresent();
            return admitted;
        });
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
    void preservesTextOrderAcrossToolsAndReasoningInSnapshots() {
        String tenant = "tenant-order-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "order-create", "digest-create",
                "qwen-code", null, null, List.of(), null);
        String turnId = "turn-order";
        store.appendPublicEventIfAbsent(tenant, session.sessionId(), turnId,
                "item.output_text.delta", Map.of("text", "before"),
                false, "before");
        store.appendPublicEventIfAbsent(tenant, session.sessionId(), turnId,
                "item.tool_call.updated", Map.of("toolCallId", "tool-1"),
                false, "tool");
        store.appendPublicEventIfAbsent(tenant, session.sessionId(), turnId,
                "item.output_text.delta", Map.of("text", "after"),
                false, "after");
        store.appendPublicEventIfAbsent(tenant, session.sessionId(), turnId,
                "item.reasoning.delta", Map.of("text", "thought"),
                false, "thought");
        // The trailing event is terminal so the explicit drain below always
        // rewrites the snapshot: the 10ms materializer may otherwise create
        // the snapshot mid-sequence, and a non-terminal catch-up inside the
        // 5s floor would legally leave the snapshot behind.
        store.appendPublicEventIfAbsent(tenant, session.sessionId(), turnId,
                "item.output_text.delta", Map.of("text", "final"),
                true, "final");
        store.materializeNextBatch(tenant, session.sessionId(), 100);
        assertThat(store.findSnapshot(tenant, session.sessionId()))
                .get().satisfies(snapshot -> assertThat(snapshot.items())
                        .filteredOn(item -> "message".equals(item.type()))
                        .singleElement().satisfies(item ->
                                assertThat(item.content())
                                        .extracting(part -> part.text())
                                        .containsExactly("before", "after",
                                                "thought", "final")));
    }

    @Test
    void eventsNameTheSnapshotItemsAndPartsTheyChange() {
        String tenant = "tenant-identity-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "identity-create",
                "sha256:" + "d".repeat(64), "qwen-code", null, null,
                List.of(), null);
        String sessionId = session.sessionId();
        String owner = "identity-owner";
        Admission turn = new TransactionTemplate(transactionManager).execute(status -> {
            Admission admitted = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                    "identity-turn", "sha256:" + "e".repeat(64), sessionId,
                    List.of(Map.of("type", "text", "text", "hi")),
                    "sha256:" + "f".repeat(64));
            assertThat(store.claimTurn(tenant, sessionId, admitted.turnId(),
                    owner, Duration.ofMinutes(1))).isPresent();
            return admitted;
        });
        store.recordAdmission(tenant, sessionId, turn.turnId(), owner,
                "identity-epoch", 0);
        // The reasoning stream continues across the two batches.
        store.recordHarnessEvents(tenant, sessionId, turn.turnId(), owner,
                "identity-epoch", List.of(
                        harnessText(1, "item.output_text.delta", "a"),
                        harnessText(2, "item.output_text.delta", "b"),
                        harnessText(3, "item.reasoning.delta", "c")));
        store.recordHarnessEvents(tenant, sessionId, turn.turnId(), owner,
                "identity-epoch", List.of(
                        harnessText(4, "item.reasoning.delta", "d"),
                        new HarnessEvent(5, "boot:identity-epoch:5",
                                new ProjectedEvent("item.tool_call.updated",
                                        Map.of("toolCallId", "tool-1"), false,
                                        null, null, null)),
                        harnessText(6, "item.output_text.delta", "e"),
                        new HarnessEvent(7, "boot:identity-epoch:7",
                                new ProjectedEvent("turn.completed", Map.of(),
                                        true, "COMPLETED", null, null))));
        store.materializeNextBatch(tenant, sessionId, 200);

        List<EventRecord> events = assertEventsNameTheSnapshot(tenant,
                sessionId);
        List<EventRecord> deltas = events.stream()
                .filter(event -> event.type().endsWith(".delta")).toList();
        String output = "part_" + turn.turnId() + "_output_text_";
        String reasoning = "part_" + turn.turnId() + "_reasoning_";
        assertThat(deltas).extracting(EventRecord::contentPartId)
                .containsExactly(output + deltas.get(0).sequence(),
                        output + deltas.get(0).sequence(),
                        reasoning + deltas.get(2).sequence(),
                        reasoning + deltas.get(2).sequence(),
                        output + deltas.get(4).sequence());
        assertThat(events).filteredOn(event -> event.itemId() != null)
                .extracting(EventRecord::type).containsExactly(
                        "turn.accepted", "item.output_text.delta",
                        "item.output_text.delta", "item.reasoning.delta",
                        "item.reasoning.delta", "item.tool_call.updated",
                        "item.output_text.delta");
    }

    @Test
    void singleAppendsContinueTheTextPartBeforeThem() {
        String tenant = "tenant-single-identity-" + UUID.randomUUID();
        String sessionId = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "single-identity-create", "digest-create",
                "qwen-code", null, null, List.of(), null).sessionId();
        for (String text : List.of("a", "b")) {
            store.appendPublicEventIfAbsent(tenant, sessionId, "turn-single",
                    "item.output_text.delta", Map.of("text", text), false,
                    "single:" + text);
        }
        // The trailing event is terminal so the explicit drain below always
        // rewrites the snapshot: the 10ms materializer may otherwise create
        // the snapshot mid-sequence, and a non-terminal catch-up inside the
        // 5s floor would legally leave the snapshot behind.
        store.appendPublicEventIfAbsent(tenant, sessionId, "turn-single",
                "item.reasoning.delta", Map.of("text", "c"), true,
                "single:c");
        store.materializeNextBatch(tenant, sessionId, 100);

        List<EventRecord> deltas = assertEventsNameTheSnapshot(tenant,
                sessionId).stream()
                .filter(event -> event.type().endsWith(".delta")).toList();
        assertThat(deltas).extracting(EventRecord::contentPartId)
                .containsExactly(
                        "part_turn-single_output_text_"
                                + deltas.get(0).sequence(),
                        "part_turn-single_output_text_"
                                + deltas.get(0).sequence(),
                        "part_turn-single_reasoning_"
                                + deltas.get(2).sequence());
    }

    @Test
    void retractionRenamesTheDeltaThatContinuedTheRetractedOne() {
        pauseRecoveryScanning();
        String tenant = "tenant-retract-identity-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "retract-identity-create",
                "sha256:" + "7".repeat(64), "qwen-code", null, null,
                List.of(), null);
        String sessionId = session.sessionId();
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "retract-identity-turn", "sha256:" + "8".repeat(64),
                sessionId, List.of(), "sha256:" + "9".repeat(64));
        String owner = "retract-identity-owner";
        assertThat(store.claimTurn(tenant, sessionId, turn.turnId(), owner,
                Duration.ofMinutes(1))).isPresent();
        assertThat(store.bindHarness(tenant, sessionId, turn.turnId(), owner,
                "boot_old")).isTrue();
        store.markSubmissionAttempted(tenant, sessionId, turn.turnId(),
                owner);
        store.recordAdmission(tenant, sessionId, turn.turnId(), owner,
                "epoch_old", 1);
        // The kept delta continues the Part of the one that is retracted.
        store.recordHarnessEvents(tenant, sessionId, turn.turnId(), owner,
                "epoch_old", List.of(
                        new HarnessEvent(2, "boot_old:epoch_old:2",
                                new ProjectedEvent("item.output_text.delta",
                                        Map.of("text", "partial"), false,
                                        null, null, null)),
                        new HarnessEvent(3, "boot_kept:epoch_old:3",
                                new ProjectedEvent("item.output_text.delta",
                                        Map.of("text", "kept"), false, null,
                                        null, null))));
        List<EventRecord> before = store.findEvents(tenant, sessionId, 0, 20)
                .stream().filter(event -> event.type().endsWith(".delta"))
                .toList();
        assertThat(before).extracting(EventRecord::contentPartId)
                .containsOnly(before.get(0).contentPartId());

        store.retractContinuationOutput(tenant, sessionId, turn.turnId(),
                owner, "boot_old", "epoch_old");
        store.materializeNextBatch(tenant, sessionId, 100);

        assertThat(assertEventsNameTheSnapshot(tenant, sessionId))
                .filteredOn(event -> event.type().endsWith(".delta"))
                .extracting(EventRecord::itemId, EventRecord::contentPartId)
                .containsExactly(tuple(null, null), tuple(
                        "item_" + turn.turnId() + "_assistant",
                        "part_" + turn.turnId() + "_output_text_"
                                + before.get(1).sequence()));
    }

    // Every event that names an Item or a Part names one of the Snapshot.
    private List<EventRecord> assertEventsNameTheSnapshot(String tenant,
            String sessionId) {
        List<ItemRecord> items = store.findSnapshot(tenant, sessionId)
                .orElseThrow().items();
        List<EventRecord> events = store.findEvents(tenant, sessionId, 0,
                100);
        for (EventRecord event : events) {
            assertThat(event.schemaVersion()).isEqualTo(1);
            assertThat(event.projectionVersion()).isEqualTo(1);
            if (event.itemId() == null) {
                continue;
            }
            ItemRecord item = items.stream().filter(candidate ->
                    candidate.itemId().equals(event.itemId()))
                    .findFirst().orElseThrow();
            if (event.contentPartId() != null) {
                assertThat(item.content()).filteredOn(part ->
                                part.partId().equals(event.contentPartId()))
                        .singleElement().satisfies(part -> assertThat(
                                event.sequence()).isBetween(
                                        part.firstSequence(),
                                        part.lastSequence()));
            }
        }
        return events;
    }

    private static HarnessEvent harnessText(long sourceId, String type,
            String text) {
        return new HarnessEvent(sourceId, "boot:identity-epoch:" + sourceId,
                new ProjectedEvent(type, Map.of("text", text), false, null,
                        null, null));
    }

    @Test
    void ignoresLateEnvironmentResultFromAnOlderTurn() {
        pauseRecoveryScanning();
        String tenant = "tenant-environment-order-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "environment-create",
                "sha256:" + "1".repeat(64), "qwen-code", null, null,
                List.of(), null);
        Admission first = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "environment-turn-1", "sha256:" + "2".repeat(64),
                session.sessionId(), List.of(),
                "sha256:" + "3".repeat(64));
        String owner = "environment-owner";
        assertThat(store.claimTurn(tenant, session.sessionId(), first.turnId(),
                owner, Duration.ofMinutes(1))).isPresent();
        store.cancelBeforeAdmission(tenant, session.sessionId(),
                first.turnId(), owner);
        Admission second = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "environment-turn-2", "sha256:" + "4".repeat(64),
                session.sessionId(), List.of(),
                "sha256:" + "5".repeat(64));

        store.appendPublicEventIfAbsent(tenant, session.sessionId(),
                second.turnId(), "environment.ready", Map.of(), false,
                "environment:second:ready");
        store.appendPublicEventIfAbsent(tenant, session.sessionId(),
                first.turnId(), "environment.failed",
                Map.of("code", "runtime_warm_failed"), false,
                "environment:first:failed");

        assertThat(store.findLatestEnvironmentEvents(tenant,
                store.findLatestTurns(tenant,
                        java.util.List.of(session.sessionId())))
                        .get(session.sessionId())).satisfies(event -> {
                    assertThat(event.turnId()).isEqualTo(second.turnId());
                    assertThat(event.type()).isEqualTo("environment.ready");
                });
    }

    @Test
    void persistsRetryBackoffAcrossClaims() {
        pauseRecoveryScanning();
        String tenant = "tenant-retry-backoff-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "retry-create",
                "sha256:" + "1".repeat(64), "qwen-code", null, null,
                List.of(), null);
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "retry-turn", "sha256:" + "2".repeat(64),
                session.sessionId(), List.of(),
                "sha256:" + "3".repeat(64));
        String firstOwner = "retry-owner-1";
        assertThat(store.claimTurn(tenant, session.sessionId(), turn.turnId(),
                firstOwner, Duration.ofMinutes(1))).isPresent();
        long retryAfter = System.currentTimeMillis() + 60_000;

        store.scheduleTurnRetry(tenant, session.sessionId(), turn.turnId(),
                firstOwner, retryAfter);

        assertThat(store.findTurn(tenant, session.sessionId(), turn.turnId()))
                .get().satisfies(record -> {
                    assertThat(record.retryCount()).isEqualTo(1);
                    assertThat(record.retryAfter()).isEqualTo(retryAfter);
                    assertThat(record.dispatchOwner()).isNull();
                });
        DispatchTarget target = new DispatchTarget(tenant,
                session.sessionId(), turn.turnId());
        assertThat(store.findDispatchable(retryAfter - 1, 100))
                .doesNotContain(target);
        assertThat(store.claimTurn(tenant, session.sessionId(), turn.turnId(),
                "retry-owner-2", Duration.ofMinutes(1))).isEmpty();
        assertThat(store.findDispatchable(retryAfter, 100))
                .contains(target);
    }

    @Test
    void transfersHarnessGenerationOnlyBeforeAdmissionUnderDispatchLease() {
        pauseRecoveryScanning();
        String tenant = "tenant-harness-takeover-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "takeover-create",
                "sha256:" + "d".repeat(64), "qwen-code", null, null,
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
    void recoversAdmittedHarnessGenerationAndEventEpochUnderDispatchLease() {
        pauseRecoveryScanning();
        String tenant = "tenant-harness-recovery-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "recovery-create",
                "sha256:" + "1".repeat(64), "qwen-code", null, null,
                List.of(), null);
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "recovery-turn", "sha256:" + "2".repeat(64),
                session.sessionId(), List.of(Map.of(
                        "type", "text", "text", "recover")),
                "sha256:" + "3".repeat(64));
        String owner = "recovery-owner";
        assertThat(store.claimTurn(tenant, session.sessionId(),
                turn.turnId(), owner, Duration.ofMinutes(1))).isPresent();
        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-old")).isTrue();
        store.markSubmissionAttempted(tenant, session.sessionId(),
                turn.turnId(), owner);
        store.recordAdmission(tenant, session.sessionId(), turn.turnId(),
                owner, "epoch-old", 7);

        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-new")).isFalse();
        assertThat(store.bindRecoveredHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-wrong", "boot-new"))
                .isFalse();
        assertThat(store.bindRecoveredHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-old", "boot-new"))
                .isTrue();
        assertThat(store.bindRecoveredHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot-old", "boot-new"))
                .isTrue();

        store.recordRecoveryAdmission(tenant, session.sessionId(),
                turn.turnId(), owner, "epoch-old", "epoch-old", "epoch-new",
                0);
        store.recordRecoveryAdmission(tenant, session.sessionId(),
                turn.turnId(), owner, "epoch-old", "epoch-old", "epoch-new",
                0);
        store.recordRecoveryAdmission(tenant, session.sessionId(),
                turn.turnId(), owner, "epoch-new", "epoch-new", "epoch-new",
                3);

        assertThat(store.requireSession(tenant, session.sessionId()))
                .satisfies(record -> {
                    assertThat(record.harnessBootId()).isEqualTo("boot-new");
                    assertThat(record.harnessEventEpoch())
                            .isEqualTo("epoch-new");
                    assertThat(record.harnessLastEventId()).isEqualTo(3);
                });
        assertThat(store.findTurn(tenant, session.sessionId(), turn.turnId()))
                .get().satisfies(record -> {
                    assertThat(record.submissionAttempted()).isTrue();
                    assertThat(record.harnessEventEpoch())
                            .isEqualTo("epoch-new");
                    assertThat(record.harnessLastEventId()).isEqualTo(3);
                    assertThat(record.status()).isEqualTo("RUNNING");
                });
        assertThatThrownBy(() -> store.recordRecoveryAdmission(tenant,
                session.sessionId(), turn.turnId(), owner, "epoch-old",
                "epoch-old", "epoch-other", 0)).isInstanceOfSatisfying(
                        IllegalStateException.class, error ->
                                assertThat(error.getMessage()).contains(
                                        "recovery epoch changed"));
    }

    // A lost admission reply leaves the Turn epoch NULL while the Session
    // still carries an earlier generation's: the adoption CAS must expect
    // each as it stands (R10-4). The epoch predicates are null-safe, not
    // `= NULL` (which never matches), so this must succeed against the
    // real store where the Mockito suite can only mock it away.
    @Test
    void adoptsRecoveryAdmissionOntoANullTurnEpoch() {
        pauseRecoveryScanning();
        String tenant = "tenant-harness-null-epoch-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "null-epoch-create",
                "sha256:" + "1".repeat(64), "qwen-code", null, null,
                List.of(), null);
        Admission first = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "null-epoch-first", "sha256:" + "2".repeat(64),
                session.sessionId(), List.of(Map.of(
                        "type", "text", "text", "first")),
                "sha256:" + "3".repeat(64));
        String owner = "null-epoch-owner";
        assertThat(store.claimTurn(tenant, session.sessionId(),
                first.turnId(), owner, Duration.ofMinutes(1))).isPresent();
        assertThat(store.bindHarness(tenant, session.sessionId(),
                first.turnId(), owner, "boot-old")).isTrue();
        store.markSubmissionAttempted(tenant, session.sessionId(),
                first.turnId(), owner);
        store.recordAdmission(tenant, session.sessionId(), first.turnId(),
                owner, "epoch-0", 4);
        store.recordHarnessEvents(tenant, session.sessionId(),
                first.turnId(), owner, "epoch-0", List.of(new HarnessEvent(5,
                        "boot-old:epoch-0:5", new ProjectedEvent(
                                "turn.completed", Map.of(), true,
                                "COMPLETED", null, null))));
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "null-epoch-turn", "sha256:" + "4".repeat(64),
                session.sessionId(), List.of(Map.of(
                        "type", "text", "text", "lost reply")),
                "sha256:" + "5".repeat(64));
        assertThat(store.claimTurn(tenant, session.sessionId(),
                turn.turnId(), owner, Duration.ofMinutes(1))).isPresent();
        store.markSubmissionAttempted(tenant, session.sessionId(),
                turn.turnId(), owner);
        // Turn epoch NULL (the reply was lost), Session epoch epoch-0.
        store.recordRecoveryAdmission(tenant, session.sessionId(),
                turn.turnId(), owner, null, "epoch-0", "epoch-new", 4);
        assertThat(store.findTurn(tenant, session.sessionId(), turn.turnId()))
                .get().satisfies(record -> {
                    assertThat(record.harnessEventEpoch())
                            .isEqualTo("epoch-new");
                    assertThat(record.harnessLastEventId()).isEqualTo(4);
                });
        assertThat(store.requireSession(tenant, session.sessionId())
                .harnessEventEpoch()).isEqualTo("epoch-new");
        // A wrong expected Session epoch is still refused, null-safe or
        // not: the CAS keeps proving the row it moves.
        assertThatThrownBy(() -> store.recordRecoveryAdmission(tenant,
                session.sessionId(), turn.turnId(), owner, null,
                "epoch-wrong", "epoch-later", 4))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("recovery epoch changed");
    }

    @Test
    void retractsOnlyTheIncompleteContinuationEpoch() {
        pauseRecoveryScanning();
        String tenant = "tenant-retract-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "retract-create",
                "sha256:" + "4".repeat(64), "qwen-code", null, null,
                List.of(), null);
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "retract-turn", "sha256:" + "5".repeat(64),
                session.sessionId(), List.of(),
                "sha256:" + "6".repeat(64));
        String owner = "retract-owner";
        assertThat(store.claimTurn(tenant, session.sessionId(),
                turn.turnId(), owner, Duration.ofMinutes(1))).isPresent();
        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot_old")).isTrue();
        store.markSubmissionAttempted(tenant, session.sessionId(),
                turn.turnId(), owner);
        store.recordAdmission(tenant, session.sessionId(), turn.turnId(),
                owner, "epoch_old", 1);
        store.recordHarnessEvents(tenant, session.sessionId(), turn.turnId(),
                owner, "epoch_old", List.of(
                        new HarnessEvent(2, "boot_old:epoch_old:2",
                                new ProjectedEvent("item.output_text.delta",
                                        Map.of("text", "partial"), false,
                                        null, null, null)),
                        new HarnessEvent(3, "boot_old:epoch_old:3",
                                new ProjectedEvent("item.tool_call.updated",
                                        Map.of(), false, null, null, null)),
                        new HarnessEvent(4, "boot_kept:epoch_old:4",
                                new ProjectedEvent("item.output_text.delta",
                                        Map.of("text", "kept"), false, null,
                                        null, null))));

        store.materializeNextBatch(tenant, session.sessionId(), 100);
        assertThat(store.findSnapshot(tenant, session.sessionId()))
                .isPresent();

        store.retractContinuationOutput(tenant, session.sessionId(),
                turn.turnId(), owner, "boot_old", "epoch_old");

        assertThat(store.findEvents(tenant, session.sessionId(), 0, 20))
                .satisfies(events -> {
                    assertThat(events).extracting(event -> event.type()
                                    + ":" + event.sourceKey())
                            .contains(
                                    "item.output_text.delta:boot_old:epoch_old:2",
                                    "item.tool_call.updated:boot_old:epoch_old:3",
                                    "item.output_text.delta:boot_kept:epoch_old:4");
                    assertThat(events).filteredOn(event ->
                                    "boot_old:epoch_old:2".equals(
                                            event.sourceKey()))
                            .singleElement()
                            .satisfies(event -> assertThat(event.data())
                                    .containsEntry("text", ""));
                    assertThat(events).filteredOn(event ->
                                    "boot_kept:epoch_old:4".equals(
                                            event.sourceKey()))
                            .singleElement()
                            .satisfies(event -> assertThat(event.data())
                                    .containsEntry("text", "kept"));
                });
        assertThat(store.findEvents(tenant, session.sessionId(), 0, 20))
                .filteredOn(event -> "stream.reconciled".equals(event.type()))
                .hasSize(1);
        store.materializeNextBatch(tenant, session.sessionId(), 100);
        assertThat(store.findSnapshot(tenant, session.sessionId()))
                .get().satisfies(snapshot -> assertThat(snapshot.items())
                        .filteredOn(item -> "message".equals(item.type())
                                && "assistant".equals(item.role()))
                        .singleElement().satisfies(item ->
                                assertThat(item.content()).singleElement()
                                        .satisfies(part -> assertThat(
                                                part.text())
                                                .isEqualTo("kept"))));
        assertEventsNameTheSnapshot(tenant, session.sessionId());
    }

    // #13319: a restarted model attempt retracts the published prefix of the
    // message it replaces. Deltas of earlier committed rounds carry smaller
    // source ids and stay; the retraction is idempotent and advances the
    // Harness cursor either way.
    @Test
    void retractsInBandRetryOutputFromItsFirstDelta() {
        pauseRecoveryScanning();
        String tenant = "tenant-inband-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "inband-create",
                "sha256:" + "4".repeat(64), "qwen-code", null, null,
                List.of(), null);
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "inband-turn", "sha256:" + "5".repeat(64),
                session.sessionId(), List.of(),
                "sha256:" + "6".repeat(64));
        String owner = "inband-owner";
        assertThat(store.claimTurn(tenant, session.sessionId(),
                turn.turnId(), owner, Duration.ofMinutes(1))).isPresent();
        assertThat(store.bindHarness(tenant, session.sessionId(),
                turn.turnId(), owner, "boot_1")).isTrue();
        store.markSubmissionAttempted(tenant, session.sessionId(),
                turn.turnId(), owner);
        store.recordAdmission(tenant, session.sessionId(), turn.turnId(),
                owner, "epoch_1", 1);
        store.recordHarnessEvents(tenant, session.sessionId(), turn.turnId(),
                owner, "epoch_1", List.of(
                        new HarnessEvent(2, "boot_1:epoch_1:2",
                                new ProjectedEvent("item.output_text.delta",
                                        Map.of("text", "kept"), false,
                                        null, null, null)),
                        new HarnessEvent(3, "boot_1:epoch_1:3",
                                new ProjectedEvent("item.output_text.delta",
                                        Map.of("text", "orphaned "), false,
                                        null, null, null)),
                        new HarnessEvent(4, "boot_1:epoch_1:4",
                                new ProjectedEvent("item.output_text.delta",
                                        Map.of("text", "prefix"), false,
                                        null, null, null))));
        store.materializeNextBatch(tenant, session.sessionId(), 100);
        assertThat(store.findSnapshot(tenant, session.sessionId()))
                .isPresent();

        store.retractHarnessTurnOutput(tenant, session.sessionId(),
                turn.turnId(), owner, "epoch_1", 3, 5);

        assertThat(store.findEvents(tenant, session.sessionId(), 0, 20))
                .satisfies(events -> {
                    assertThat(events).filteredOn(event ->
                                    "boot_1:epoch_1:2".equals(
                                            event.sourceKey()))
                            .singleElement()
                            .satisfies(event -> assertThat(event.data())
                                    .containsEntry("text", "kept"));
                    assertThat(events).filteredOn(event ->
                                    event.sourceKey() != null
                                            && (event.sourceKey().equals(
                                                    "boot_1:epoch_1:3")
                                                    || event.sourceKey().equals(
                                                            "boot_1:epoch_1:4")))
                            .allSatisfy(event -> {
                                assertThat(event.data())
                                        .containsEntry("text", "");
                                assertThat(event.itemId()).isNull();
                                assertThat(event.contentPartId()).isNull();
                            });
                });
        assertThat(store.findEvents(tenant, session.sessionId(), 0, 20))
                .filteredOn(event -> "stream.reconciled".equals(event.type()))
                .hasSize(1);
        assertThat(store.findTurn(tenant, session.sessionId(), turn.turnId()))
                .get().satisfies(record -> assertThat(
                        record.harnessLastEventId()).isEqualTo(5));
        store.materializeNextBatch(tenant, session.sessionId(), 100);
        assertThat(store.findSnapshot(tenant, session.sessionId()))
                .get().satisfies(snapshot -> assertThat(snapshot.items())
                        .filteredOn(item -> "message".equals(item.type())
                                && "assistant".equals(item.role()))
                        .singleElement().satisfies(item ->
                                assertThat(item.content()).singleElement()
                                        .satisfies(part -> assertThat(
                                                part.text()).isEqualTo("kept"))));
        assertEventsNameTheSnapshot(tenant, session.sessionId());

        // A redelivered retraction does not retract again, but the cursor
        // still advances past it.
        store.retractHarnessTurnOutput(tenant, session.sessionId(),
                turn.turnId(), owner, "epoch_1", 3, 6);
        assertThat(store.findEvents(tenant, session.sessionId(), 0, 20))
                .filteredOn(event -> "stream.reconciled".equals(event.type()))
                .hasSize(1);
        assertThat(store.findTurn(tenant, session.sessionId(), turn.turnId()))
                .get().satisfies(record -> assertThat(
                        record.harnessLastEventId()).isEqualTo(6));

        assertThatThrownBy(() -> store.retractHarnessTurnOutput(tenant,
                session.sessionId(), turn.turnId(), owner, "epoch_other", 3,
                7)).isInstanceOfSatisfying(IllegalStateException.class,
                        error -> assertThat(error.getMessage()).contains(
                                "event epoch changed"));
    }

    @Test
    void doesNotPublishRolledBackEvents() throws Exception {
        String tenant = "tenant-rollback-" + UUID.randomUUID();
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "rollback-create",
                "sha256:" + "d".repeat(64), "qwen-code", null, null,
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
        // Nothing may cancel the Turn while its submit is unresolved.
        await().during(Duration.ofMillis(200)).atMost(Duration.ofSeconds(2))
                .untilAsserted(() -> assertThat(harness.cancelCount())
                        .isEqualTo(cancellations));
        harness.releaseUncertainRetries();

        // Once the Turn is admitted, the dispatch that resolved the submit
        // and the queued cancellation can each deliver the cancel; the
        // Hosted Harness treats a repeat as a no-op.
        await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                assertThat(harness.cancelCount())
                        .isGreaterThan(cancellations));
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

    private ResultActions lifecycle(MockHttpServletRequestBuilder request,
            String tenant, String idempotencyKey) throws Exception {
        return mvc.perform(request.header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", idempotencyKey));
    }

    private JsonNode awaitOperation(String tenant, String sessionId,
            String operationId) {
        JsonNode[] operation = new JsonNode[1];
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            operation[0] = objectMapper.readTree(mvc.perform(get(
                            "/v1/agents/sessions/{id}/operations/{op}",
                            sessionId, operationId)
                            .header(TenantContextFilter.HEADER, tenant))
                    .andExpect(status().isOk())
                    .andReturn().getResponse().getContentAsString());
            assertThat(operation[0].get("status").asText())
                    .isEqualTo("completed");
        });
        return operation[0];
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
        static final String BOOT_ID = "11111111-1111-4111-8111-111111111111";
        private final Map<String, String> promptIds =
                new ConcurrentHashMap<>();
        private final AtomicInteger submits = new AtomicInteger();
        private final AtomicInteger cancels = new AtomicInteger();
        private final AtomicInteger renames = new AtomicInteger();
        private final AtomicInteger closes = new AtomicInteger();
        private final Map<String, AtomicInteger> sessionCloses =
                new ConcurrentHashMap<>();
        private final AtomicInteger renameFailures = new AtomicInteger();
        private final AtomicInteger closeFailures = new AtomicInteger();
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
        private volatile String closeAnswer = BOOT_ID;
        private final Map<String, HarnessRuntimeRecovery>
                tenantRecoveries = new ConcurrentHashMap<>();

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public Attachment createOrLoad(String tenantId, String sessionId,
                boolean created) {
            sessions.add(sessionId);
            // Keyed by tenant: a shared-scope fixture consumes its own arm;
            // another test's background claim can never steal it.
            return new Attachment(BOOT_ID,
                    tenantRecoveries.remove(tenantId));
        }

        @Override
        public Attachment recoverManagedRuntime(String tenantId,
                String sessionId, boolean cancellation) {
            return createOrLoad(tenantId, sessionId, true);
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
        public String closeSession(String tenantId, String sessionId) {
            closes.incrementAndGet();
            sessionCloses.computeIfAbsent(sessionId,
                    ignored -> new AtomicInteger()).incrementAndGet();
            if (closeFailures.getAndUpdate(value -> Math.max(0,
                    value - 1)) > 0) {
                throw new IllegalStateException("fixture close failure");
            }
            sessions.remove(sessionId);
            return closeAnswer;
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

        int closeCount(String sessionId) {
            AtomicInteger count = sessionCloses.get(sessionId);
            return count == null ? 0 : count.get();
        }

        String title(String sessionId) {
            return titles.get(sessionId);
        }

        void failNextRename() {
            renameFailures.incrementAndGet();
        }

        void failNextClose() {
            closeFailures.incrementAndGet();
        }

        // Every close fails while the count lasts, as with an unreachable
        // Harness.
        void failCloses(int count) {
            closeFailures.set(count);
        }

        // Closes are answered by another boot, as by a restarted Harness;
        // null restores the boot that attaches Sessions.
        void answerClosesAs(String bootId) {
            closeAnswer = bootId == null ? BOOT_ID : bootId;
        }

        void setAvailable(boolean value) {
            available = value;
        }

        void returnRuntimeRecovery(String tenantId,
                HarnessRuntimeRecovery recovery) {
            tenantRecoveries.put(tenantId, recovery);
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
