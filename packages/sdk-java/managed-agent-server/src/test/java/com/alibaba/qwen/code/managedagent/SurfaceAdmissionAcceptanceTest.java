package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.SurfaceRegistry;
import com.alibaba.qwen.code.managedagent.api.SurfaceRegistry.Capability;
import com.alibaba.qwen.code.managedagent.api.SurfaceRegistry.RuleClass;
import com.alibaba.qwen.code.managedagent.api.SurfaceRegistry.Surface;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.ToolPublicationController;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.store.WriterCredentialPolicy;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * The D6 acceptance probes: the test walks {@link SurfaceRegistry} and fires
 * today's standard refusal probes per rule class on every route — wrong
 * tenant (403 {@code actor_scope_mismatch}), missing actor, below-read (404
 * without a Workspace grant), read-without-family-power (409
 * {@code workspace_unavailable} on the submitter family, 403
 * {@code session_operation_forbidden} on lifecycle and cwd, 403
 * {@code action_forbidden} on Action respond, 403
 * {@code artifact_content_forbidden} on artifact content with the policy
 * off) — plus one admitted-shape probe per rule class proving the request
 * reached business logic. The walk also fires the caller the two weakest
 * classes name as enough — the reader on reader routes, any tenant caller on
 * tenant-scoped ones — and requires an answer outside the admission
 * refusals, so demoting a whole capability family to a weaker class fails
 * too. Twin public/WebShell routes of one capability sit
 * in the same rule class, so the shared expectation table makes twin drift
 * fail. The refusal expectations pinned here are today's matrix; slice C
 * flips them with the role enforcement.
 *
 * <p>The internal probes run two different credentials: the Session-store
 * routes carry the broker-issued writer HMAC (a wrong token is refused at
 * the credential check with 403 {@code writer_credential_invalid}),
 * the tool-publication routes pass through either that same check or the
 * publication-grant redaction, so their exact wrong-token shapes are pinned
 * per route where the code falls.
 *
 * <p>SSE arms ({@code GET …/events?stream=true} and {@code
 * events/stream}) are probed below the read grant, where the refusal is
 * synchronous before the stream opens; the admitted stream shape is pinned
 * by the pre-existing stream suites.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:surface-acceptance;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=50ms",
        "qwen.managed-agent.events.poll-interval=10ms",
        "qwen.managed-agent.events.materialize-interval=10ms",
        "qwen.managed-agent.session-store.enabled=true",
        "qwen.managed-agent.session-store.binding-key="
                + "0123456789abcdef0123456789abcdef",
        "qwen.managed-agent.tool-publication.entry-concurrency=4",
        "qwen.managed-agent.artifacts.enabled=true",
        // The scheduled projector would race the publication-chain fixture
        // as it installs the artifact rows; the routes this test drives
        // only read the projected tables.
        "qwen.managed-agent.artifacts.projection-interval=86400000"
})
@AutoConfigureMockMvc
@Import({ManagedAgentServerIntegrationTest.FixtureConfiguration.class,
        SurfaceAdmissionAcceptanceTest.TestBeans.class})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SurfaceAdmissionAcceptanceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "owner";
    private static final String READER = "reader";
    private static final String OPERATOR = "operator";
    private static final String STRANGER = "stranger";
    private static final String FOREIGN = "foreign-tenant";
    private static final String WRONG_TOKEN =
            "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    private static final String WRITER_TOKEN = "X-Qwen-Managed-Writer-Token";
    private static final String ARTIFACT_TENANT = "tenant-1";
    private static final String ARTIFACT_WORKSPACE = "workspace-1";
    private static final String ARTIFACT_SESSION = "session-1";
    private static final Set<String> ADMISSION_REFUSALS = Set.of(
            "actor_required", "actor_scope_mismatch", "session_not_found",
            "workspace_not_found", "workspace_forbidden",
            "workspace_unavailable", "session_operation_forbidden",
            "action_forbidden", "artifact_content_forbidden");

    @Autowired
    private MockMvc mvc;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private WriterCredentialPolicy credentials;

    private final String tenant = "acc-" + UUID.randomUUID();
    private final AtomicInteger keys = new AtomicInteger();
    private String bound;
    private String legacy;
    private String pendingAction;
    private String pendingActionLegacy;
    private String artifactId;
    private String artifactItemId;

    @BeforeAll
    void graph() throws Exception {
        // The artifact family reuses the publication-chain fixture. It
        // projects one tool result with artifacts onto the shared schema
        // and asserts while doing so, so it builds before this graph's own
        // sessions write their events. Afterwards the test adds the
        // registry and grant rows the read paths join on.
        var fixture = ToolPublicationStoreTest.apiFixture(dataSource);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " (?, ?, 1, 'storage-1', 'Artifacts', 'config', 'policy',"
                + " 'ACTIVE')", ARTIFACT_TENANT, ARTIFACT_WORKSPACE);
        for (String actor : List.of(READER, OWNER)) {
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                    + " workspace_id, actor_id, can_read, can_create)"
                    + " VALUES (?, ?, ?, TRUE, FALSE)", ARTIFACT_TENANT,
                    ARTIFACT_WORKSPACE, actor.getBytes(StandardCharsets.UTF_8));
        }
        var artifacts = fixture.results()
                .listArtifacts(ARTIFACT_TENANT, ARTIFACT_SESSION, null, null,
                        null, 100).artifacts();
        assertThat(artifacts).isNotEmpty();
        artifactId = artifacts.getFirst().descriptor().path("id").asText();
        artifactItemId = fixture.sessions()
                .findSnapshot(ARTIFACT_TENANT, ARTIFACT_SESSION).orElseThrow()
                .items().getFirst().itemId();
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " (?, 'ws', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, OWNER, true);
        grant(tenant, READER, false);
        grant(tenant, OPERATOR, true);
        bound = createSession(tenant, OWNER, true);
        legacy = createSession(tenant, OWNER, false);
        pendingAction = insertAction(tenant, bound);
        pendingActionLegacy = insertAction(tenant, legacy);
    }

    static Stream<SurfaceRegistry> everyRoute() {
        return Stream.of(SurfaceRegistry.values());
    }

    @ParameterizedTest
    @MethodSource("everyRoute")
    void wrongTenantIsRefusedOnEveryRoute(SurfaceRegistry entry)
            throws Exception {
        MvcResult result = mvc.perform(requestFor(entry, FOREIGN, tenant))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as("%s answered %d for a cross-tenant principal",
                        entry.routeKey(), result.getResponse().getStatus())
                .isEqualTo(403);
        assertThat(result.getResponse().getContentAsString())
                .contains("actor_scope_mismatch");
    }

    @ParameterizedTest
    @MethodSource("everyRoute")
    void belowReadAndBelowFamilyProbesFollowTheRuleClass(SurfaceRegistry entry)
            throws Exception {
        switch (entry.ruleClass()) {
            case WORKSPACE_CREATE -> {
                expect(entry, null, 401, "actor_required");
                expect(entry, STRANGER, 404, "workspace_not_found");
                expect(entry, READER, 403, "workspace_forbidden");
            }
            case READER -> {
                if (entry.capabilities().contains(Capability.SESSION_LIST)) {
                    // The Session lists are tenant-scoped sets with the
                    // bound rows filtered below the grant; the reader is
                    // the control that proves the bound row is listable.
                    expectListed(entry, STRANGER, false);
                    expectListed(entry, null, false);
                    expectListed(entry, READER, true);
                } else {
                    // Every other reader family entry hides a bound
                    // Session below the grant and admits the reader. The
                    // stream would stay open; its public twin carries the
                    // admitted arm.
                    expect(entry, STRANGER, 404, "session_not_found");
                    expect(entry, null, 404, "session_not_found");
                    if (entry != SurfaceRegistry.WEBSHELL_EVENT_STREAM) {
                        expectAdmitted(entry, READER);
                    }
                }
            }
            case READER_ACTOR -> {
                expect(entry, null, 401, "actor_required");
                expect(entry, STRANGER, 404, "session_not_found");
            }
            case READER_ACTOR_POLICY -> {
                expect(entry, null, 401, "actor_required");
                expect(entry, STRANGER, 404, "session_not_found");
                expect(entry, READER, 403, "artifact_content_forbidden");
            }
            case OPERATOR -> {
                expect(entry, STRANGER, 404, "session_not_found");
                expect(entry, READER, 409, "workspace_unavailable");
                expect(entry, OPERATOR, 409, "workspace_unavailable");
            }
            case OWNER -> {
                expect(entry, STRANGER, 404, "session_not_found");
                String code = entry.capabilities().contains(
                        Capability.ACTION_RESPOND) ? "action_forbidden"
                        : "session_operation_forbidden";
                expect(entry, READER, 403, code);
                expect(entry, OPERATOR, 403, code);
                if (entry.capabilities().contains(
                        Capability.SESSION_CWD_CHANGE)) {
                    expect(entry, null, 401, "actor_required");
                }
            }
            case WORKSPACE_DISCOVERY ->
                expect(entry, null, 401, "actor_required");
            case TENANT_SCOPED -> {
                expectAdmitted(entry, STRANGER);
                expectAdmitted(entry, null);
            }
            case INTERNAL_WRITER ->
                expectInternal(entry);
            default -> throw new AssertionError(
                    "unexpected class " + entry.ruleClass());
        }
    }

    @Test
    void workspaceCreateAdmitsItsGrantHolderAcrossBothSurfaces()
            throws Exception {
        String createBody = "{\"agent_id\":\"qwen-code\",\"input\":[],"
                + "\"workspace\":{\"workspace_id\":\"ws\"}}";
        MvcResult created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.workspace.workspace_id").value("ws"))
                .andReturn();
        String session = JSON.readTree(created.getResponse()
                .getContentAsString()).path("id").asText();
        mvc.perform(post("/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"idempotencyKey\":\"" + nextKey()
                                + "\",\"agentId\":\"qwen-code\",\"input\":[],"
                                + "\"workspace\":{\"workspaceId\":\"ws\"}}"))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.sessionId").exists());
        assertThat(session).isNotBlank();
        // The state gate fires after the grants: a non-ACTIVE Workspace is
        // a domain refusal on the same family.
        jdbc.update("UPDATE managed_workspace_registry SET state = 'DRAINING'"
                + " WHERE tenant_id = ? AND workspace_id = 'ws'", tenant);
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("workspace_unavailable"));
        jdbc.update("UPDATE managed_workspace_registry SET state = 'ACTIVE'"
                + " WHERE tenant_id = ? AND workspace_id = 'ws'", tenant);
        // The legacy arm: no Workspace selection, no actor, admitted.
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .andExpect(status().isAccepted());
    }

    @Test
    void readerRoutesAnswerTheBoundGrantHolderAndTheLegacyArm()
            throws Exception {
        mvc.perform(get("/v1/agents/sessions/" + bound)
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, READER)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(bound));
        mvc.perform(post("/api/agent/web-shell/v1/sessions/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, READER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + bound + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sessionId").value(bound));
        mvc.perform(get("/v1/agents/sessions/" + bound + "/events")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, READER)))
                .andExpect(status().isOk());
        mvc.perform(post("/api/agent/web-shell/v1/transcript/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, READER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + bound + "\"}"))
                .andExpect(status().isOk());
        // The legacy arm is tenant-wide, anonymous callers included.
        mvc.perform(get("/v1/agents/sessions/" + legacy)
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(legacy));
    }

    @Test
    void submitterRoutesAdmitTheLegacyArmAndTheCreatorHitsDomainRefusal()
            throws Exception {
        // Every admitted mutation gets its own legacy Session, so no
        // in-progress operation or Turn collides with the next probe.
        String renamed = createSession(tenant, OWNER, false);
        mvc.perform(patch("/v1/agents/sessions/" + renamed)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OPERATOR))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"renamed\"}"))
                .andExpect(status().isOk());
        String receiving = createSession(tenant, OWNER, false);
        String second = createSession(tenant, OWNER, false);
        String message = "\"input\":[{\"type\":\"text\",\"text\":\"hi\"}]";
        MvcResult submitted = mvc.perform(post("/v1/agents/sessions/"
                        + receiving + "/events")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"agent.session.input.message\","
                                + message + "}"))
                .andExpect(status().isAccepted())
                .andReturn();
        assertThat(JSON.readTree(submitted.getResponse().getContentAsString())
                .path("turn_id").asText()).startsWith("turn_");
        mvc.perform(post("/api/agent/web-shell/v1/turns/submit")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"idempotencyKey\":\"" + nextKey()
                                + "\",\"sessionId\":\"" + second + "\","
                                + message + "}"))
                .andExpect(status().isAccepted());
        // Cancellation with an unknown Turn reaches the family logic: a
        // domain 404, not an admission refusal.
        mvc.perform(post("/api/agent/web-shell/v1/turns/cancel")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"idempotencyKey\":\"" + nextKey()
                                + "\",\"sessionId\":\"" + receiving
                                + "\",\"turnId\":\"turn_missing\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("turn_not_found"));
        // Today's bound arm: even the creator meets the files gate, a
        // domain 409 after admission.
        mvc.perform(post("/v1/agents/sessions/" + bound + "/events")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"agent.session.input.message\","
                                + message + "}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("workspace_unavailable"));
    }

    @Test
    void ownerRoutesAdmitTheRecordedCreatorAndTheLegacyArmWithDomainProofs()
            throws Exception {
        // The creator on the bound arm: today's files gate answers a
        // domain 409 after admission, proving the route was reached.
        mvc.perform(post("/v1/agents/sessions/" + bound + "/close")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OWNER)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("workspace_unavailable"));
        mvc.perform(post("/api/agent/web-shell/v1/sessions/cwd/change")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + bound
                                + "\",\"idempotencyKey\":\"" + nextKey()
                                + "\",\"cwdRelative\":\"sub\","
                                + "\"expectedContextRevision\":1}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("workspace_unavailable"));
        // Action respond by the recorded creator is admitted.
        mvc.perform(post("/v1/agents/sessions/" + bound + "/actions/"
                        + pendingAction + "/responses")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"kind\":\"permission\",\"input_revision\":1,"
                                + "\"policy_revision\":\"policy\","
                                + "\"option_id\":\"allow\"}"))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.type").value("action_response"));
        // The legacy arm of lifecycle is tenant-wide.
        String extra = createSession(tenant, OWNER, false);
        mvc.perform(post("/api/agent/web-shell/v1/sessions/close")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, STRANGER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + extra
                                + "\",\"idempotencyKey\":\"" + nextKey()
                                + "\"}"))
                .andExpect(status().isAccepted());
        // The legacy arm of cwd is bound-only: a domain refusal.
        mvc.perform(post("/v1/agents/sessions/" + legacy + "/cwd")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"cwd_relative\":\"sub\","
                                + "\"expected_context_revision\":1}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("unsupported_feature"));
        // The legacy arm of respond: the recorded creator answers. The
        // carrying Session is fresh: an accepted response parks an
        // ACTION_RESPONSE operation that must not shadow later probes.
        String answered = createSession(tenant, OWNER, false);
        String action = insertAction(tenant, answered);
        String body = "{\"sessionId\":\"" + answered + "\",\"actionId\":\""
                + action + "\",\"idempotencyKey\":\"" + nextKey()
                + "\",\"response\":{\"kind\":\"permission\","
                + "\"inputRevision\":1,\"policyRevision\":\"policy\","
                + "\"optionId\":\"allow\"}}";
        mvc.perform(post("/api/agent/web-shell/v1/actions/respond")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.type").value("action_response"));
    }

    @Test
    void actionRespondOnLegacyRefusesTheNonCreatorWithTheFamilyCode()
            throws Exception {
        mvc.perform(post("/api/agent/web-shell/v1/actions/respond")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, STRANGER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + legacy
                                + "\",\"actionId\":\"" + pendingActionLegacy
                                + "\",\"idempotencyKey\":\"" + nextKey()
                                + "\",\"response\":{\"kind\":\"permission\","
                                + "\"inputRevision\":1,\"policyRevision\":"
                                + "\"policy\",\"optionId\":\"allow\"}}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code")
                        .value("action_forbidden"));
    }

    @Test
    void discoveryRequiresAnActorAndFiltersToTheCallersReadableRows()
            throws Exception {
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id").value("ws"));
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, STRANGER)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isEmpty());
        mvc.perform(get("/v1/agents/workspaces/ungranted")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER)))
                .andExpect(status().isNotFound());
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"ws\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspaceId").value("ws"));
    }

    @Test
    void definitionsStayTenantWideAcrossTheArmSplit() throws Exception {
        String body = "{\"model\":{\"id\":\"qwen3-coder-plus\"},"
                + "\"instructions\":\"Review code.\",\"tools\":[],"
                + "\"permission_policy\":{\"mode\":\"default\"}}";
        MvcResult created = mvc.perform(post("/v1/agents")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted())
                .andReturn();
        String agent = JSON.readTree(created.getResponse()
                .getContentAsString()).path("id").asText();
        mvc.perform(get("/v1/agents/agent-missing")
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code")
                        .value("agent_not_found"));
        mvc.perform(post("/v1/agents/" + agent)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", nextKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(agent));
        mvc.perform(get("/v1/agents/" + agent)
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(agent));
    }

    @Test
    void artifactContentIsPolicyGatedBeyondTheWorkspaceReadGrant()
            throws Exception {
        // Metadata routes admit the readable actor, including the access
        // flag the deployment policy computes.
        mvc.perform(get("/v1/agents/sessions/" + ARTIFACT_SESSION
                        + "/artifacts")
                        .header(TenantContextFilter.HEADER, ARTIFACT_TENANT)
                        .principal(actor(ARTIFACT_TENANT, READER)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].access.can_read_content")
                        .value(false));
        mvc.perform(post("/api/agent/web-shell/v1/artifacts/query")
                        .header(TenantContextFilter.HEADER, ARTIFACT_TENANT)
                        .principal(actor(ARTIFACT_TENANT, READER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + ARTIFACT_SESSION
                                + "\"}"))
                .andExpect(status().isOk());
        mvc.perform(post("/api/agent/web-shell/v1/tool-results/get")
                        .header(TenantContextFilter.HEADER, ARTIFACT_TENANT)
                        .principal(actor(ARTIFACT_TENANT, READER))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + ARTIFACT_SESSION
                                + "\",\"itemId\":\"" + artifactItemId
                                + "\"}"))
                .andExpect(status().isOk());
        // Content: the policy denies the reader (403 below the actor's own
        // read grant); the admitted owner reaches the revision check, a
        // domain 400.
        mvc.perform(get("/v1/agents/sessions/" + ARTIFACT_SESSION
                        + "/artifacts/" + artifactId + "/content")
                        .header(TenantContextFilter.HEADER, ARTIFACT_TENANT)
                        .principal(actor(ARTIFACT_TENANT, READER)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code")
                        .value("artifact_content_forbidden"));
        mvc.perform(get("/v1/agents/sessions/" + ARTIFACT_SESSION
                        + "/artifacts/" + artifactId + "/content")
                        .header(TenantContextFilter.HEADER, ARTIFACT_TENANT)
                        .principal(actor(ARTIFACT_TENANT, OWNER)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("revision_required"));
        // The legacy arm has no artifact capability at all: a 404 rather
        // than a refusal.
        mvc.perform(get("/v1/agents/sessions/" + legacy
                        + "/items/item/tool-result")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, OWNER)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code")
                        .value("artifact_not_found"));
    }

    @Test
    void internalWriterRoutesEnforceTheSessionCredential() throws Exception {
        String session = createSession(tenant, OWNER, true);
        String token = credentials.issue(tenant, "ws", session);
        String base = "/internal/managed-session-store/v1/sessions/"
                + session;
        mvc.perform(post(base + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header(WRITER_TOKEN, WRONG_TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"ws\","
                                + "\"writerId\":\"writer\",\"leaseMillis\""
                                + ":60000}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code")
                        .value("writer_credential_invalid"));
        mvc.perform(post(base + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header(WRITER_TOKEN, token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"ws\","
                                + "\"writerId\":\"writer\",\"leaseMillis\""
                                + ":60000}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.writerGeneration").value(1));
        // A publication route carrying the writer credential refuses the
        // wrong token through the same policy. With the credential, the
        // same request passes the check and the writer's lease and reaches
        // the store, which finds no committed publication for the receipt:
        // a domain 400, never the credential refusal.
        String verify = "/internal/managed-tool-publications/v1/sessions/"
                + session + "/receipts/verify";
        mvc.perform(post(verify)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header(WRITER_TOKEN, WRONG_TOKEN)
                        .param("workspaceId", "ws")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"receipt\":{}}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code")
                        .value("writer_credential_invalid"));
        mvc.perform(post(verify)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header(WRITER_TOKEN, token)
                        .param("workspaceId", "ws")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"receipt\":{}}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_request"));
    }

    /**
     * The wrong-credential refusal the walk pins per internal route. The
     * Session-store routes and the writer-token-carrying publication routes
     * reach the credential policy first and answer 403
     * {@code writer_credential_invalid}; the publication-grant routes
     * validate the payload and publication scope before consulting the
     * credential, so their wrong-token refusal lands as a 400
     * domain-validation answer (404 for the operation status read). Every
     * value is pinned by observation, so the walk names the first route to
     * drift.
     */
    private void expectInternal(SurfaceRegistry entry) throws Exception {
        int status = switch (entry.capabilities().iterator().next()) {
            case STORE_EXECUTION_AUTHORIZE, STORE_LIFECYCLE_AUTHORIZE,
                    STORE_WRITER_ACQUIRE, STORE_WRITER_RENEW, STORE_WRITER_SEAL,
                    STORE_RECOVERY_BLOCK, STORE_TRANSACTION_COMMIT,
                    STORE_RESTORE, STORE_TOOL_RESULT_PUBLISH,
                    STORE_TRANSACTION_LIST, STORE_RESOURCE_GET, PUB_FINISHED,
                    PUB_ADMISSION_PREPARE, PUB_RECEIPT_VERIFY,
                    PUB_RANGE -> 403;
            case PUB_OPERATION_GET -> 404;
            default -> 400;
        };
        MvcResult result =
                mvc.perform(requestFor(entry, WRONG_TOKEN, tenant)).andReturn();
        assertThat(result.getResponse().getStatus())
                .as("%s answered %d for a wrong credential", entry.routeKey(),
                        result.getResponse().getStatus())
                .isEqualTo(status);
        if (entry == SurfaceRegistry.INTERNAL_EXECUTION_AUTHORIZE
                || entry == SurfaceRegistry.INTERNAL_LIFECYCLE_AUTHORIZE) {
            assertThat(JSON.readTree(result.getResponse().getContentAsString())
                    .path("error").path("code").asText())
                    .isEqualTo("writer_credential_invalid");
        }
    }

    /**
     * The caller the route's class names as enough gets an answer outside
     * the admission refusals: success or a domain refusal of its own. This
     * is what makes demoting a whole capability family to a weaker class
     * fail, since the probes of the stronger class are no longer fired.
     */
    private void expectAdmitted(SurfaceRegistry entry, String actor)
            throws Exception {
        String caller = actor == null ? "anonymous" : actor;
        MvcResult result = mvc.perform(requestFor(entry, actor, tenant))
                .andReturn();
        int status = result.getResponse().getStatus();
        String body = result.getResponse().getContentAsString();
        String code = body.isEmpty() ? ""
                : JSON.readTree(body).path("error").path("code").asText();
        assertThat(status).as("%s answered %d (%s): %s", entry.routeKey(),
                status, caller, body).isNotIn(401, 403).isLessThan(500);
        assertThat(code).as("%s refused %s", entry.routeKey(), caller)
                .isNotIn(ADMISSION_REFUSALS);
    }

    private void expect(SurfaceRegistry entry, String actor, int status,
            String code) throws Exception {
        String headerTenant = entry.ruleClass() == RuleClass.READER_ACTOR
                || entry.ruleClass() == RuleClass.READER_ACTOR_POLICY
                        ? ARTIFACT_TENANT : tenant;
        MockHttpServletRequestBuilder request = requestFor(entry, actor,
                headerTenant);
        MvcResult result = mvc.perform(request).andReturn();
        assertThat(result.getResponse().getStatus())
                .as("%s answered %d, expected %d (%s)", entry.routeKey(),
                        result.getResponse().getStatus(), status,
                        actor == null ? "anonymous" : actor)
                .isEqualTo(status);
        if (code != null) {
            assertThat(result.getResponse().getContentAsString())
                    .as("%s body (%s)", entry.routeKey(),
                            actor == null ? "anonymous" : actor)
                    .contains(code);
        }
    }

    /**
     * A Session list probe: every caller of the tenant gets a page holding
     * the legacy Session, and only a Workspace grant holder's page holds
     * the bound one. The page is sized past the class's Session count, so
     * an absent row was filtered, not paged out.
     */
    private void expectListed(SurfaceRegistry entry, String actor,
            boolean boundListed) throws Exception {
        String caller = actor == null ? "anonymous" : actor;
        MvcResult result = mvc.perform(requestFor(entry, actor, tenant))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as("%s answered %d (%s)", entry.routeKey(),
                        result.getResponse().getStatus(), caller)
                .isEqualTo(200);
        String idField = entry.surface() == Surface.PUBLIC ? "id"
                : "sessionId";
        List<String> listed = new ArrayList<>();
        JSON.readTree(result.getResponse().getContentAsString()).path("data")
                .forEach(row -> listed.add(row.path(idField).asText()));
        assertThat(listed).as("%s listed for %s", entry.routeKey(), caller)
                .contains(legacy);
        if (boundListed) {
            assertThat(listed).as("%s listed for %s", entry.routeKey(),
                    caller).contains(bound);
        } else {
            assertThat(listed).as("%s listed for %s", entry.routeKey(),
                    caller).doesNotContain(bound);
        }
    }

    /**
     * The request the walk fires for a registry entry: path variables
     * substituted from the fixture graph, the probe actor's principal (null
     * for anonymous, FOREIGN for a principal of another tenant), the
     * caller's own tenant header and the smallest body the route's argument
     * binding accepts, so the refusal comes from the admission path rather
     * than from argument validation. Actor == WRONG_TOKEN is the
     * internal-arm probe: no principal, the value is the writer token.
     */
    private MockHttpServletRequestBuilder requestFor(SurfaceRegistry entry,
            String actor, String headerTenant) {
        boolean artifactArm = entry.ruleClass() == RuleClass.READER_ACTOR
                || entry.ruleClass() == RuleClass.READER_ACTOR_POLICY;
        String session = artifactArm ? ARTIFACT_SESSION : bound;
        Map<String, String> variables = new LinkedHashMap<>();
        variables.put("sessionId", session);
        variables.put("operationId", "op_0000000000000000");
        variables.put("taskId", "task_0000000000000000");
        variables.put("turnId", "turn_0000000000000000");
        variables.put("actionId", pendingAction);
        variables.put("workspaceId", "ws");
        variables.put("agentId", "agent-missing");
        variables.put("itemId", artifactItemId);
        variables.put("artifactId", artifactId);
        variables.put("resourceId", "resource-0000000000000000");
        variables.put("publicationId", "publication-0000000000000000");
        variables.put("streamId", "stdout");
        variables.put("kind", "stdout.raw");
        variables.put("slot", "0");
        variables.put("ordinal", "0");
        String path = entry.template();
        for (Map.Entry<String, String> variable : variables.entrySet()) {
            String placeholder = "{" + variable.getKey() + "}";
            if (path.contains(placeholder)) {
                path = path.replace(placeholder, variable.getValue());
            }
        }
        List<String> query = new ArrayList<>();
        if (path.startsWith("/internal/managed-tool-publications/")) {
            query.add("workspaceId=ws");
        }
        if (path.startsWith("/internal/managed-session-store/")
                && "GET".equals(entry.method())) {
            query.add("workspaceId=ws");
        }
        if (entry == SurfaceRegistry.PUBLIC_SESSION_LIST) {
            query.add("limit=100");
        }
        if (!query.isEmpty()) {
            path += "?" + String.join("&", query);
        }
        MockHttpServletRequestBuilder request = switch (entry.method()) {
            case "GET" -> get(path);
            case "PATCH" -> patch(path);
            case "DELETE" -> delete(path);
            default -> post(path);
        };
        request.header(TenantContextFilter.HEADER, headerTenant);
        if ("POST".equals(entry.method()) || "PATCH".equals(entry.method())) {
            boolean octets = entry.capabilities().contains(
                    Capability.PUB_SEGMENT) || entry.capabilities().contains(
                    Capability.PUB_RESOURCE);
            request.contentType(octets ? MediaType.APPLICATION_OCTET_STREAM
                    : MediaType.APPLICATION_JSON);
            request.content(bodyFor(entry, headerTenant, session));
        }
        if (WRONG_TOKEN.equals(actor)) {
            if (path.startsWith("/internal/managed-tool-publications/")) {
                request.header("X-Qwen-Tool-Publication-Token", WRONG_TOKEN);
                request.header("X-Qwen-Tool-Publication-Operation",
                        "op-probe");
            }
            if (entry.capabilities().contains(
                    Capability.PUB_ADMISSION_PREPARE)) {
                request.header("X-Qwen-Managed-Writer-Id", "writer-probe");
                request.header("X-Qwen-Managed-Writer-Generation", "1");
            }
            return request.header(WRITER_TOKEN, WRONG_TOKEN);
        }
        if (FOREIGN.equals(actor)) {
            return request.principal(actor(FOREIGN, FOREIGN));
        }
        if (actor != null) {
            request.principal(actor(headerTenant, actor));
        }
        if (!"GET".equals(entry.method())
                && entry.surface() == Surface.PUBLIC) {
            request.header("Idempotency-Key", nextKey());
        }
        return request;
    }

    private String bodyFor(SurfaceRegistry entry, String tenant,
            String session) {
        Capability capability = entry.capabilities().iterator().next();
        boolean publicSurface = entry.surface() == Surface.PUBLIC;
        return switch (capability) {
            case SESSION_CREATE -> publicSurface
                    ? "{\"agent_id\":\"qwen-code\",\"input\":[],"
                            + "\"workspace\":{\"workspace_id\":\"ws\"}}"
                    : "{\"idempotencyKey\":\"" + nextKey()
                            + "\",\"agentId\":\"qwen-code\",\"input\":[],"
                            + "\"workspace\":{\"workspaceId\":\"ws\"}}";
            case TURN_SUBMIT -> publicSurface
                    ? "{\"type\":\"agent.session.input.message\",\"input\":"
                            + "[{\"type\":\"text\",\"text\":\"probe\"}]}"
                    : "{\"idempotencyKey\":\"" + nextKey()
                            + "\",\"sessionId\":\"" + session
                            + "\",\"input\":[{\"type\":\"text\","
                            + "\"text\":\"probe\"}]}";
            case SESSION_RENAME -> "{\"title\":\"probe\"}";
            case SESSION_CWD_CHANGE -> publicSurface
                    ? "{\"cwd_relative\":\"probe\","
                            + "\"expected_context_revision\":1}"
                    : "{\"sessionId\":\"" + session + "\",\"idempotencyKey\":\""
                            + nextKey() + "\",\"cwdRelative\":\"probe\","
                            + "\"expectedContextRevision\":1}";
            case SESSION_LIST -> "{\"limit\":100}";
            case SESSION_GET -> "{\"sessionId\":\"" + session + "\"}";
            case TRANSCRIPT_QUERY -> "{\"sessionId\":\"" + session + "\"}";
            case TAIL_EVENTS -> "{\"sessionId\":\"" + session
                    + "\",\"afterSequence\":0}";
            case TASK_LIST -> "{\"sessionId\":\"" + session + "\"}";
            case TASK_GET -> "{\"sessionId\":\"" + session
                    + "\",\"taskId\":\"task_0000000000000000\"}";
            case TASK_EVENT_LIST -> "{\"sessionId\":\"" + session
                    + "\",\"taskId\":\"task_0000000000000000\"}";
            case TURN_CANCEL -> "{\"idempotencyKey\":\"" + nextKey()
                    + "\",\"sessionId\":\"" + session
                    + "\",\"turnId\":\"turn_0000000000000000\"}";
            case SESSION_CLOSE, SESSION_ARCHIVE, SESSION_DELETE,
                    SESSION_UNARCHIVE -> "{\"sessionId\":\"" + session
                    + "\",\"idempotencyKey\":\"" + nextKey() + "\"}";
            case SESSION_OPERATION_GET -> "{\"sessionId\":\"" + session
                    + "\",\"operationId\":\"op_0000000000000000\"}";
            case ACTION_LIST -> "{\"sessionId\":\"" + session + "\"}";
            case ACTION_GET -> "{\"sessionId\":\"" + session
                    + "\",\"actionId\":\"" + pendingAction + "\"}";
            case ACTION_RESPOND -> publicSurface
                    ? "{\"kind\":\"permission\",\"input_revision\":1,"
                            + "\"policy_revision\":\"policy\","
                            + "\"option_id\":\"allow\"}"
                    : "{\"sessionId\":\"" + session + "\",\"actionId\":\""
                            + pendingAction + "\",\"idempotencyKey\":\""
                            + nextKey() + "\",\"response\":{\"kind\":"
                            + "\"permission\",\"inputRevision\":1,"
                            + "\"policyRevision\":\"policy\","
                            + "\"optionId\":\"allow\"}}";
            case TOOL_RESULT_GET -> "{\"sessionId\":\"" + session
                    + "\",\"itemId\":\"" + artifactItemId + "\"}";
            case ARTIFACT_GET -> "{\"sessionId\":\"" + session
                    + "\",\"artifactId\":\"" + artifactId + "\"}";
            case ARTIFACT_LIST -> "{\"sessionId\":\"" + session + "\"}";
            case WORKSPACE_LIST -> "{}";
            case WORKSPACE_GET -> "{\"workspaceId\":\"ws\"}";
            case AGENT_DEFINITION_CREATE, AGENT_DEFINITION_UPDATE ->
                "{\"model\":{\"id\":\"qwen3-coder-plus\"},\"instructions\":"
                        + "\"Review code.\",\"tools\":[],"
                        + "\"permission_policy\":{\"mode\":\"default\"}}";
            case STORE_WRITER_ACQUIRE -> "{\"workspaceId\":\"ws\","
                    + "\"writerId\":\"writer-probe\",\"leaseMillis\":60000}";
            case STORE_WRITER_RENEW -> "{\"workspaceId\":\"ws\","
                    + "\"writerId\":\"writer-probe\",\"writerGeneration\":1,"
                    + "\"leaseMillis\":60000}";
            case STORE_EXECUTION_AUTHORIZE, STORE_LIFECYCLE_AUTHORIZE,
                    STORE_WRITER_SEAL -> "{\"workspaceId\":\"ws\","
                    + "\"writerId\":\"writer-probe\",\"writerGeneration\":1}";
            case STORE_RECOVERY_BLOCK -> "{\"workspaceId\":\"ws\","
                    + "\"writerId\":\"writer-probe\",\"writerGeneration\":1,"
                    + "\"recoveryStatus\":\"BLOCKED_WORKSPACE\","
                    + "\"recoveryDetailCode\":\"probe\"}";
            case STORE_TRANSACTION_COMMIT -> "{\"workspaceId\":\"ws\","
                    + "\"writerId\":\"writer-probe\",\"writerGeneration\":1,"
                    + "\"expectedJournalRevision\":0,"
                    + "\"expectedCommittedSequence\":0,\"transactionId\":"
                    + "\"tx-probe\",\"operation\":\"probe\",\"commandId\":"
                    + "\"cmd-probe\",\"contentDigest\":\"" + digest()
                    + "\",\"firstSequence\":0,\"lastSequence\":0,"
                    + "\"eventCount\":0,\"eventsDigest\":\"" + digest()
                    + "\",\"activationEpoch\":0,\"recordCount\":1,"
                    + "\"recordBytesBase64\":\"eA==\",\"recordDigest\":\""
                    + digest() + "\"}";
            case STORE_TOOL_RESULT_PUBLISH -> "{\"workspaceId\":\"ws\","
                    + "\"writerId\":\"writer-probe\",\"writerGeneration\":1,"
                    + "\"resourceId\":\"resource-probe\",\"kind\":\"k\","
                    + "\"schemaVersion\":1,\"byteLength\":1,\"digest\":\""
                    + digest() + "\",\"bytesBase64\":\"eA==\"}";
            case PUB_GRANT -> "{\"sessionKey\":{\"tenantId\":\"" + tenant
                    + "\",\"workspaceId\":\"ws\",\"sessionId\":\"" + session
                    + "\"},\"operation\":\"release\",\"publicationId\":"
                    + "\"publication-0000000000000000\"}";
            case PUB_STREAM_SEAL -> "{\"segmentCount\":0,\"byteLength\":0,"
                    + "\"digest\":\"" + digest() + "\"}";
            case PUB_STREAM_PREFIX, PUB_OPERATION_GET,
                    PUB_OPERATION_RECOVER -> "{}";
            case PUB_FINISH -> "{\"result\":{}}";
            case PUB_ADMISSION_PREPARE -> "{\"schemaVersion\":1}";
            case PUB_RECEIPT_VERIFY -> "{\"receipt\":{}}";
            case PUB_RECEIPT_COMMIT -> "{\"workspaceId\":\"ws\",\"writerId\":"
                    + "\"writer-probe\",\"writerGeneration\":1,"
                    + "\"expectedJournalRevision\":0,"
                    + "\"expectedCommittedSequence\":0,\"transactionId\":"
                    + "\"tx-probe\",\"operation\":\"probe\",\"commandId\":"
                    + "\"cmd-probe\",\"contentDigest\":\"" + digest()
                    + "\",\"firstSequence\":0,\"lastSequence\":0,"
                    + "\"eventCount\":0,\"eventsDigest\":\"" + digest()
                    + "\",\"activationEpoch\":0,\"recordCount\":1,"
                    + "\"recordBytesBase64\":\"eA==\",\"recordDigest\":\""
                    + digest() + "\"}";
            case PUB_RANGE -> "{\"manifestRef\":{},\"expectedIdentity\":{},"
                    + "\"streamId\":\"stdout\",\"offset\":0,\"length\":1}";
            default -> "{}";
        };
    }

    private static String digest() {
        // The store models pin digests to ^[0-9a-f]{64}$ (no prefix).
        return "0".repeat(64);
    }

    private String createSession(String tenant, String actor, boolean workspace)
            throws Exception {
        MockHttpServletRequestBuilder create = post("/v1/agents/sessions")
                .header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", nextKey())
                .contentType(MediaType.APPLICATION_JSON)
                .content(workspace ? "{\"agent_id\":\"qwen-code\",\"input\":[],"
                        + "\"workspace\":{\"workspace_id\":\"ws\"}}"
                        : "{\"agent_id\":\"qwen-code\",\"input\":[]}");
        if (actor != null) {
            create.principal(actor(tenant, actor));
        }
        return JSON.readTree(mvc.perform(create)
                .andExpect(status().isAccepted()).andReturn().getResponse()
                .getContentAsString()).path("id").asText();
    }

    private void grant(String tenant, String actor, boolean canCreate) {
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, can_read, can_create) VALUES"
                + " (?, 'ws', ?, TRUE, ?)", tenant,
                actor.getBytes(StandardCharsets.UTF_8), canCreate);
    }

    private String insertAction(String tenant, String session)
            throws Exception {
        String action = "tool_approval_"
                + UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO managed_agent_action (tenant_id,"
                + " session_id, action_id, state, options_json, created_at)"
                + " VALUES (?, ?, ?, 'requested', ?, 0)", tenant, session,
                action, JSON.writeValueAsString(Map.of("expiresAt",
                        System.currentTimeMillis() + 3_600_000L,
                        "inputRevision", 1, "policyRevision", "policy",
                        "createdAt", 0L,
                        "options", List.of(Map.of("id", "allow"),
                                Map.of("id", "deny")))));
        return action;
    }

    private String nextKey() {
        return "probe-" + keys.incrementAndGet();
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
    static class TestBeans {
        /**
         * The artifact reader's backing store: publication object bytes
         * never leave the fixture database in this boot.
         */
        @Bean
        ToolPublicationObjectStore acceptanceObjects() {
            return mock(ToolPublicationObjectStore.class);
        }

        /** The content policy admits "owner" only, so the gate is visible. */
        @Bean
        @Primary
        ManagedArtifactPolicy acceptancePolicy() {
            return new ManagedArtifactPolicy() {
                @Override
                public String version() {
                    return "acceptance-policy/1";
                }

                @Override
                public boolean publishOriginal(String tenantId,
                        String workspaceId, String sessionId) {
                    return true;
                }

                @Override
                public boolean publishPreview(String tenantId,
                        String workspaceId, String sessionId) {
                    return true;
                }

                @Override
                public boolean readOriginal(String tenantId, String actorId,
                        String workspaceId, String sessionId) {
                    return OWNER.equals(actorId);
                }
            };
        }

        /**
         * The scheduled projector with its tick removed: it would race the
         * publication-chain fixture as it installs the artifact rows, and
         * the routes this test drives only read the projected tables.
         */
        @Bean
        @Primary
        com.alibaba.qwen.code.managedagent.store.ManagedToolResultProjector
                acceptanceProjector(
                        ManagedToolResultStore store, JdbcTemplate jdbc,
                        org.springframework.beans.factory.ObjectProvider<
                                ToolPublicationDataStore> publications,
                        com.alibaba.qwen.code.managedagent.store
                        .ManagedArtifactReader reader,
                        ManagedArtifactPolicy acceptancePolicy,
                        ManagedAgentProperties properties) {
            return new com.alibaba.qwen.code.managedagent.store
                    .ManagedToolResultProjector(store, jdbc, publications,
                            reader, acceptancePolicy, properties) {
                @Override
                public void tick() {
                }
            };
        }

        /**
         * The publication grant store, real over the fixture H2, so the
         * writer credential flows through the same code the service mounts.
         */
        @Bean
        ToolPublicationStore acceptancePublicationGrants(JdbcTemplate jdbc,
                PlatformTransactionManager manager,
                ManagedSessionStore sessions) {
            return new ToolPublicationStore(jdbc, manager, sessions,
                    mock(ToolExecutionRepository.class),
                    mock(RuntimeBindingRepository.class),
                    new ToolPublicationStore.Capacity(1024L * 1024 * 1024,
                            1024L * 1024 * 1024, 1024L * 1024 * 1024, 4),
                    false);
        }

        /**
         * The publication data store as a bean: it is also what makes the
         * artifact reader's {@code supported()} — and with it the whole
         * artifact route family — live in this boot.
         */
        @Bean
        ToolPublicationDataStore acceptancePublicationData(JdbcTemplate jdbc,
                PlatformTransactionManager manager,
                ToolPublicationStore acceptancePublicationGrants,
                ManagedSessionStore sessions,
                ToolPublicationObjectStore acceptanceObjects) {
            return new ToolPublicationDataStore(jdbc, manager,
                    acceptancePublicationGrants, sessions, acceptanceObjects,
                    Duration.ofSeconds(10), Duration.ofSeconds(5),
                    new ToolPublicationDataStore.VerificationBudget(
                            1024 * 1024, Duration.ofMinutes(25)));
        }

        /**
         * The internal publication controller, registered directly for the
         * reason the gate names: the {@code tool-publication.enabled}
         * chain requires a provisioned OSS client and Runtime Broker store
         * beans.
         */
        @Bean
        ToolPublicationController acceptanceToolPublication(JdbcTemplate jdbc,
                PlatformTransactionManager manager,
                ToolPublicationStore acceptancePublicationGrants,
                ToolPublicationDataStore acceptancePublicationData,
                ManagedSessionStore sessions,
                ManagedAgentProperties properties) {
            return new ToolPublicationController(
                    acceptancePublicationGrants, acceptancePublicationData,
                    new ToolPublicationAdmissionStore(jdbc, manager, sessions,
                            acceptancePublicationData),
                    properties);
        }
    }
}
