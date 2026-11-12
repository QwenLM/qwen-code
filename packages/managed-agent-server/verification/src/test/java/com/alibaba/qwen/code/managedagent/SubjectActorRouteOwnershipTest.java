package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.session.SessionRenameCoordinator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * R3-5: creation records the verified business-actor subject in the ownership
 * row, so the create response and every later route must authorize with that
 * same principal. A raw-actor route refuses any actor-present row with 404,
 * which would leave a subject-bearing caller unable to read, list, submit to,
 * rename, close or delete the Session it just created.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:subject-actor-routes;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
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
class SubjectActorRouteOwnershipTest {
    private static final String PUBLIC = "/v1/agents/sessions";
    private static final String WEB_SHELL = "/api/agent/web-shell/v1";
    private static final String TENANT = TenantContextFilter.HEADER;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private FixtureHarness harness;

    @Autowired
    private JdbcManagedSessionStore journals;

    @AfterEach
    void restoreHarness() {
        harness.setAvailable(true);
        harness.releaseHeldTurns();
    }

    @Test
    void aSubjectBearingPublicCallerReadsListsMutatesAndDeletesItsSession()
            throws Exception {
        String tenant = tenant();
        AuthenticatedTenantActor alice = actor(tenant, "alice", "biz-alice");
        String session = createPublic(tenant, alice);

        // The creation response itself must be readable: the ownership row
        // records the subject, so the read must authorize with it.
        mvc.perform(get(PUBLIC + "/{id}", session)
                        .header(TENANT, tenant).principal(alice))
                .andExpect(status().isOk());

        JsonNode listed = body(mvc.perform(get(PUBLIC)
                .header(TENANT, tenant).principal(alice))
                .andExpect(status().isOk()));
        assertThat(listed.path("data").findValuesAsText("id"))
                .as("a subject-bearing caller lists the Session it created")
                .contains(session);

        mvc.perform(post(PUBLIC + "/{id}/events", session)
                        .header(TENANT, tenant).principal(alice)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"agent.session.input.message\","
                                + "\"input\":[{\"type\":\"text\","
                                + "\"text\":\"hello\"}]}"))
                .andExpect(status().isAccepted());

