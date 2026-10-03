package com.alibaba.qwen.code.managedagent;

import org.springframework.http.HttpStatus;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.params.ParameterizedTest;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.AdditionalAnswers.delegatesTo;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
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
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Durable close, archive and delete: an operation outlives an unavailable
 * Harness, failed attempts and a lost worker, never completes before its
 * Harness close and Runtime drain, and replays only for the same Session,
 * kind, actor and key.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-session-lifecycle;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=50ms",
        "qwen.managed-agent.dispatch.retry-initial-delay=50ms",
        "qwen.managed-agent.dispatch.retry-max-delay=100ms",
        "qwen.managed-agent.events.poll-interval=10ms",
        "qwen.managed-agent.events.materialize-interval=10ms"
})
@AutoConfigureMockMvc
@Import({ManagedAgentServerIntegrationTest.FixtureConfiguration.class,
        ManagedSessionLifecycleTest.DrainConfiguration.class})
class ManagedSessionLifecycleTest {
    private static final String TENANT = TenantContextFilter.HEADER;
    private static final String WEB_SHELL = "/api/agent/web-shell/v1";
    // The boot of a Harness that does not hold the Session.
    private static final String OTHER_BOOT =
            "22222222-2222-4222-8222-222222222222";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private FixtureHarness harness;

    @Autowired
    private RecordingRuntimeWarmer runtime;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private ManagedSessionStore sessionStore;

