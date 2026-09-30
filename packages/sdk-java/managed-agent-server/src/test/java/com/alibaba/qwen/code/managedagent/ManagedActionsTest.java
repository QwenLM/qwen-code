package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.RETURNS_DEFAULTS;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import org.junit.jupiter.api.Test;
import org.mockito.stubbing.Answer;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

@SpringBootTest(
        properties = {
            "spring.datasource.url=${d6b.mysql.url:jdbc:h2:mem:managed-actions;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE}",
            "spring.datasource.driver-class-name=${d6b.mysql.driver:org.h2.Driver}",
            "spring.datasource.username=${d6b.mysql.user:sa}",
            "spring.datasource.password=${d6b.mysql.password:}",
            "qwen.managed-agent.harness.enabled=false",
            "qwen.managed-agent.dispatch.retry-initial-delay=20ms",
            "qwen.managed-agent.dispatch.scan-delay=50ms"
        })
@AutoConfigureMockMvc
class ManagedActionsTest {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper json;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ManagedSessionStore journals;
    @Autowired private ManagedActionStore actions;
    @Autowired private AgentStateStore sessions;

    @TestBean(methodName = "createHarness")
    private HarnessConnector harness;

    private static final Map<String, Answer<Void>> responses = new ConcurrentHashMap<>();

    static HarnessConnector createHarness() {
        return mock(
                HarnessConnector.class,
                call -> {
                    if ("resolveAction".equals(call.getMethod().getName())) {
                        Answer<Void> answer = responses.get(call.getArgument(2));
                        return answer == null ? null : answer.answer(call);
                    }
                    return RETURNS_DEFAULTS.answer(call);
                });
    }