        mvc.perform(patch(PUBLIC + "/{id}", session)
                        .header(TENANT, tenant).principal(alice)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"renamed\"}"))
                .andExpect(status().isOk());

        // A different actor still gets 404: the fix routes the creator's own
        // identity, it does not loosen the ownership twin.
        AuthenticatedTenantActor bob = actor(tenant, "bob", "biz-bob");
        mvc.perform(get(PUBLIC + "/{id}", session)
                        .header(TENANT, tenant).principal(bob))
                .andExpect(status().isNotFound());
        mvc.perform(patch(PUBLIC + "/{id}", session)
                        .header(TENANT, tenant).principal(bob)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"stolen\"}"))
                .andExpect(status().isNotFound());

        settle(tenant, session);

        mvc.perform(post(PUBLIC + "/{id}/close", session)
                        .header(TENANT, tenant).principal(alice)
                        .header("Idempotency-Key", UUID.randomUUID().toString()))
                .andExpect(status().isAccepted());

        String doomed = createPublic(tenant, alice);
        mvc.perform(delete(PUBLIC + "/{id}", doomed)
                        .header(TENANT, tenant).principal(alice)
                        .header("Idempotency-Key", UUID.randomUUID().toString()))
                .andExpect(status().isAccepted());
    }

    @Test
    void aSubjectBearingWebShellCallerReadsSubmitsRenamesAndClosesItsSession()
            throws Exception {
        String tenant = tenant();
        AuthenticatedTenantActor alice = actor(tenant, "alice", "biz-alice");
        String session = mapper.readTree(mvc.perform(
                        post(WEB_SHELL + "/sessions/create")
                                .header(TENANT, tenant).principal(alice)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(mapper.writeValueAsString(Map.of(
                                        "idempotencyKey",
                                        UUID.randomUUID().toString(),
                                        "agentId", "qwen-code", "input",
                                        List.of()))))
                .andExpect(status().isAccepted()).andReturn().getResponse()
                .getContentAsString()).path("sessionId").asText();

        mvc.perform(post(WEB_SHELL + "/sessions/get")
                        .header(TENANT, tenant).principal(alice)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(
                                Map.of("sessionId", session))))
                .andExpect(status().isOk());

        JsonNode listed = body(mvc.perform(post(WEB_SHELL + "/sessions/query")
                .header(TENANT, tenant).principal(alice)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"))
                .andExpect(status().isOk()));
        assertThat(listed.path("data").findValuesAsText("sessionId"))
                .as("a subject-bearing caller lists the WebShell Session"
                        + " it created")
                .contains(session);

        mvc.perform(post(WEB_SHELL + "/turns/submit")
                        .header(TENANT, tenant).principal(alice)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "idempotencyKey",
                                UUID.randomUUID().toString(),
                                "sessionId", session,
                                "input", List.of(Map.of("type", "text",
                                        "text", "hello"))))))
                .andExpect(status().isAccepted());

        mvc.perform(post(WEB_SHELL + "/sessions/rename")
                        .header(TENANT, tenant).principal(alice)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "idempotencyKey",
                                UUID.randomUUID().toString(),
                                "sessionId", session,
                                "title", "renamed"))))
                .andExpect(status().isOk());

        mvc.perform(post(WEB_SHELL + "/sessions/get")
                        .header(TENANT, tenant)
                        .principal(actor(tenant, "bob", "biz-bob"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(
                                Map.of("sessionId", session))))
                .andExpect(status().isNotFound());

        settle(tenant, session);

        mvc.perform(post(WEB_SHELL + "/sessions/close")
                        .header(TENANT, tenant).principal(alice)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "sessionId", session,
                                "idempotencyKey",
                                UUID.randomUUID().toString()))))
                .andExpect(status().isAccepted());
    }

    @Test
    void aSubjectBearingCallerReachesEverySessionScopedSurface()
            throws Exception {
        String tenant = tenant();
        AuthenticatedTenantActor alice = actor(tenant, "alice", "biz-alice");
        AuthenticatedTenantActor bob = actor(tenant, "bob", "biz-bob");
        String session = createPublic(tenant, alice);
        String skills = mapper.writeValueAsString(
                Map.of("sessionId", session));

        // The user-message queue feature is off in this fixture: reaching its
        // 409 unsupported_feature is the proof that the ownership gate passed,
        // where R3-5 used to answer 404 before the route ran.
        List<Surface> surfaces = List.of(
                new Surface("user-messages query",
                        () -> get("/v1/agents/sessions/{id}/user-messages",
                                session), 409),
                new Surface("user-messages command",
                        () -> post("/v1/agents/sessions/{id}/user-messages",
                                session)
                                .header("Idempotency-Key",
                                        UUID.randomUUID().toString())
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"action\":\"submit\","
                                        + "\"input\":[{\"type\":\"text\","
                                        + "\"text\":\"hello\"}]}"), 409),
                new Surface("hook-catalog",
                        () -> get("/v1/agents/sessions/{id}/hook-catalog",
                                session), 200),
                new Surface("mcp-catalog",
                        () -> get("/v1/agents/sessions/{id}/mcp-catalog",
                                session), 200),
                new Surface("mcp-management",
                        () -> get("/v1/agents/sessions/{id}/mcp-management",
                                session), 200),
                new Surface("extensions",
                        () -> get("/v1/agents/sessions/{id}/extensions",
                                session), 200),
                new Surface("context-usage",
                        () -> get("/v1/agents/sessions/{id}/context-usage",
                                session), 200),
                new Surface("session-stats",
                        () -> get("/v1/agents/sessions/{id}/stats", session),
                        200),
                new Surface("session-skills",
                        () -> post("/api/agent/web-shell/v1"
                                + "/session-skills/query")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(skills), 200));

        for (Surface surface : surfaces) {
            mvc.perform(surface.request().get().header(TENANT, tenant)
                            .principal(alice))
                    .andExpect(status().is(surface.expected()));
            mvc.perform(surface.request().get().header(TENANT, tenant)
                            .principal(bob))
                    .andExpect(status().isNotFound());
        }
    }

    @Test
    void aSubjectBearingCallerReachesItsOwnActions() throws Exception {
        String tenant = tenant();
        AuthenticatedTenantActor alice = actor(tenant, "alice", "biz-alice");
        AuthenticatedTenantActor bob = actor(tenant, "bob", "biz-bob");
        String session = createPublic(tenant, alice);
        var journal = new ActionJournal(journals, tenant, session,
                System.currentTimeMillis(), 9_007_199_254_740_991L);
        journal.change("requested", null);
        String actions = PUBLIC + "/" + session + "/actions";
        String body = "{\"kind\":\"permission\",\"input_revision\":1,"
                + "\"policy_revision\":\"hosted-tool-approval/1\","
                + "\"option_id\":\"allow\"}";

        mvc.perform(get(actions).header(TENANT, tenant).principal(alice))
                .andExpect(status().isOk());
        mvc.perform(get(actions + "/" + journal.id).header(TENANT, tenant)
                .principal(alice)).andExpect(status().isOk());
        mvc.perform(post(WEB_SHELL + "/actions/query").header(TENANT, tenant)
                .principal(alice).contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("sessionId", session))))
                .andExpect(status().isOk());
        mvc.perform(post(WEB_SHELL + "/actions/get").header(TENANT, tenant)
                .principal(alice).contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("sessionId", session,
                        "actionId", journal.id))))
                .andExpect(status().isOk());
        mvc.perform(post(actions + "/" + journal.id + "/responses")
                .header(TENANT, tenant).principal(alice)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isAccepted());
        mvc.perform(post(WEB_SHELL + "/actions/respond")
                .header(TENANT, tenant).principal(alice)
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of(
                        "sessionId", session, "actionId", journal.id,
                        "idempotencyKey", UUID.randomUUID().toString(),
                        "response", Map.of("kind", "permission",
                                "inputRevision", 1,
                                "policyRevision", "hosted-tool-approval/1",
                                "optionId", "allow")))))
                .andExpect(status().isAccepted());

        // A sibling user keeps the ownership refusal on every route.
        mvc.perform(get(actions).header(TENANT, tenant).principal(bob))
                .andExpect(status().isNotFound());
        mvc.perform(get(actions + "/" + journal.id).header(TENANT, tenant)
                .principal(bob)).andExpect(status().isNotFound());
        mvc.perform(post(WEB_SHELL + "/actions/query").header(TENANT, tenant)
                .principal(bob).contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("sessionId", session))))
                .andExpect(status().isNotFound());
        mvc.perform(post(WEB_SHELL + "/actions/get").header(TENANT, tenant)
                .principal(bob).contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("sessionId", session,
                        "actionId", journal.id))))
                .andExpect(status().isNotFound());
        mvc.perform(post(actions + "/" + journal.id + "/responses")
                .header(TENANT, tenant).principal(bob)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isNotFound());
        mvc.perform(post(WEB_SHELL + "/actions/respond")
                .header(TENANT, tenant).principal(bob)
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of(
                        "sessionId", session, "actionId", journal.id,
                        "idempotencyKey", UUID.randomUUID().toString(),
                        "response", Map.of("kind", "permission",
                                "inputRevision", 1,
                                "policyRevision", "hosted-tool-approval/1",
                                "optionId", "allow")))))
                .andExpect(status().isNotFound());
    }

    private record Surface(String name,
            Supplier<MockHttpServletRequestBuilder> request, int expected) {
    }

    private String createPublic(String tenant, AuthenticatedTenantActor actor)
            throws Exception {
        return body(mvc.perform(post(PUBLIC)
                .header(TENANT, tenant).principal(actor)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .andExpect(status().isAccepted())).path("id").asText();
    }

    private void settle(String tenant, String session) {
        await().atMost(Duration.ofSeconds(10)).until(() ->
                store.findActiveTurns(tenant, List.of(session)).isEmpty());
    }

    private JsonNode body(ResultActions result) throws Exception {
        return mapper.readTree(result.andReturn().getResponse()
                .getContentAsString());
    }

    private static String tenant() {
        return "subject-routes-" + UUID.randomUUID();
    }

    private static AuthenticatedTenantActor actor(String tenant,
            String actorId, String actorSubjectId) {
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

            @Override
            public String actorSubjectId() {
                return actorSubjectId;
            }
        };
    }
}