    @Test
    void closeWaitsForTheHarnessAndCompletesWhenItReturns() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        String closeId;
        harness.failCloses(Integer.MAX_VALUE);
        try {
            closeId = admit(post("/v1/agents/sessions/{id}/close", sessionId),
                    tenant, "close").get("id").asText();
            await().atMost(Duration.ofSeconds(5))
                    .until(() -> attempts(closeId) >= 2);
            JsonNode waiting = operation(tenant, sessionId, closeId);
            assertThat(waiting.get("status").asText()).isEqualTo("running");
            assertThat(waiting.get("admission_stage").asText())
                    .isEqualTo("java_durable");
            assertThat(waiting.has("receipt_id")).isFalse();
            assertThat(sessionStatus(tenant, sessionId)).isEqualTo("closing");
            assertThat(runtime.drained()).doesNotContain(sessionId);
        } finally {
            harness.failCloses(0);
        }
        JsonNode closed = awaitCompleted(tenant, sessionId, closeId);
        assertThat(closed.get("admission_stage").asText())
                .isEqualTo("harness_confirmed");
        // Every failed attempt tried to close; the last one closed.
        assertThat(harness.closeCount(sessionId))
                .isEqualTo(attempts(closeId) + 1);
        assertThat(harness.hasSession(sessionId)).isFalse();
        assertThat(runtime.drained()).containsOnlyOnce(sessionId);
        assertThat(sessionStatus(tenant, sessionId)).isEqualTo("closed");
    }

    @Test
    void completesOnlyAfterAFailedCloseAndDrainAreRetried() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        harness.failNextClose();
        runtime.failDrains(Integer.MAX_VALUE);
        String closeId;
        try {
            closeId = admit(post("/v1/agents/sessions/{id}/close", sessionId),
                    tenant, "close").get("id").asText();
            await().atMost(Duration.ofSeconds(5))
                    .until(() -> attempts(closeId) >= 3);
            assertThat(operation(tenant, sessionId, closeId).get("status")
                    .asText()).isEqualTo("running");
            assertThat(sessionStatus(tenant, sessionId)).isEqualTo("closing");
            // The Harness is up, so only the sealed Session rejects input.
            mvc.perform(post("/v1/agents/sessions/{id}/events", sessionId)
                            .header(TENANT, tenant)
                            .header("Idempotency-Key", "sealed")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("""
                                    {"type":"agent.session.input.message",
                                     "input":[{"type":"input_text",
                                               "text":"late"}]}
                                    """))
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code")
                            .value("session_not_active"));
        } finally {
            runtime.failDrains(0);
        }
        awaitCompleted(tenant, sessionId, closeId);
        // The first attempt fails to close; every later attempt closes
        // again, which the Harness accepts, and only the last one drains.
        assertThat(harness.closeCount(sessionId))
                .isEqualTo(attempts(closeId) + 1);
        assertThat(runtime.drained()).containsOnlyOnce(sessionId);
    }

    @Test
    void closesASessionThatNoHarnessHeld() throws Exception {
        String tenant = tenant();
        String unconfigured = emptySession(tenant);
        // Without a Harness there is nothing to ask.
        harness.setAvailable(false);
        try {
            String closeId = admit(post("/v1/agents/sessions/{id}/close",
                    unconfigured), tenant, "close").get("id").asText();
            assertThat(awaitCompleted(tenant, unconfigured, closeId)
                    .get("admission_stage").asText())
                    .isEqualTo("java_durable");
        } finally {
            harness.setAvailable(true);
        }
        assertThat(harness.closeCount(unconfigured)).isZero();
        assertThat(runtime.drained()).containsOnlyOnce(unconfigured);

        // A Harness is asked anyway, but it did not hold the Session, so its
        // answer confirms nothing.
        String configured = emptySession(tenant);
        String closeId = admit(post("/v1/agents/sessions/{id}/close",
                configured), tenant, "close").get("id").asText();
        assertThat(awaitCompleted(tenant, configured, closeId)
                .get("admission_stage").asText()).isEqualTo("java_durable");
        assertThat(harness.closeCount(configured)).isEqualTo(1);
    }

    @Test
    void waitsUntilNoHarnessHoldsTheJournalWriter() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        // Another server's Harness holds the Session's journal writer, and
        // this server's Harness answers as one that does not hold the
        // Session.
        String token = "other-harness-writer-token-000000000000";
        long generation = sessionStore.acquireWriter(tenant, sessionId, token,
                new AcquireWriterRequest("workspace", "other-harness",
                        60_000L)).writerGeneration();
        harness.answerClosesAs(OTHER_BOOT);
        try {
            String closeId = admit(post("/v1/agents/sessions/{id}/close",
                    sessionId), tenant, "close").get("id").asText();
            await().atMost(Duration.ofSeconds(5))
                    .until(() -> attempts(closeId) >= 2);
            assertThat(operation(tenant, sessionId, closeId).get("status")
                    .asText()).isEqualTo("running");
            assertThat(sessionStatus(tenant, sessionId))
                    .isEqualTo("closing");
            assertThat(runtime.drained()).doesNotContain(sessionId);

            sessionStore.sealWriter(tenant, sessionId, token,
                    new SealWriterRequest("workspace", "other-harness",
                            generation));
            assertThat(awaitCompleted(tenant, sessionId, closeId)
                    .get("admission_stage").asText())
                    .isEqualTo("java_durable");
            assertThat(harness.closeCount(sessionId))
                    .isEqualTo(attempts(closeId) + 1);
        } finally {
            harness.answerClosesAs(null);
        }
    }

    @Test
    void completesOnceAnAbandonedWriterLeaseExpires() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        // The Harness that held the Session stopped without sealing its
        // journal writer, and its replacement does not hold the Session.
        sessionStore.acquireWriter(tenant, sessionId,
                "stopped-harness-writer-token-0000000000",
                new AcquireWriterRequest("workspace", "stopped-harness",
                        2_000L));
        harness.answerClosesAs(OTHER_BOOT);
        try {
            String closeId = admit(post("/v1/agents/sessions/{id}/close",
                    sessionId), tenant, "close").get("id").asText();
            await().atMost(Duration.ofSeconds(5))
                    .until(() -> attempts(closeId) >= 1);
            assertThat(operation(tenant, sessionId, closeId).get("status")
                    .asText()).isEqualTo("running");
            assertThat(sessionStatus(tenant, sessionId))
                    .isEqualTo("closing");

            assertThat(awaitCompleted(tenant, sessionId, closeId)
                    .get("admission_stage").asText())
                    .isEqualTo("java_durable");
            assertThat(jdbc.queryForObject("SELECT state FROM"
                            + " qwen_managed_session_journal_head WHERE"
                            + " tenant_id = ? AND session_id = ?",
                    String.class, tenant, sessionId)).isEqualTo("ACTIVE");
        } finally {
            harness.answerClosesAs(null);
        }
    }

    @Test
    void aReplacedHarnessDoesNotConfirmTheClose() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        harness.answerClosesAs(OTHER_BOOT);
        try {
            String closeId = admit(post("/v1/agents/sessions/{id}/close",
                    sessionId), tenant, "close").get("id").asText();
            assertThat(awaitCompleted(tenant, sessionId, closeId)
                    .get("admission_stage").asText())
                    .isEqualTo("java_durable");
        } finally {
            harness.answerClosesAs(null);
        }
    }

    @Test
    void anotherWorkerFinishesAnOperationWhoseLeaseExpired()
            throws Exception {
        String tenant = tenant();
        String sessionId = emptySession(tenant);
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        // Admit and claim in one transaction, so no live worker sees the
        // operation before the lost worker holds it.
        OperationRecord lost = transaction.execute(ignored -> {
            String operationId = store.beginOperation(tenant, sessionId,
                    OperationKind.CLOSE, "", "close", "digest")
                    .operation().operationId();
            return store.claimOperation(tenant, sessionId, operationId,
                    "lost-worker", Duration.ofMillis(300)).orElseThrow();
        });
        assertThat(lost.claimGeneration()).isEqualTo(1);
        awaitCompleted(tenant, sessionId, lost.operationId());
        OperationRecord completed = store.findOperation(tenant, sessionId,
                lost.operationId()).orElseThrow();
        assertThat(completed.claimGeneration()).isEqualTo(2);
        assertThat(store.completeOperation(tenant, sessionId,
                lost.operationId(), "lost-worker", 1, true)).isFalse();
        store.retryOperation(tenant, sessionId, lost.operationId(),
                "lost-worker", 1, 0);
        assertThat(store.findOperation(tenant, sessionId,
                lost.operationId()).orElseThrow()).isEqualTo(completed);
    }

    @Test
    void replaysOnlyTheSameSessionKindActorAndKey() throws Exception {
        String tenant = tenant();
        String first = emptySession(tenant);
        String second = emptySession(tenant);
        JsonNode close = admit(post("/v1/agents/sessions/{id}/close", first),
                tenant, "shared-key");
        String closeId = close.get("id").asText();
        JsonNode webReplay = objectMapper.readTree(mvc.perform(post(
                        WEB_SHELL + "/sessions/close").header(TENANT, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"sessionId":"%s","idempotencyKey":"shared-key"}
                                """.formatted(first)))
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString());
        assertThat(webReplay.get("operationId").asText()).isEqualTo(closeId);
        assertThat(webReplay.get("replayed").asBoolean()).isTrue();

        JsonNode otherSession = admit(post("/v1/agents/sessions/{id}/close",
                second), tenant, "shared-key");
        assertThat(otherSession.get("id").asText()).isNotEqualTo(closeId);
        assertThat(otherSession.get("replayed").asBoolean()).isFalse();
        awaitCompleted(tenant, second, otherSession.get("id").asText());

        awaitCompleted(tenant, first, closeId);
        JsonNode otherKind = admit(delete("/v1/agents/sessions/{id}", first),
                tenant, "shared-key");
        assertThat(otherKind.get("id").asText()).isNotEqualTo(closeId);
        assertThat(otherKind.get("type").asText()).isEqualTo("delete");
        awaitCompleted(tenant, first, otherKind.get("id").asText());

        String third = emptySession(tenant);
        String actorClose = objectMapper.readTree(lifecycle(post(
                        "/v1/agents/sessions/{id}/close", third)
                        .principal(actor(tenant, "actor-a")), tenant,
                        "actor-key")
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString())
                .get("id").asText();
        awaitCompleted(tenant, third, actorClose);
        lifecycle(post("/v1/agents/sessions/{id}/close", third)
                .principal(actor(tenant, "actor-b")), tenant, "actor-key")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_state_conflict"));
        lifecycle(post("/v1/agents/sessions/{id}/close", third), tenant,
                "actor-key")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_state_conflict"));
        lifecycle(post("/v1/agents/sessions/{id}/close", third)
                .principal(actor(tenant, "actor-a")), tenant, "actor-key")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(actorClose))
                .andExpect(jsonPath("$.replayed").value(true));
    }

    @Test
    void allowsOneLifecycleChangeAtATime() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        harness.failNextRename();
        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant)
                        .header("Idempotency-Key", "rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"pending\"}"))
                .andExpect(status().isServiceUnavailable());
        // The answered failure retired its command row, so the same key
        // re-attempts the rename instead of finding the Session wedged.
        mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant)
                        .header("Idempotency-Key", "rename")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"pending\"}"))
                .andExpect(status().isOk());

        String closeId;
        harness.setAvailable(false);
        try {
            closeId = admit(post("/v1/agents/sessions/{id}/close", sessionId),
                    tenant, "close").get("id").asText();
            lifecycle(delete("/v1/agents/sessions/{id}", sessionId), tenant,
                    "delete")
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code")
                            .value("session_operation_active"));
            mvc.perform(patch("/v1/agents/sessions/{id}", sessionId)
                            .header(TENANT, tenant)
                            .header("Idempotency-Key", "rename-closing")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"title\":\"blocked\"}"))
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code")
                            .value("session_operation_active"));
        } finally {
            harness.setAvailable(true);
        }
        awaitCompleted(tenant, sessionId, closeId);
    }

    @Test
    void unavailableHarnessDoesNotBlockLaterRenameOrCompletedReplay()
            throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        harness.setAvailable(false);
        try {
            lifecycle(patch("/v1/agents/sessions/{id}", sessionId)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"title\":\"offline\"}"), tenant, "offline")
                    .andExpect(status().isServiceUnavailable())
                    .andExpect(jsonPath("$.error.code")
                            .value("hosted_harness_disabled"));
        } finally {
            harness.setAvailable(true);
        }
        lifecycle(patch("/v1/agents/sessions/{id}", sessionId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"online\"}"), tenant, "online")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.metadata.title").value("online"));
        harness.setAvailable(false);
        try {
            lifecycle(patch("/v1/agents/sessions/{id}", sessionId)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"title\":\"online\"}"), tenant, "online")
                    .andExpect(status().isOk())
                    .andExpect(header().string("X-Qwen-Idempotent-Replay", "true"));
        } finally {
            harness.setAvailable(true);
        }
    }

    @Test
    void failedRenameReceiptKeepsItsDigestAndConcurrentCompletion() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        String otherId = attachedSession(tenant);
        String digest = new RequestDigests().digest(
                java.util.Map.of("sessionId", sessionId, "title", "renamed"));
        assertThat(store.beginSessionMutation(tenant, "RENAME_SESSION", "key",
                digest, sessionId, SessionMutationKind.RENAME).replayed()).isFalse();
        assertThat(store.beginSessionMutation(tenant, "RENAME_SESSION", "key",
                digest, sessionId, SessionMutationKind.RENAME).replayed()).isTrue();
        store.abandonSessionMutation(tenant, "RENAME_SESSION", "key", sessionId);
        for (String target : List.of(sessionId, otherId)) {
            assertThatThrownBy(() -> store.beginSessionMutation(tenant,
                    "RENAME_SESSION", "key", "other-digest", target,
                    SessionMutationKind.RENAME))
                    .isInstanceOfSatisfying(ApiException.class, error ->
                            assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        }
        harness.rename(tenant, sessionId, "renamed");
        store.completeSessionMutation(tenant, "RENAME_SESSION", "key", sessionId,
                SessionMutationKind.RENAME, "renamed",
                store.requireSession(tenant, sessionId).harnessBootId());
        store.abandonSessionMutation(tenant, "RENAME_SESSION", "key", sessionId);
        lifecycle(patch("/v1/agents/sessions/{id}", sessionId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"renamed\"}"), tenant, "key")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.metadata.title").value("renamed"))
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "true"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND event_type = 'session.updated'",
                Integer.class, tenant, sessionId)).isEqualTo(1);
    }

    @Test
    void retryingFailedRenameAgainBlocksOtherLifecycleWork() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        store.beginSessionMutation(tenant, "RENAME_SESSION", "key", "digest",
                sessionId, SessionMutationKind.RENAME);
        store.abandonSessionMutation(tenant, "RENAME_SESSION", "key", sessionId);
        assertThat(store.beginSessionMutation(tenant, "RENAME_SESSION", "key",
                "digest", sessionId, SessionMutationKind.RENAME).replayed()).isTrue();
        assertThatThrownBy(() -> store.beginSessionMutation(tenant,
                "RENAME_SESSION", "other", "other-digest", sessionId,
                SessionMutationKind.RENAME))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("session_operation_active"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"lookup", "completion", "cleanup"})
    void renameStoreFailuresPreserveTheOriginalErrorAndAllowRetry(String phase)
            throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        AgentStateStore faulted = mock(AgentStateStore.class, delegatesTo(store));
        if ("lookup".equals(phase)) {
            AtomicInteger reads = new AtomicInteger();
            doAnswer(call -> {
                if (reads.incrementAndGet() == 2) {
                    throw new IllegalStateException("lookup unavailable");
                }
                return store.requireSession(tenant, sessionId);
            }).when(faulted).requireSession(tenant, sessionId);
        } else if ("completion".equals(phase)) {
            doThrow(new IllegalStateException("completion unavailable"))
                    .when(faulted).completeSessionMutation(anyString(), anyString(),
                            anyString(), anyString(), any(), anyString(), anyString());
        } else {
            doThrow(new IllegalStateException("cleanup unavailable"))
                    .when(faulted).abandonSessionMutation(tenant, "RENAME_SESSION",
                            "key", sessionId);
        }
        ManagedAgentService subject = new ManagedAgentService(faulted,
                new RequestDigests(), null, harness, null);
        harness.setAvailable(!"cleanup".equals(phase));
        try {
            assertThatThrownBy(() -> subject.renameSession(tenant, null, "key",
                    sessionId, "renamed"))
                    .isInstanceOfSatisfying(ApiException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                        assertThat(error.getCode()).isEqualTo("cleanup".equals(phase)
                                ? "hosted_harness_disabled" : "hosted_harness_unavailable");
                    });
        } finally {
            harness.setAvailable(true);
        }
        if (!"cleanup".equals(phase)) {
            assertThat(jdbc.queryForObject("SELECT command_status FROM"
                            + " managed_agent_command WHERE tenant_id = ?"
                            + " AND operation = 'RENAME_SESSION' AND idempotency_key = 'key'",
                    String.class, tenant)).isEqualTo("FAILED");
        }
        lifecycle(patch("/v1/agents/sessions/{id}", sessionId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"renamed\"}"), tenant, "key")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.metadata.title").value("renamed"))
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "true"));
    }

    /**
     * The command half of {@code requireNoOpenOperation}: one still-PENDING
     * mutation command and no open operation row is enough to refuse the next
     * lifecycle change. Built through the store because an answered rename
     * failure now retires its own row, so no route leaves one behind.
     */
    @Test
    void aPendingCommandRowAloneBlocksTheNextLifecycleChange() throws Exception {
        String tenant = tenant();
        String sessionId = attachedSession(tenant);
        store.beginSessionMutation(tenant, "RENAME_SESSION", "pending-command",
                "digest", sessionId, SessionMutationKind.RENAME);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " managed_agent_command WHERE tenant_id = ? AND session_id ="
                + " ? AND command_status = 'PENDING'", Integer.class, tenant,
                sessionId)).isEqualTo(1);
        // Without this the refusals below could be read as the operation
        // conjunct firing instead of the command one.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " managed_agent_operation WHERE tenant_id = ? AND session_id"
                + " = ? AND state IN ('PENDING', 'RUNNING')", Integer.class,
                tenant, sessionId)).isZero();
        lifecycle(post("/v1/agents/sessions/{id}/close", sessionId), tenant,
                "close")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_operation_active"));
        lifecycle(delete("/v1/agents/sessions/{id}", sessionId), tenant,
                "delete")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("session_operation_active"));
    }

    @Test
    void deleteLeavesTheSharedRuntimeAndOtherSessionsAlone()
            throws Exception {
        String tenant = tenant();
        String deleted = attachedSession(tenant);
        // The fixture Harness streams one Turn per Session, so the Session
        // that stays takes its first Turn after the delete.
        String kept = emptySession(tenant);
        String deleteId = admit(delete("/v1/agents/sessions/{id}", deleted),
                tenant, "delete").get("id").asText();
        assertThat(awaitCompleted(tenant, deleted, deleteId)
                .get("admission_stage").asText())
                .isEqualTo("harness_confirmed");
        assertThat(runtime.drained()).contains(deleted).doesNotContain(kept);
        mvc.perform(get("/v1/agents/sessions/{id}/events", deleted)
                        .header(TENANT, tenant)
                        .accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isNotFound());
        mvc.perform(post("/v1/agents/sessions/{id}/events", kept)
                        .header(TENANT, tenant)
                        .header("Idempotency-Key", "still-open")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"type":"agent.session.input.message",
                                 "input":[{"type":"input_text",
                                           "text":"hello"}]}
                                """))
                .andExpect(status().isAccepted());
        await().atMost(Duration.ofSeconds(5)).until(() ->
                store.findActiveTurn(tenant, kept).isEmpty()
                        && store.findLatestTurn(tenant, kept).orElseThrow()
                                .status().equals("COMPLETED"));
        assertThat(sessionStatus(tenant, kept)).isEqualTo("active");
    }

    @Test
    void activeWorkspaceSessionsRejectRetentionAndUnsupportedClose()
            throws Exception {
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
        mvc.perform(get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capabilities.session_lifecycle")
                        .value(false));
        lifecycle(post("/v1/agents/sessions/{id}/close", sessionId)
                        .principal(actor(tenant, "actor-a")), tenant, "bound-close")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("workspace_unavailable"));
        for (MockHttpServletRequestBuilder request : List.of(
                post("/v1/agents/sessions/{id}/archive", sessionId),
                delete("/v1/agents/sessions/{id}", sessionId))) {
            lifecycle(request.principal(actor(tenant, "actor-a")), tenant,
                    "bound-" + UUID.randomUUID())
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code")
                            .value("session_state_conflict"));
        }
        mvc.perform(post(WEB_SHELL + "/sessions/delete").header(TENANT, tenant)
                        .principal(actor(tenant, "actor-b"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"sessionId":"%s","idempotencyKey":"bound"}
                                """.formatted(sessionId)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("session_not_found"));
        mvc.perform(get("/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        "op_missing").header(TENANT, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code")
                        .value("operation_not_found"));
        mvc.perform(get("/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        "op_missing").header(TENANT, tenant)
                        .principal(actor(tenant, "actor-b")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("session_not_found"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_operation WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(sessionStatus(tenant, sessionId, "actor-a")).isEqualTo("active");
    }

    private String tenant() {
        return "tenant-lifecycle-" + UUID.randomUUID();
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

    // A Session whose completed Turn attached it to the Harness.
    private String attachedSession(String tenant) throws Exception {
        String sessionId = objectMapper.readTree(mvc.perform(post(
                        "/v1/agents/sessions").header(TENANT, tenant)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"agent_id":"qwen-code",
                                 "input":[{"type":"input_text","text":"hi"}]}
                                """))
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString())
                .get("id").asText();
        await().atMost(Duration.ofSeconds(5)).until(() ->
                store.findActiveTurn(tenant, sessionId).isEmpty()
                        && store.requireSession(tenant, sessionId)
                                .harnessBootId() != null);
        return sessionId;
    }

    private ResultActions lifecycle(MockHttpServletRequestBuilder request,
            String tenant, String idempotencyKey) throws Exception {
        return mvc.perform(request.header(TENANT, tenant)
                .header("Idempotency-Key", idempotencyKey));
    }

    private JsonNode admit(MockHttpServletRequestBuilder request,
            String tenant, String idempotencyKey) throws Exception {
        return objectMapper.readTree(lifecycle(request, tenant,
                idempotencyKey).andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString());
    }

    private JsonNode operation(String tenant, String sessionId,
            String operationId) throws Exception {
        return objectMapper.readTree(mvc.perform(get(
                        "/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        operationId).header(TENANT, tenant))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString());
    }

    private JsonNode awaitCompleted(String tenant, String sessionId,
            String operationId) {
        JsonNode[] completed = new JsonNode[1];
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            completed[0] = operation(tenant, sessionId, operationId);
            assertThat(completed[0].get("status").asText())
                    .isEqualTo("completed");
        });
        assertThat(completed[0].get("delivery_state").asText())
                .isEqualTo("confirmed");
        assertThat(completed[0].get("receipt_id").asText())
                .startsWith("rcpt_");
        return completed[0];
    }

    private int attempts(String operationId) {
        return jdbc.queryForObject("SELECT attempt_count FROM"
                        + " managed_agent_operation WHERE operation_id = ?",
                Integer.class, operationId);
    }

    private String sessionStatus(String tenant, String sessionId)
            throws Exception {
        return objectMapper.readTree(mvc.perform(get(
                        "/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString())
                .get("status").asText();
    }

    private String sessionStatus(String tenant, String sessionId,
            String actorId)
            throws Exception {
        return objectMapper.readTree(mvc.perform(get(
                        "/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant)
                        .principal(actor(tenant, actorId)))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString())
                .get("status").asText();
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

    @TestConfiguration
    static class DrainConfiguration {
        @Bean
        @Primary
        RecordingRuntimeWarmer recordingRuntimeWarmer() {
            return new RecordingRuntimeWarmer();
        }
    }

    static final class RecordingRuntimeWarmer implements RuntimeWarmer {
        private final List<String> drained = new CopyOnWriteArrayList<>();
        private final AtomicInteger drainFailures = new AtomicInteger();

        @Override
        public boolean isEnabled() {
            return false;
        }

        @Override
        public CompletionStage<Void> warm(String sessionId) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Void> drain(String sessionId) {
            if (drainFailures.getAndUpdate(value -> Math.max(0,
                    value - 1)) > 0) {
                return CompletableFuture.failedFuture(
                        new IllegalStateException("fixture drain failure"));
            }
            drained.add(sessionId);
            return CompletableFuture.completedFuture(null);
        }

        List<String> drained() {
            return List.copyOf(drained);
        }

        void failDrains(int count) {
            drainFailures.set(count);
        }
    }
}