    @Test
    void rejectsMalformedActionJournalWithoutProjectingIt() throws Exception {
        for (String field :
                java.util.List.of(
                        "version", "revision", "unsafeRevision", "refVersion", "refLength")) {
            String tenant = tenant();
            String session = session(tenant);
            ActionJournal action = new ActionJournal(journals, tenant, session, 100, 1000);
            ObjectNode request = json.valueToTree(action.request("requested", null));
            String records =
                    new String(
                            Base64.getDecoder().decode(request.path("recordBytesBase64").asText()),
                            java.nio.charset.StandardCharsets.UTF_8);
            String[] lines = records.split("\n");
            ObjectNode record = (ObjectNode) json.readTree(lines[0]);
            ObjectNode event = (ObjectNode) record.path("managedSession");
            ObjectNode payload = (ObjectNode) event.path("payload");
            switch (field) {
                case "version" -> event.put("v", 1.9);
                case "revision" -> payload.put("inputRevision", "1");
                case "unsafeRevision" -> payload.put("inputRevision", 9007199254740992L);
                case "refVersion" ->
                        ((ObjectNode) payload.path("optionsRef")).put("schemaVersion", 2);
                case "refLength" -> ((ObjectNode) payload.path("optionsRef")).put("byteLength", 1);
                default -> throw new AssertionError(field);
            }
            String changed = record + "\n" + lines[1] + "\n";
            request.put(
                    "recordBytesBase64",
                    Base64.getEncoder()
                            .encodeToString(
                                    changed.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            request.put("recordDigest", ExtensionRecordJournal.sha256(changed));
            CommitTransactionRequest invalid =
                    json.treeToValue(request, CommitTransactionRequest.class);
            assertThatThrownBy(
                            () ->
                                    journals.commit(
                                            tenant,
                                            session,
                                            "extension-writer-token-0123456789",
                                            invalid))
                    .isInstanceOfSatisfying(
                            ApiException.class,
                            error ->
                                    assertThat(error.getCode())
                                            .isEqualTo("managed_session_action_rejected"));
            assertThat(actions.find(tenant, session, action.id)).isEmpty();
        }
    }

    @Test
    void rejectsDecisionThatDoesNotMatchOriginalAction() throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal journal = action(tenant, session, 100, 1000);
        for (ObjectNode response :
                java.util.List.of(
                        json.createObjectNode()
                                .put("optionId", "other")
                                .put("inputRevision", 1)
                                .put("policyRevision", "hosted-tool-approval/1"),
                        json.createObjectNode()
                                .put("optionId", "allow")
                                .put("inputRevision", 2)
                                .put("policyRevision", "hosted-tool-approval/1"),
                        json.createObjectNode()
                                .put("optionId", "allow")
                                .put("inputRevision", 1)
                                .put("policyRevision", "hosted-tool-approval/2"))) {
            assertThatThrownBy(() -> journal.change("decided", response))
                    .isInstanceOfSatisfying(
                            ApiException.class,
                            error ->
                                    assertThat(error.getCode())
                                            .isEqualTo("managed_session_action_rejected"));
            assertThat(actions.find(tenant, session, journal.id).orElseThrow().state())
                    .isEqualTo("requested");
        }
    }

    @Test
    void projectsBothSurfacesPagesRequestedAndKeepsTerminalDetail() throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal first = action(tenant, session, 100, 1000);
        first.change("expired", null);
        ActionJournal second = new ActionJournal(first, 200, 9007199254740991L);
        second.change("requested", null);
        JsonNode publicView = read(auth(get(path(session, second.id)), tenant, "owner"));
        assertThat(OpenApiContract.load().validate("/components/schemas/PublicAction", publicView))
                .isEmpty();
        assertThat(publicView.path("function_call_id").asText()).isEqualTo("call-actions");
        assertThat(publicView.path("tool_name").asText()).isEqualTo("write_file");
        JsonNode web =
                read(
                        auth(post("/api/agent/web-shell/v1/actions/get"), tenant, "owner")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(
                                        json.writeValueAsString(
                                                Map.of(
                                                        "sessionId",
                                                        session,
                                                        "actionId",
                                                        second.id))));
        assertThat(OpenApiContract.load().validate("/components/schemas/WebShellAction", web))
                .isEmpty();
        assertThat(web.path("inputRevision").asLong()).isEqualTo(1);
        mvc.perform(auth(get("/v1/agents/sessions/{session}/actions", session), tenant, "owner"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(1));
        ActionJournal third = new ActionJournal(second, 200, 9007199254740991L);
        third.change("requested", null);
        String greatest = second.id.compareTo(third.id) > 0 ? second.id : third.id;
        String smallest = greatest.equals(second.id) ? third.id : second.id;
        JsonNode firstPage =
                read(
                        auth(get("/v1/agents/sessions/{session}/actions", session), tenant, "owner")
                                .param("limit", "1"));
        assertThat(firstPage.path("data").get(0).path("id").asText()).isEqualTo(greatest);
        assertThat(firstPage.path("has_more").asBoolean()).isTrue();
        JsonNode nextPage =
                read(
                        auth(post("/api/agent/web-shell/v1/actions/query"), tenant, "owner")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(
                                        json.writeValueAsString(
                                                Map.of(
                                                        "sessionId",
                                                        session,
                                                        "cursor",
                                                        firstPage.path("next_cursor").asText(),
                                                        "limit",
                                                        1))));
        assertThat(nextPage.path("data").get(0).path("actionId").asText()).isEqualTo(smallest);
        assertThat(nextPage.path("hasMore").asBoolean()).isFalse();
        mvc.perform(auth(get(path(session, first.id)), tenant, "owner"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("expired"));
        mvc.perform(auth(get(path(session, first.id)), tenant(), "owner"))
                .andExpect(status().isNotFound());
        mvc.perform(
                        auth(get("/v1/agents/sessions/{session}/actions", session), tenant, "owner")
                                .param("cursor", "garbage"))
                .andExpect(status().isBadRequest());
        mvc.perform(
                        auth(get("/v1/agents/sessions/{session}/actions", session), tenant, "owner")
                                .param("limit", "101"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void ownerResponseReplaysAcrossSurfacesAndUsesCommittedDecisionAfterLostAnswer()
            throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal journal =
                action(tenant, session, System.currentTimeMillis(), 9007199254740991L);
        AtomicInteger delivered = new AtomicInteger();
        responses.put(
                journal.id,
                call -> {
                    delivered.incrementAndGet();
                    journal.change("decided", call.getArgument(3));
                    throw new IllegalStateException("answer lost after commit");
                });
        mvc.perform(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "other")
                                .header("Idempotency-Key", "answer")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("allow")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("action_forbidden"));
        JsonNode admitted =
                readAccepted(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "answer")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("allow")));
        assertThat(
                        OpenApiContract.load()
                                .validate("/components/schemas/PublicCommandOperation", admitted))
                .isEmpty();
        String op = admitted.path("id").asText();
        await().atMost(Duration.ofSeconds(5))
                .untilAsserted(
                        () ->
                                assertThat(
                                                sessions.findOperation(tenant, session, op)
                                                        .orElseThrow()
                                                        .state())
                                        .isEqualTo("COMPLETED"));
        JsonNode result =
                read(
                        auth(
                                get("/v1/agents/sessions/{session}/operations/{op}", session, op),
                                tenant,
                                "owner"));
        assertThat(
                        OpenApiContract.load()
                                .validate("/components/schemas/PublicCommandOperation", result))
                .isEmpty();
        assertThat(result.at("/action_resolution/outcome").asText()).isEqualTo("decided");
        assertThat(result.at("/action_resolution/decision_receipt_id").asText())
                .startsWith("decision_");
        JsonNode replay =
                readAccepted(
                        auth(post("/api/agent/web-shell/v1/actions/respond"), tenant, "owner")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(webResponse(session, journal.id, "answer", "allow")));
        assertThat(
                        OpenApiContract.load()
                                .validate("/components/schemas/WebShellCommandOperation", replay))
                .isEmpty();
        assertThat(replay.path("operationId").asText()).isEqualTo(op);
        assertThat(replay.path("replayed").asBoolean()).isTrue();
        assertThat(delivered.get()).isEqualTo(1);
        mvc.perform(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "answer")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("deny")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        mvc.perform(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "new-answer")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("deny")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("action_already_resolved"));
        assertThat(sessions.requireSession(tenant, session).status()).isEqualTo("ACTIVE");
    }

    @Test
    void webShellRequestIdValidationAndRetryWaitForAuthority() throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal journal =
                action(tenant, session, System.currentTimeMillis(), 9007199254740991L);
        AtomicInteger attempts = new AtomicInteger();
        responses.put(
                journal.id,
                call -> {
                    if (attempts.incrementAndGet() == 1)
                        throw new IllegalStateException("temporarily unavailable");
                    journal.change("decided", call.getArgument(3));
                    return null;
                });
        var result =
                mvc.perform(
                                auth(
                                                post("/api/agent/web-shell/v1/actions/respond"),
                                                tenant,
                                                "owner")
                                        .contentType(MediaType.APPLICATION_JSON)
                                        .content(
                                                webResponse(
                                                        session, journal.id, "web-answer", "deny")))
                        .andExpect(status().isAccepted())
                        .andExpect(
                                org.springframework.test.web.servlet.result.MockMvcResultMatchers
                                        .header()
                                        .string("X-Request-Id", "trace-action"))
                        .andReturn();
        String op =
                json.readTree(result.getResponse().getContentAsString())
                        .path("operationId")
                        .asText();
        await().atMost(Duration.ofSeconds(5))
                .untilAsserted(
                        () ->
                                assertThat(
                                                sessions.findOperation(tenant, session, op)
                                                        .orElseThrow()
                                                        .state())
                                        .isEqualTo("COMPLETED"));
        assertThat(attempts.get()).isEqualTo(2);
        assertThat(actions.find(tenant, session, journal.id).orElseThrow().state())
                .isEqualTo("decided");
        String another = session(tenant);
        ActionJournal expired = action(tenant, another, 1, 2);
        mvc.perform(
                        auth(post(path(another, expired.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "late")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("allow")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("action_expired"));
        mvc.perform(
                        auth(post(path(another, expired.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "wrong")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("other")))
                .andExpect(status().isBadRequest());
    }

    @Test
    void recoveryBlockedResponsesStayRunningUntilJournalProvesTheOutcome() throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        long expiry = System.currentTimeMillis() + 1500;
        ActionJournal journal = action(tenant, session, System.currentTimeMillis(), expiry);
        AtomicInteger attempts = new AtomicInteger();
        responses.put(
                journal.id,
                call -> {
                    attempts.incrementAndGet();
                    throw new IllegalStateException("recovery blocked");
                });
        JsonNode admitted =
                readAccepted(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "blocked")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("allow")));
        String op = admitted.path("id").asText();
        await().atMost(Duration.ofSeconds(5))
                .until(() -> System.currentTimeMillis() >= expiry && attempts.get() > 1);
        assertThat(sessions.findOperation(tenant, session, op).orElseThrow().state())
                .isEqualTo("RUNNING");
        assertThat(actions.find(tenant, session, journal.id).orElseThrow().state())
                .isEqualTo("requested");
        journal.change("expired", null);
        await().atMost(Duration.ofSeconds(5))
                .untilAsserted(
                        () ->
                                assertThat(
                                                sessions.findOperation(tenant, session, op)
                                                        .orElseThrow()
                                                        .state())
                                        .isEqualTo("FAILED"));
        JsonNode result =
                read(
                        auth(
                                get("/v1/agents/sessions/{session}/operations/{op}", session, op),
                                tenant,
                                "owner"));
        assertThat(result.path("failure_code").asText()).isEqualTo("action_expired");
        assertThat(result.has("action_resolution")).isFalse();
        assertThat(
                        OpenApiContract.load()
                                .validate("/components/schemas/PublicCommandOperation", result))
                .isEmpty();
    }

    @Test
    void cancelledActionsFailTheResponseWithActionCancelled() throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal journal =
                action(tenant, session, System.currentTimeMillis(), 9007199254740991L);
        responses.put(
                journal.id,
                call -> {
                    throw new IllegalStateException("turn aborted");
                });
        JsonNode admitted =
                readAccepted(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "cancelled-answer")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("allow")));
        String op = admitted.path("id").asText();
        journal.change("cancelled", null);
        await().atMost(Duration.ofSeconds(5))
                .untilAsserted(
                        () ->
                                assertThat(
                                                sessions.findOperation(tenant, session, op)
                                                        .orElseThrow()
                                                        .state())
                                        .isEqualTo("FAILED"));
        JsonNode result =
                read(
                        auth(
                                get("/v1/agents/sessions/{session}/operations/{op}", session, op),
                                tenant,
                                "owner"));
        assertThat(result.path("failure_code").asText()).isEqualTo("action_cancelled");
        assertThat(result.has("action_resolution")).isFalse();
    }

    @Test
    void competingResponsesReconcileWithTheSingleRecordedDecision() throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal journal =
                action(tenant, session, System.currentTimeMillis(), 9007199254740991L);
        responses.put(
                journal.id,
                call -> {
                    throw new IllegalStateException("temporarily unavailable");
                });
        JsonNode allow =
                readAccepted(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "allow-answer")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("allow")));
        JsonNode deny =
                readAccepted(
                        auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                .header("Idempotency-Key", "deny-answer")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(response("deny")));
        journal.change(
                "decided",
                json.createObjectNode()
                        .put("optionId", "deny")
                        .put("inputRevision", 1)
                        .put("policyRevision", "hosted-tool-approval/1"));
        await().atMost(Duration.ofSeconds(5))
                .untilAsserted(
                        () -> {
                            assertThat(
                                            sessions.findOperation(
                                                            tenant,
                                                            session,
                                                            allow.path("id").asText())
                                                    .orElseThrow()
                                                    .state())
                                    .isEqualTo("FAILED");
                            assertThat(
                                            sessions.findOperation(
                                                            tenant,
                                                            session,
                                                            deny.path("id").asText())
                                                    .orElseThrow()
                                                    .state())
                                    .isEqualTo("COMPLETED");
                        });
        assertThat(actions.response(tenant, session, allow.path("id").asText()).errorCode())
                .isEqualTo("action_already_resolved");
    }

    @Test
    void closedRequestsAndOriginalRevisionAreValidated() throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal journal =
                action(tenant, session, System.currentTimeMillis(), 9007199254740991L);
        for (String invalid :
                java.util.List.of(
                        response("allow").replace("\"input_revision\":1", "\"input_revision\":1.1"),
                        response("allow").replace("\"input_revision\":1", "\"input_revision\":2"),
                        response("allow")
                                .replace("hosted-tool-approval/1", "hosted-tool-approval/2"),
                        response("allow").replace("}", ",\"extra\":true}"))) {
            mvc.perform(
                            auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                                    .header("Idempotency-Key", "invalid")
                                    .contentType(MediaType.APPLICATION_JSON)
                                    .content(invalid))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(auth(get(path(session, journal.id + " ")), tenant, "owner"))
                .andExpect(status().isNotFound());
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM managed_agent_operation WHERE tenant_id = ?"
                                        + " AND session_id = ?",
                                Integer.class,
                                tenant,
                                session))
                .isZero();
    }

    private ActionJournal action(String tenant, String session, long created, long expiry)
            throws Exception {
        ActionJournal journal = new ActionJournal(journals, tenant, session, created, expiry);
        journal.change("requested", null);
        return journal;
    }

    private String session(String tenant) throws Exception {
        String session =
                readAccepted(
                                post("/v1/agents/sessions")
                                        .header(TenantContextFilter.HEADER, tenant)
                                        .header("Idempotency-Key", UUID.randomUUID().toString())
                                        .contentType(MediaType.APPLICATION_JSON)
                                        .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                        .path("id")
                        .asText();
        jdbc.update(
                "INSERT INTO managed_workspace_create_command (tenant_id, actor_id,"
                    + " idempotency_key, request_digest, session_id, created_at) VALUES (?, ?, ?,"
                    + " ?, ?, ?)",
                tenant,
                "owner".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                UUID.randomUUID().toString(),
                "sha256:test",
                session,
                System.currentTimeMillis());
        return session;
    }

    private JsonNode read(MockHttpServletRequestBuilder request) throws Exception {
        return json.readTree(
                mvc.perform(request)
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString());
    }

    private JsonNode readAccepted(MockHttpServletRequestBuilder request) throws Exception {
        return json.readTree(
                mvc.perform(request)
                        .andExpect(status().isAccepted())
                        .andReturn()
                        .getResponse()
                        .getContentAsString());
    }

    private MockHttpServletRequestBuilder auth(
            MockHttpServletRequestBuilder request, String tenant, String actor) {
        return request.header(TenantContextFilter.HEADER, tenant)
                .principal(
                        new AuthenticatedTenantActor() {
                            public String tenantId() {
                                return tenant;
                            }

                            public String actorId() {
                                return actor;
                            }

                            public String getName() {
                                return actor;
                            }
                        });
    }

    private static String path(String session, String action) {
        return "/v1/agents/sessions/" + session + "/actions/" + action;
    }

    private static String tenant() {
        return "actions-" + UUID.randomUUID();
    }

    private static String response(String option) {
        return "{\"kind\":\"permission\",\"input_revision\":1,\"policy_revision\":\"hosted-tool-approval/1\",\"option_id\":\""
                + option
                + "\"}";
    }

    private String webResponse(String session, String id, String key, String option)
            throws Exception {
        return json.writeValueAsString(
                Map.of(
                        "sessionId",
                        session,
                        "actionId",
                        id,
                        "idempotencyKey",
                        key,
                        "requestId",
                        "trace-action",
                        "response",
                        Map.of(
                                "kind",
                                "permission",
                                "inputRevision",
                                1,
                                "policyRevision",
                                "hosted-tool-approval/1",
                                "optionId",
                                option)));
    }
}
