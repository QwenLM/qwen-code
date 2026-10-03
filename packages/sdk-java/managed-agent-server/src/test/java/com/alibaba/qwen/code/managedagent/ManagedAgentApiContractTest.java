package com.alibaba.qwen.code.managedagent;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.OpenApiContract.Operation;
import com.alibaba.qwen.code.managedagent.api.ApiModels;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CreateSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTask;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicWorkspace;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionCapabilities;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionEventRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionResyncRequired;
import com.alibaba.qwen.code.managedagent.api.ApiModels.UpdateSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCancelRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCreateRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellLifecycleRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellListRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellOperationRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellResyncRequired;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionCapabilities;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellStreamRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSubmitRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTask;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTaskGetRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTaskQueryRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscriptRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellWorkspace;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.RequestIdFilter;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.ValidationMessage;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-agent-contract;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=50ms",
        "qwen.managed-agent.events.poll-interval=10ms",
        "qwen.managed-agent.events.materialize-interval=10ms"
})
// SSE responses are still being written when MockMvc runs its result printer.
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(ManagedAgentServerIntegrationTest.FixtureConfiguration.class)
class ManagedAgentApiContractTest {
    private static final String KNOWN_GAPS = "openapi/contract-known-gaps.txt";
    private static final List<String> GAP_CATEGORIES = List.of("route",
            "record", "request", "response");
    private static final List<String> API_PREFIXES = List.of("/v1/agent",
            "/api/agent/web-shell/v1");
    private static final String WEB_SHELL = "/api/agent/web-shell/v1";
    private static final String TENANT = TenantContextFilter.HEADER;
    private static final String IDEMPOTENCY_KEY = "Idempotency-Key";
    private static final String RESYNC = "agent.session.resync_required";
    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final Map<Class<?>, List<String>> RECORD_SCHEMAS =
            Map.ofEntries(
                    entry(ApiModels.AgentDefinitionRequest.class, List.of("AgentDefinitionRequest")),
                    entry(ApiModels.AgentDefinition.class, List.of("AgentDefinition")),
                    entry(ApiModels.PermissionResponse.class, List.of("PermissionResponse")),
                    entry(ApiModels.WebShellPermissionResponse.class, List.of("WebShellPermissionResponse")),
                    entry(ApiModels.WebShellActionQueryRequest.class, List.of("WebShellActionQueryRequest")),
                    entry(ApiModels.WebShellActionGetRequest.class, List.of("WebShellActionGetRequest")),
                    entry(ApiModels.WebShellActionRespondRequest.class, List.of("WebShellActionRespondRequest")),
                    entry(ApiModels.PublicActionList.class, List.of("PublicActionList")),
                    entry(ApiModels.ArtifactAccess.class, List.of("ArtifactAccess")),
                    entry(ApiModels.ArtifactResponse.class, List.of("ArtifactResponse")),
                    entry(ApiModels.ToolResultResponse.class, List.of("ToolResultResponse")),
                    entry(ApiModels.WebShellArtifactQueryRequest.class, List.of("WebShellArtifactQueryRequest")),
                    entry(ApiModels.WebShellArtifactRequest.class, List.of("WebShellArtifactRequest")),
                    entry(ApiModels.WebShellToolResultRequest.class, List.of("WebShellToolResultRequest")),
                    entry(InputBlock.class, List.of("InputBlock")),
                    entry(CreateSessionRequest.class,
                            List.of("CreateSessionRequest")),
                    entry(SessionEventRequest.class,
                            List.of("SessionEventRequest")),
                    entry(UpdateSessionRequest.class,
                            List.of("UpdateSessionRequest")),
                    entry(CommandAdmission.class, List.of("CommandAdmission")),
                    entry(PublicTurn.class, List.of("PublicTurn")),
                    entry(PublicWorkspace.class, List.of("WorkspaceContext")),
                    entry(WebShellWorkspace.class,
                            List.of("WebShellWorkspaceContext")),
                    entry(PublicSession.class, List.of("PublicSession")),
                    entry(PublicCommandOperation.class,
                            List.of("PublicCommandOperation")),
                    entry(SessionCapabilities.class,
                            List.of("SessionCapabilities")),
                    entry(PublicList.class, List.of("PublicSessionList",
                            "PublicEventList", "PublicTaskList",
                            "PublicTurnList", "PublicArtifactList")),
                    entry(PublicEvent.class, List.of("PublicEvent")),
                    entry(SessionResyncRequired.class,
                            List.of("SessionResyncRequired")),
                    entry(PublicContentPart.class,
                            List.of("PublicContentPart")),
                    entry(PublicItem.class, List.of("PublicItem")),
                    entry(PublicItemList.class, List.of("PublicItemList")),
                    entry(WebShellListRequest.class,
                            List.of("WebShellListRequest")),
                    entry(WebShellSessionRequest.class,
                            List.of("WebShellSessionRequest")),
                    entry(WebShellTranscriptRequest.class,
                            List.of("WebShellTranscriptRequest")),
                    entry(WebShellStreamRequest.class,
                            List.of("WebShellStreamRequest")),
                    entry(WebShellCreateRequest.class,
                            List.of("WebShellCreateRequest")),
                    entry(WebShellSubmitRequest.class,
                            List.of("WebShellSubmitRequest")),
                    entry(WebShellCancelRequest.class,
                            List.of("WebShellCancelRequest")),
                    entry(WebShellAdmission.class,
                            List.of("WebShellAdmission")),
                    entry(WebShellLifecycleRequest.class,
                            List.of("WebShellLifecycleRequest")),
                    entry(WebShellOperationRequest.class,
                            List.of("WebShellOperationRequest")),
                    entry(WebShellCommandOperation.class,
                            List.of("WebShellCommandOperation")),
                    entry(WebShellTurn.class, List.of("WebShellTurn")),
                    entry(WebShellSession.class, List.of("WebShellSession")),
                    entry(WebShellSessionCapabilities.class,
                            List.of("WebShellSessionCapabilities")),
                    entry(WebShellPage.class, List.of("WebShellSessionPage",
                            "WebShellTaskPage", "WebShellActionPage", "WebShellArtifactPage")),
                    entry(PublicTask.class, List.of("PublicTask")),
                    entry(WebShellTask.class, List.of("WebShellTask")),
                    entry(WebShellTaskQueryRequest.class,
                            List.of("WebShellTaskQueryRequest")),
                    entry(WebShellTaskGetRequest.class,
                            List.of("WebShellTaskGetRequest")),
                    entry(WebShellEvent.class, List.of("WebShellEvent")),
                    entry(WebShellResyncRequired.class,
                            List.of("WebShellResyncRequired")),
                    entry(WebShellContentPart.class,
                            List.of("WebShellContentPart")),
                    entry(WebShellItem.class, List.of("WebShellItem")),
                    entry(WebShellTranscript.class,
                            List.of("WebShellTranscript")));

    private final Set<String> exercised = new TreeSet<>();

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private FixtureHarness harness;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private ManagedSessionStore sessionStore;

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

    @Test
    void tenantFilteredRoutesDeclareAndReturnTheActorScopeRefusal() throws Exception {
        Map<String, String> drift = new TreeMap<>();
        for (Operation operation : CONTRACT.operations()) {
            if (!operation.path().equals("/v1/agents")
                    && !operation.path().startsWith("/v1/agents/")
                    && !operation.path().startsWith(WEB_SHELL + "/")) {
                continue;
            }
            assertThat(operation.node().path("responses").path("403").path("$ref").asText())
                    .as("%s declares the tenant filter refusal", operation.operationId())
                    .isEqualTo("#/components/responses/Forbidden");
            if ("planned".equals(operation.status())) {
                continue;
            }
            String path = operation.path().replaceAll("\\{[^}]+}", "scope-probe");
            MockHttpServletRequestBuilder request = request(
                    HttpMethod.valueOf(operation.method()), path)
                    .header(TENANT, "contract-tenant").principal(actor("other-tenant"));
            exchange(drift, operation.operationId(), 403, request, null);
        }
        assertThat(drift)
                .as("Actor-scope drift is not deferrable; fix it instead of recording a gap in %s",
                        KNOWN_GAPS)
                .isEmpty();
    }

    @Test
    void mappedRoutesMatchTheSpec() {
        Map<String, String> statuses = new TreeMap<>();
        for (Operation operation : CONTRACT.operations()) {
            statuses.put(operation.method() + " " + operation.path(),
                    operation.status());
        }
        Set<String> mapped = new TreeSet<>();
        handlerMapping.getHandlerMethods().keySet().forEach(info -> {
            for (String pattern : info.getPatternValues()) {
                if (API_PREFIXES.stream().anyMatch(pattern::startsWith)) {
                    for (RequestMethod method
                            : info.getMethodsCondition().getMethods()) {
                        mapped.add(method.name() + " " + pattern);
                    }
                }
            }
        });
        assertThat(mapped).isNotEmpty();
        Map<String, String> drift = new TreeMap<>();
        for (String route : mapped) {
            String status = statuses.get(route);
            if (status == null) {
                drift.put("route " + route + " is mapped but not in the spec",
                        "");
            } else if ("planned".equals(status)) {
                drift.put("route " + route + " is mapped but planned", "");
            }
        }
        statuses.forEach((route, status) -> {
            if (!"planned".equals(status) && !mapped.contains(route)) {
                drift.put("route " + route + " is " + status
                        + " but not mapped", "");
            }
        });
        assertKnownGaps(drift, "route");
    }

    @Test
    void recordsMatchTheirSchemas() {
        Map<String, String> drift = new TreeMap<>();
        for (Class<?> type : ApiModels.class.getDeclaredClasses()) {
            if (!type.isRecord()) {
                continue;
            }
            List<String> schemas = RECORD_SCHEMAS.get(type);
            if (schemas == null) {
                drift.put("record " + type.getSimpleName() + " has no schema",
                        "");
                continue;
            }
            Set<String> fields = jsonProperties(type);
            for (String schema : schemas) {
                Map<String, Boolean> planned =
                        CONTRACT.plannedByProperty(schema);
                assertThat(planned).as("properties of %s", schema)
                        .isNotEmpty();
                String prefix = "record " + type.getSimpleName() + " -> "
                        + schema + ": ";
                planned.forEach((name, isPlanned) -> {
                    if (!isPlanned && !fields.contains(name)) {
                        drift.put(prefix + "missing " + name, "");
                    }
                });
                for (String field : fields) {
                    if (!planned.containsKey(field)) {
                        drift.put(prefix + "extra " + field, "");
                    }
                }
            }
        }
        assertKnownGaps(drift, "record");
    }

    @Test
    void routesAnswerWithTheirSchemas() throws Exception {
        Map<String, String> drift = new TreeMap<>();
        String tenant = "tenant-contract-" + UUID.randomUUID();
        String otherTenant = tenant + "-other";

        String sessionId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-create"),
                """
                {"agent_id":"qwen-code","metadata":{"title":"contract"},
                 "input":[{"type":"input_text","text":"hello"}]}
                """)).get("id").asText();
        exchange(drift, "listArtifacts", 401,
                get("/v1/agents/sessions/%s/artifacts".formatted(sessionId))
                        .header(TENANT, tenant), null);
        exchange(drift, "getArtifactContent", 401,
                get("/v1/agents/sessions/%s/artifacts/artifact_missing/content".formatted(sessionId))
                        .header(TENANT, tenant), null);
        exchange(drift, "getWebShellToolResult", 401,
                post("/api/agent/web-shell/v1/tool-results/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"itemId\":\"item_missing\"}".formatted(sessionId));
        exchange(drift, "getWebShellArtifact", 401,
                post("/api/agent/web-shell/v1/artifacts/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"artifactId\":\"artifact_missing\"}".formatted(sessionId));
        exchange(drift, "queryWebShellArtifacts", 401,
                post("/api/agent/web-shell/v1/artifacts/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\"}".formatted(sessionId));
        exchange(drift, "getToolResult", 401,
                get("/v1/agents/sessions/%s/items/item_missing/tool-result".formatted(sessionId))
                        .header(TENANT, tenant), null);
        exchange(drift, "getArtifact", 401,
                get("/v1/agents/sessions/%s/artifacts/artifact_missing".formatted(sessionId))
                        .header(TENANT, tenant), null);
        MockHttpServletResponse publicStream = stream(drift,
                "getSessionEvents",
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("stream", "true").header(TENANT, tenant),
                null);
        exchange(drift, "createSession", 409,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-create"),
                "{\"agent_id\":\"qwen-code\"}");
        exchange(drift, "createSession", 400,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-revision"),
                "{\"agent_id\":\"qwen-code\",\"agent_revision\":\"other\"}");
        exchange(drift, "listSessions", 200, get("/v1/agents/sessions")
                .param("limit", "100").header(TENANT, tenant), null);
        exchange(drift, "listSessions", 400, get("/v1/agents/sessions")
                .param("limit", "0").header(TENANT, tenant), null);
        exchange(drift, "listSessions", 400, get("/v1/agents/sessions"),
                null);
        exchange(drift, "listSessions", 403, get("/v1/agents/sessions")
                .header(TENANT, tenant).principal(actor(otherTenant)), null);
        exchange(drift, "getSession", 404,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, otherTenant), null);
        exchange(drift, "getSession", 400,
                get("/v1/agents/sessions/{id}", sessionId), null);
        exchange(drift, "getSession", 403,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant).principal(actor(otherTenant)),
                null);
        exchange(drift, "createSession", 401,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-no-actor"),
                """
                {"agent_id":"qwen-code","workspace":{"workspace_id":"ws-a"}}
                """);
        harness.setAvailable(false);
        try {
            exchange(drift, "createSession", 503,
                    post("/v1/agents/sessions").header(TENANT, tenant)
                            .header(IDEMPOTENCY_KEY, "contract-no-harness"),
                    """
                    {"agent_id":"qwen-code",
                     "input":[{"type":"input_text","text":"hi"}]}
                    """);
            exchange(drift, "webShellCreateSession", 503,
                    post(WEB_SHELL + "/sessions/create").header(TENANT, tenant),
                    """
                    {"idempotencyKey":"contract-web-no-harness",
                     "agentId":"qwen-code",
                     "input":[{"type":"input_text","text":"hi"}]}
                    """);
        } finally {
            harness.setAvailable(true);
        }
        awaitMaterialized(tenant, sessionId);
        exchange(drift, "getSession", 200,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant), null);
        exchange(drift, "getSessionEvents", 200,
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TENANT, tenant)
                        .accept(MediaType.APPLICATION_JSON), null);
        exchange(drift, "getSessionEvents", 200,
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("limit", "1000").header(TENANT, tenant)
                        .accept(MediaType.APPLICATION_JSON), null);
        exchange(drift, "getSessionEvents", 404,
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("stream", "true").header(TENANT, otherTenant)
                        .accept(MediaType.TEXT_EVENT_STREAM), null);
        exchange(drift, "getSessionEvents", 400,
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("limit", "0").header(TENANT, tenant)
                        .accept(MediaType.APPLICATION_JSON), null);
        exchange(drift, "listItems", 200,
                get("/v1/agents/sessions/{id}/items", sessionId)
                        .param("limit", "100").header(TENANT, tenant), null);
        exchange(drift, "listItems", 400,
                get("/v1/agents/sessions/{id}/items", sessionId)
                        .param("limit", "0").header(TENANT, tenant), null);
        checkReplayFloor(drift, tenant);
        exchange(drift, "updateSession", 200,
                patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-rename"),
                "{\"title\":\"renamed\"}");
        exchange(drift, "archiveSession", 409,
                post("/v1/agents/sessions/{id}/archive", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-archive-active"),
                null);
        exchange(drift, "closeSession", 400,
                post("/v1/agents/sessions/{id}/close", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "two words"), null);
        exchange(drift, "closeSession", 404,
                post("/v1/agents/sessions/{id}/close", sessionId)
                        .header(TENANT, otherTenant)
                        .header(IDEMPOTENCY_KEY, "contract-foreign-close"),
                null);
        exchange(drift, "closeSession", 403,
                post("/v1/agents/sessions/{id}/close", sessionId)
                        .header(TENANT, tenant).principal(actor(otherTenant))
                        .header(IDEMPOTENCY_KEY, "contract-foreign-close"),
                null);
        // The Harness fails every close, so the close waits and the Session
        // reads closing until the Harness closes it.
        String closeId;
        harness.failCloses(Integer.MAX_VALUE);
        try {
            JsonNode closing = json(exchange(drift, "closeSession", 202,
                    post("/v1/agents/sessions/{id}/close", sessionId)
                            .header(TENANT, tenant)
                            .header(IDEMPOTENCY_KEY, "contract-close"), null));
            assertThat(closing.get("status").asText()).isEqualTo("pending");
            closeId = closing.get("id").asText();
            await().atMost(Duration.ofSeconds(5)).until(() ->
                    jdbc.queryForObject("SELECT attempt_count FROM"
                                    + " managed_agent_operation WHERE"
                                    + " operation_id = ?", Integer.class,
                            closeId) > 0);
            assertThat(json(exchange(drift, "getSession", 200,
                    get("/v1/agents/sessions/{id}", sessionId)
                            .header(TENANT, tenant), null))
                    .get("status").asText()).isEqualTo("closing");
            assertThat(json(exchange(drift, "getSessionCwdOperation", 200,
                    get("/v1/agents/sessions/{id}/operations/{op}",
                            sessionId, closeId).header(TENANT, tenant), null))
                    .get("status").asText()).isEqualTo("running");
            exchange(drift, "deleteSession", 409,
                    delete("/v1/agents/sessions/{id}", sessionId)
                            .header(TENANT, tenant)
                            .header(IDEMPOTENCY_KEY, "contract-delete-busy"),
                    null);
            exchange(drift, "deleteWebShellSession", 409,
                    post(WEB_SHELL + "/sessions/delete").header(TENANT, tenant),
                    """
                    {"sessionId":"%s","idempotencyKey":"contract-web-busy"}
                    """.formatted(sessionId));
        } finally {
            harness.failCloses(0);
        }
        awaitOperation(tenant, sessionId, closeId);
        JsonNode replayedClose = json(exchange(drift, "closeSession", 202,
                post("/v1/agents/sessions/{id}/close", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-close"), null));
        assertThat(replayedClose.get("id").asText()).isEqualTo(closeId);
        assertThat(replayedClose.get("replayed").asBoolean()).isTrue();
        assertThat(replayedClose.get("admission_stage").asText())
                .isEqualTo("harness_confirmed");
        exchange(drift, "closeSession", 409,
                post("/v1/agents/sessions/{id}/close", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-close-again"), null);
        exchange(drift, "getSessionCwdOperation", 404,
                get("/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        closeId).header(TENANT, otherTenant), null);
        exchange(drift, "getSessionCwdOperation", 404,
                get("/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        "op_missing").header(TENANT, tenant), null);
        exchange(drift, "getSessionCwdOperation", 403,
                get("/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        closeId).header(TENANT, tenant)
                        .principal(actor(otherTenant)), null);
        exchange(drift, "getSessionCwdOperation", 400,
                get("/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        closeId), null);
        assertThat(json(exchange(drift, "getSessionCwdOperation", 400,
                get("/v1/agents/sessions/{id}/operations/{op}", sessionId,
                        "op_" + "0".repeat(62)).header(TENANT, tenant), null))
                .path("error").path("code").asText())
                .isEqualTo("invalid_request");
        JsonNode archived = json(exchange(drift, "archiveSession", 202,
                post("/v1/agents/sessions/{id}/archive", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-archive"), null));
        assertThat(archived.get("status").asText()).isEqualTo("completed");
        assertThat(json(exchange(drift, "getSession", 200,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant), null))
                .get("status").asText()).isEqualTo("archived");
        exchange(drift, "listSessions", 200, get("/v1/agents/sessions")
                .param("limit", "100").header(TENANT, tenant), null);
        assertThat(json(exchange(drift, "unarchiveSession", 200,
                post("/v1/agents/sessions/{id}/unarchive", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-unarchive"), null))
                .get("status").asText()).isEqualTo("closed");

        String cancelledId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-create-idle"),
                """
                {"agent_id":"qwen-code","agent_revision":"1","input":[]}
                """)).get("id").asText();
        String turnId = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", cancelledId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-input"),
                """
                {"type":"agent.session.input.message",
                 "input":[{"type":"input_text","text":"hold"}]}
                """)).get("turn_id").asText();
        int cancels = awaitHeldTurn();
        exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", cancelledId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-cancel"),
                """
                {"type":"agent.session.cancel","turn_id":"%s"}
                """.formatted(turnId));
        JsonNode cancelling = json(exchange(drift, "getSession", 200,
                get("/v1/agents/sessions/{id}", cancelledId)
                        .header(TENANT, tenant), null)).get("active_turn");
        assertThat(cancelling.get("status").asText()).isEqualTo("cancelling");
        assertThat(cancelling.get("input_item_id").asText())
                .isEqualTo("item_" + turnId + "_input");
        settleCancelledTurn(tenant, cancelledId, cancels);

        String webSessionId = json(exchange(drift, "webShellCreateSession",
                202, post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant),
                """
                {"requestId":"contract-trace","idempotencyKey":"contract-web",
                 "agentId":"qwen-code","title":"web",
                 "metadata":{"clientId":"contract"},"input":[]}
                """)).get("sessionId").asText();
        MockHttpServletResponse webShellStream = stream(drift,
                "webShellStreamEvents",
                post(WEB_SHELL + "/events/stream").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"afterSequence\":0}"
                        .formatted(webSessionId));
        exchange(drift, "webShellListSessions", 200,
                post(WEB_SHELL + "/sessions/query").header(TENANT, tenant),
                "{\"limit\":100}");
        exchange(drift, "webShellListSessions", 400,
                post(WEB_SHELL + "/sessions/query").header(TENANT, tenant),
                "{\"limit\":0}");
        exchange(drift, "webShellGetSession", 404,
                post(WEB_SHELL + "/sessions/get").header(TENANT, otherTenant),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "webShellGetSession", 400,
                post(WEB_SHELL + "/sessions/get").header(TENANT, tenant),
                "{}");
        exchange(drift, "webShellGetSession", 403,
                post(WEB_SHELL + "/sessions/get").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "webShellListSessions", 403,
                post(WEB_SHELL + "/sessions/query").header(TENANT, tenant)
                        .principal(actor(otherTenant)), "{}");
        exchange(drift, "webShellCreateSession", 401,
                post(WEB_SHELL + "/sessions/create").header(TENANT, tenant),
                """
                {"idempotencyKey":"contract-web-no-actor","agentId":"qwen-code",
                 "workspace":{"workspaceId":"ws-a"}}
                """);
        exchange(drift, "webShellTranscript", 404,
                post(WEB_SHELL + "/transcript/query")
                        .header(TENANT, otherTenant),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "webShellTranscript", 400,
                post(WEB_SHELL + "/transcript/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"limit\":0}".formatted(webSessionId));
        exchange(drift, "webShellStreamEvents", 404,
                post(WEB_SHELL + "/events/stream").header(TENANT, otherTenant)
                        .accept(MediaType.TEXT_EVENT_STREAM),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "webShellStreamEvents", 400,
                post(WEB_SHELL + "/events/stream").header(TENANT, tenant)
                        .accept(MediaType.TEXT_EVENT_STREAM),
                "{}");
        exchange(drift, "webShellSubmitTurn", 404,
                post(WEB_SHELL + "/turns/submit").header(TENANT, otherTenant),
                """
                {"requestId":"contract-foreign-trace",
                 "idempotencyKey":"contract-foreign","sessionId":"%s",
                 "input":[{"type":"input_text","text":"hi"}]}
                """.formatted(webSessionId));
        exchange(drift, "webShellSubmitTurn", 400,
                post(WEB_SHELL + "/turns/submit").header(TENANT, tenant),
                """
                {"idempotencyKey":"contract-image","sessionId":"%s",
                 "input":[{"type":"image","text":"hi"}]}
                """.formatted(webSessionId));
        exchange(drift, "webShellCancelTurn", 404,
                post(WEB_SHELL + "/turns/cancel").header(TENANT, otherTenant),
                """
                {"idempotencyKey":"contract-foreign-stop","sessionId":"%s",
                 "turnId":"turn_missing"}
                """.formatted(webSessionId));
        exchange(drift, "webShellCancelTurn", 400,
                post(WEB_SHELL + "/turns/cancel").header(TENANT, tenant),
                """
                {"idempotencyKey":"contract-no-turn","sessionId":"%s"}
                """.formatted(webSessionId));
        String webTurnId = json(exchange(drift, "webShellSubmitTurn", 202,
                post(WEB_SHELL + "/turns/submit").header(TENANT, tenant),
                """
                {"requestId":"contract-trace","idempotencyKey":"contract-submit",
                 "sessionId":"%s","metadata":{"clientId":"contract"},
                 "input":[{"type":"input_text","text":"hold"}]}
                """.formatted(webSessionId))).get("turnId").asText();
        cancels = awaitHeldTurn();
        exchange(drift, "webShellCancelTurn", 202,
                post(WEB_SHELL + "/turns/cancel").header(TENANT, tenant),
                """
                {"requestId":"contract-trace","idempotencyKey":"contract-stop",
                 "sessionId":"%s","turnId":"%s"}
                """.formatted(webSessionId, webTurnId));
        settleCancelledTurn(tenant, webSessionId, cancels);
        awaitMaterialized(tenant, webSessionId);
        exchange(drift, "webShellGetSession", 200,
                post(WEB_SHELL + "/sessions/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "webShellTranscript", 200,
                post(WEB_SHELL + "/transcript/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "webShellTranscript", 200,
                post(WEB_SHELL + "/transcript/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"limit\":1000}"
                        .formatted(webSessionId));

        String webInputId = json(exchange(drift, "webShellCreateSession",
                202, post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant),
                """
                {"requestId":"contract-trace","idempotencyKey":"contract-web-input",
                 "agentId":"qwen-code","input":[{"type":"input_text","text":"hello"}]}
                """)).get("sessionId").asText();
        awaitMaterialized(tenant, webInputId);

        exchange(drift, "closeWebShellSession", 400,
                post(WEB_SHELL + "/sessions/close").header(TENANT, tenant),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "closeWebShellSession", 404,
                post(WEB_SHELL + "/sessions/close").header(TENANT, otherTenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-foreign"}
                """.formatted(webSessionId));
        exchange(drift, "closeWebShellSession", 403,
                post(WEB_SHELL + "/sessions/close").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-foreign"}
                """.formatted(webSessionId));
        exchange(drift, "archiveWebShellSession", 409,
                post(WEB_SHELL + "/sessions/archive").header(TENANT, tenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-active"}
                """.formatted(webSessionId));
        String webCloseId = json(exchange(drift, "closeWebShellSession", 202,
                post(WEB_SHELL + "/sessions/close").header(TENANT, tenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-close"}
                """.formatted(webSessionId))).get("operationId").asText();
        awaitOperation(tenant, webSessionId, webCloseId);
        JsonNode webClosed = json(exchange(drift,
                "webShellQueryCwdOperation", 200,
                post(WEB_SHELL + "/operations/query").header(TENANT, tenant),
                """
                {"sessionId":"%s","operationId":"%s"}
                """.formatted(webSessionId, webCloseId)));
        assertThat(webClosed.get("status").asText()).isEqualTo("completed");
        assertThat(webClosed.get("replayed").asBoolean()).isFalse();
        exchange(drift, "closeWebShellSession", 409,
                post(WEB_SHELL + "/sessions/close").header(TENANT, tenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-again"}
                """.formatted(webSessionId));
        exchange(drift, "webShellQueryCwdOperation", 404,
                post(WEB_SHELL + "/operations/query")
                        .header(TENANT, otherTenant),
                """
                {"sessionId":"%s","operationId":"%s"}
                """.formatted(webSessionId, webCloseId));
        exchange(drift, "webShellQueryCwdOperation", 400,
                post(WEB_SHELL + "/operations/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        exchange(drift, "webShellQueryCwdOperation", 400,
                post(WEB_SHELL + "/operations/query").header(TENANT, tenant),
                """
                {"sessionId":"%s","operationId":"op_%s"}
                """.formatted(webSessionId, "0".repeat(62)));
        exchange(drift, "webShellQueryCwdOperation", 403,
                post(WEB_SHELL + "/operations/query").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                """
                {"sessionId":"%s","operationId":"%s"}
                """.formatted(webSessionId, webCloseId));
        exchange(drift, "archiveWebShellSession", 202,
                post(WEB_SHELL + "/sessions/archive").header(TENANT, tenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-archive"}
                """.formatted(webSessionId));
        exchange(drift, "archiveWebShellSession", 404,
                post(WEB_SHELL + "/sessions/archive")
                        .header(TENANT, otherTenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-foreign"}
                """.formatted(webSessionId));
        exchange(drift, "archiveWebShellSession", 400,
                post(WEB_SHELL + "/sessions/archive").header(TENANT, tenant),
                "{}");
        exchange(drift, "archiveWebShellSession", 403,
                post(WEB_SHELL + "/sessions/archive").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-foreign"}
                """.formatted(webSessionId));
        for (int attempt = 0; attempt < 2; attempt++) {
            exchange(drift, "unarchiveWebShellSession", 200,
                    post(WEB_SHELL + "/sessions/unarchive").header(TENANT, tenant),
                    """
                    {"sessionId":"%s","idempotencyKey":"contract-web-unarchive"}
                    """.formatted(webSessionId));
        }
        exchange(drift, "unarchiveWebShellSession", 409,
                post(WEB_SHELL + "/sessions/unarchive").header(TENANT, tenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-unarchive-again"}
                """.formatted(webSessionId));
        exchange(drift, "unarchiveWebShellSession", 404,
                post(WEB_SHELL + "/sessions/unarchive").header(TENANT, otherTenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-unarchive"}
                """.formatted(webSessionId));
        exchange(drift, "unarchiveWebShellSession", 400,
                post(WEB_SHELL + "/sessions/unarchive").header(TENANT, tenant), "{}");
        exchange(drift, "unarchiveWebShellSession", 403,
                post(WEB_SHELL + "/sessions/unarchive").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-unarchive"}
                """.formatted(webSessionId));
        exchange(drift, "deleteWebShellSession", 404,
                post(WEB_SHELL + "/sessions/delete")
                        .header(TENANT, otherTenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-foreign"}
                """.formatted(webSessionId));
        exchange(drift, "deleteWebShellSession", 400,
                post(WEB_SHELL + "/sessions/delete").header(TENANT, tenant),
                "{}");
        exchange(drift, "deleteWebShellSession", 403,
                post(WEB_SHELL + "/sessions/delete").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-foreign"}
                """.formatted(webSessionId));
        String webDeleteId = json(exchange(drift, "deleteWebShellSession", 202,
                post(WEB_SHELL + "/sessions/delete").header(TENANT, tenant),
                """
                {"sessionId":"%s","idempotencyKey":"contract-web-delete"}
                """.formatted(webSessionId))).get("operationId").asText();
        awaitOperation(tenant, webSessionId, webDeleteId);
        exchange(drift, "deleteSession", 400,
                delete("/v1/agents/sessions/{id}", webInputId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "two words"), null);
        exchange(drift, "deleteSession", 403,
                delete("/v1/agents/sessions/{id}", webInputId)
                        .header(TENANT, tenant).principal(actor(otherTenant))
                        .header(IDEMPOTENCY_KEY, "contract-foreign-delete"),
                null);
        exchange(drift, "deleteSession", 404,
                delete("/v1/agents/sessions/{id}", webInputId)
                        .header(TENANT, otherTenant)
                        .header(IDEMPOTENCY_KEY, "contract-foreign-delete"),
                null);
        exchange(drift, "archiveSession", 400,
                post("/v1/agents/sessions/{id}/archive", webInputId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "two words"), null);
        exchange(drift, "archiveSession", 403,
                post("/v1/agents/sessions/{id}/archive", webInputId)
                        .header(TENANT, tenant).principal(actor(otherTenant))
                        .header(IDEMPOTENCY_KEY, "contract-foreign-archive"),
                null);
        exchange(drift, "archiveSession", 404,
                post("/v1/agents/sessions/{id}/archive", webInputId)
                        .header(TENANT, otherTenant)
                        .header(IDEMPOTENCY_KEY, "contract-foreign-archive"),
                null);
        awaitIdle(tenant, webInputId);
        for (String id : List.of(sessionId, cancelledId, webInputId)) {
            String deleteId = json(exchange(drift, "deleteSession", 202,
                    delete("/v1/agents/sessions/{id}", id)
                            .header(TENANT, tenant)
                            .header(IDEMPOTENCY_KEY, "contract-delete-" + id),
                    null)).get("id").asText();
            awaitOperation(tenant, id, deleteId);
            exchange(drift, "getSessionCwdOperation", 200,
                    get("/v1/agents/sessions/{id}/operations/{op}", id,
                            deleteId).header(TENANT, tenant), null);
        }
        exchange(drift, "deleteSession", 404,
                delete("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-delete-again"),
                null);
        checkStream(drift, "getSessionEvents", "PublicEvent", publicStream);
        checkStream(drift, "webShellStreamEvents", "WebShellEvent",
                webShellStream);
        String workspaceTenant = tenant + "-workspace";
        AuthenticatedTenantActor actor = new AuthenticatedTenantActor() {
            @Override
            public String getName() {
                return actorId();
            }

            @Override
            public String tenantId() {
                return workspaceTenant;
            }

            @Override
            public String actorId() {
                return "contract-actor";
            }
        };
        for (String workspaceId : List.of("ws-a", "ws-default")) {
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                            + " workspace_id, workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref, state)"
                            + " VALUES (?, ?, 1, 'storage', ?, 'config', 'policy',"
                            + " 'ACTIVE')", workspaceTenant, workspaceId,
                    workspaceId);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                            + " workspace_id, actor_id, can_read, can_create)"
                            + " VALUES (?, ?, ?, TRUE, TRUE)", workspaceTenant,
                    workspaceId, actor.actorId().getBytes(StandardCharsets.UTF_8));
        }
        jdbc.update("INSERT INTO managed_workspace_default"
                        + " (tenant_id, workspace_id) VALUES (?, 'ws-default')",
                workspaceTenant);
        exchange(drift, "listWorkspaces", 200,
                get("/v1/agents/workspaces").header(TENANT, workspaceTenant)
                        .principal(actor).param("limit", "1"), null);
        exchange(drift, "getWorkspace", 200,
                get("/v1/agents/workspaces/ws-default")
                        .header(TENANT, workspaceTenant).principal(actor), null);
        exchange(drift, "webShellQueryWorkspaces", 200,
                post(WEB_SHELL + "/workspaces/query")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{\"limit\":1}");
        exchange(drift, "webShellGetWorkspace", 200,
                post(WEB_SHELL + "/workspaces/get")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{\"workspaceId\":\"ws-default\"}");
        String publicBoundId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, workspaceTenant)
                        .principal(actor).header(IDEMPOTENCY_KEY, "bound-public"),
                """
                {"agent_id":"qwen-code","input":[],
                 "workspace":{"workspace_id":"ws-default",
                              "cwd_relative":"services/./api"}}
                """)).get("id").asText();
        JsonNode publicBound = json(exchange(drift, "getSession", 200,
                get("/v1/agents/sessions/{id}", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor), null));
        assertThat(publicBound.at("/workspace/workspace_id").asText())
                .isEqualTo("ws-default");
        assertThat(publicBound.at("/workspace/cwd_relative").asText())
                .isEqualTo("services/api");
        assertThat(publicBound.at("/workspace/context_revision").asLong())
                .isEqualTo(1);
        assertThat(publicBound.at("/workspace/state").asText())
                .isEqualTo("ready");
        String webBoundId = json(exchange(drift, "webShellCreateSession", 202,
                post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, workspaceTenant).principal(actor),
                """
                {"agentId":"qwen-code","idempotencyKey":"bound-web","input":[],
                 "workspace":{"workspaceId":"ws-default",
                              "cwdRelative":"services/./api"}}
                """)).get("sessionId").asText();
        JsonNode webBound = json(exchange(drift, "webShellGetSession", 200,
                post(WEB_SHELL + "/sessions/get")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{\"sessionId\":\"%s\"}".formatted(webBoundId)));
        assertThat(webBound.at("/workspace/workspaceId").asText())
                .isEqualTo("ws-default");
        assertThat(webBound.at("/workspace/cwdRelative").asText())
                .isEqualTo("services/api");
        assertThat(webBound.at("/workspace/contextRevision").asLong())
                .isEqualTo(1);
        assertThat(webBound.at("/workspace/state").asText())
                .isEqualTo("ready");
        exchangeActions(drift, tenant);
        exchangeTasks(drift, tenant, otherTenant);
        String mcpCatalog = exchange(drift, "getSessionMcpCatalog", 200,
                get("/v1/agents/sessions/{id}/mcp-catalog", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor), null);
        assertThat(json(mcpCatalog).path("servers")).isEmpty();
        exchange(drift, "getSessionMcpCatalog", 404,
                get("/v1/agents/sessions/{id}/mcp-catalog", publicBoundId)
                        .header(TENANT, otherTenant), null);
        exchange(drift, "getSessionMcpCatalog", 404,
                get("/v1/agents/sessions/{id}/mcp-catalog", publicBoundId)
                        .header(TENANT, workspaceTenant), null);
        exchange(drift, "getSessionMcpCatalog", 403,
                get("/v1/agents/sessions/{id}/mcp-catalog", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor(otherTenant)), null);
        exchange(drift, "getSessionMcpCatalog", 400,
                get("/v1/agents/sessions/{id}/mcp-catalog", publicBoundId), null);
        String hookCatalog = exchange(drift, "getSessionHookCatalog", 200,
                get("/v1/agents/sessions/{id}/hook-catalog", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor), null);
        assertThat(json(hookCatalog).path("catalogs")).isEmpty();
        exchange(drift, "getSessionHookCatalog", 404,
                get("/v1/agents/sessions/{id}/hook-catalog", publicBoundId)
                        .header(TENANT, otherTenant), null);
        exchange(drift, "getSessionHookCatalog", 404,
                get("/v1/agents/sessions/{id}/hook-catalog", publicBoundId)
                        .header(TENANT, workspaceTenant), null);
        exchange(drift, "getSessionHookCatalog", 403,
                get("/v1/agents/sessions/{id}/hook-catalog", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor(otherTenant)), null);
        exchange(drift, "getSessionHookCatalog", 400,
                get("/v1/agents/sessions/{id}/hook-catalog", publicBoundId), null);
        exchangeTurns(drift, tenant, otherTenant);
        exchangeAgents(drift, tenant, otherTenant);
        assertThat(exercised).containsExactlyInAnyOrderElementsOf(
                CONTRACT.operations().stream()
                        .filter(operation -> !"planned".equals(
                                operation.status()))
                        .map(Operation::operationId).toList());
        assertKnownGaps(drift, "request", "response");
    }

    private void exchangeActions(Map<String, String> drift, String tenant) throws Exception {
        String session = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "actions-contract"),
                "{\"agent_id\":\"qwen-code\",\"input\":[]}")).path("id").asText();
        jdbc.update("INSERT INTO managed_workspace_create_command (tenant_id, actor_id, idempotency_key, request_digest, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                tenant, "actor-a".getBytes(StandardCharsets.UTF_8), "actions-owner", "sha256:fixture", session, System.currentTimeMillis());
        ActionJournal journal = new ActionJournal(sessionStore, tenant, session,
                System.currentTimeMillis(), System.currentTimeMillis() + 600000);
        journal.change("requested", null);
        var actor = actor(tenant);
        String path = "/v1/agents/sessions/" + session + "/actions";
        exchange(drift, "listSessionActions", 200, get(path).header(TENANT, tenant), null);
        exchange(drift, "getSessionAction", 200, get(path + "/" + journal.id).header(TENANT, tenant), null);
        String lookup = "{\"sessionId\":\"%s\",\"actionId\":\"%s\"}".formatted(session, journal.id);
        exchange(drift, "queryWebShellActions", 200, post(WEB_SHELL + "/actions/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\"}".formatted(session));
        exchange(drift, "getWebShellAction", 200, post(WEB_SHELL + "/actions/get").header(TENANT, tenant), lookup);
        String body = "{\"kind\":\"permission\",\"input_revision\":1,\"policy_revision\":\"hosted-tool-approval/1\",\"option_id\":\"allow\"}";
        exchange(drift, "respondToSessionAction", 202, post(path + "/" + journal.id + "/responses")
                .header(TENANT, tenant).principal(actor).header(IDEMPOTENCY_KEY, "contract-answer"), body);
        exchange(drift, "respondWebShellAction", 202, post(WEB_SHELL + "/actions/respond").header(TENANT, tenant).principal(actor),
                "{\"sessionId\":\"%s\",\"actionId\":\"%s\",\"requestId\":\"action-trace\",\"idempotencyKey\":\"contract-answer\",\"response\":{\"kind\":\"permission\",\"inputRevision\":1,\"policyRevision\":\"hosted-tool-approval/1\",\"optionId\":\"allow\"}}".formatted(session, journal.id));
        journal.change("cancelled", null);
    }

    /**
     * Commits a settled and a pending monitor for a new Session through its
     * Session store, then reads them back on both surfaces.
     */
    private void exchangeTasks(Map<String, String> drift, String tenant,
            String otherTenant) throws Exception {
        String sessionId = json(mvc.perform(post("/v1/agents/sessions")
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-tasks")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\"}"))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8)).get("id")
                .asText();
        ExtensionRecordJournal journal = new ExtensionRecordJournal(
                sessionStore, tenant, "workspace-contract", sessionId).open();
        JsonNode chain = ManagedExtensionProjectionContractTest.fixtures()
                .required("monitorChainCases").get(0).required("revisions");
        for (int index = 0; index < chain.size(); index++) {
            journal.commitMonitor("monitor-1:" + index,
                    chain.get(index).required("monitorRun"),
                    chain.get(index).required("occurredAt").longValue());
        }
        journal.commitMonitor("monitor-2:0", ((ObjectNode) chain.get(0)
                .required("monitorRun").deepCopy())
                .put("monitorId", "monitor-2"), 99_000);

        JsonNode page = json(exchange(drift, "listSessionTasks", 200,
                get("/v1/agents/sessions/{id}/tasks", sessionId)
                        .param("limit", "1").header(TENANT, tenant), null));
        assertThat(page.at("/data/0/state").asText()).isEqualTo("pending");
        String taskId = page.at("/data/0/id").asText();
        JsonNode rest = json(exchange(drift, "listSessionTasks", 200,
                get("/v1/agents/sessions/{id}/tasks", sessionId)
                        .param("cursor", page.get("next_cursor").asText())
                        .header(TENANT, tenant), null));
        assertThat(rest.at("/data/0/state").asText()).isEqualTo("cancelled");
        assertThat(rest.get("has_more").asBoolean()).isFalse();
        exchange(drift, "listSessionTasks", 400,
                get("/v1/agents/sessions/{id}/tasks", sessionId)
                        .param("cursor", "bad").header(TENANT, tenant), null);
        exchange(drift, "listSessionTasks", 400,
                get("/v1/agents/sessions/{id}/tasks", sessionId)
                        .param("limit", "0").header(TENANT, tenant), null);
        exchange(drift, "listSessionTasks", 404,
                get("/v1/agents/sessions/{id}/tasks", sessionId)
                        .header(TENANT, otherTenant), null);
        exchange(drift, "listSessionTasks", 403,
                get("/v1/agents/sessions/{id}/tasks", sessionId)
                        .header(TENANT, tenant)
                        .principal(actor(otherTenant)), null);
        exchange(drift, "getSessionTask", 200,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        rest.at("/data/0/id").asText()).header(TENANT, tenant),
                null);
        exchange(drift, "getSessionTask", 404,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        "task_missing").header(TENANT, tenant), null);
        exchange(drift, "getSessionTask", 400,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        taskId), null);
        exchange(drift, "getSessionTask", 403,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        taskId).header(TENANT, tenant)
                        .principal(actor(otherTenant)), null);
        exchange(drift, "queryWebShellTasks", 200,
                post(WEB_SHELL + "/tasks/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"limit\":1}".formatted(sessionId));
        exchange(drift, "queryWebShellTasks", 400,
                post(WEB_SHELL + "/tasks/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"limit\":0}".formatted(sessionId));
        exchange(drift, "queryWebShellTasks", 404,
                post(WEB_SHELL + "/tasks/query").header(TENANT, otherTenant),
                "{\"sessionId\":\"%s\"}".formatted(sessionId));
        exchange(drift, "queryWebShellTasks", 403,
                post(WEB_SHELL + "/tasks/query").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                "{\"sessionId\":\"%s\"}".formatted(sessionId));
        exchange(drift, "getWebShellTask", 200,
                post(WEB_SHELL + "/tasks/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(sessionId, taskId));
        exchange(drift, "getWebShellTask", 404,
                post(WEB_SHELL + "/tasks/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"task_missing\"}"
                        .formatted(sessionId));
        exchange(drift, "getWebShellTask", 400,
                post(WEB_SHELL + "/tasks/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\"}".formatted(sessionId));
        exchange(drift, "getWebShellTask", 403,
                post(WEB_SHELL + "/tasks/get").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(sessionId, taskId));
    }

    /**
     * Pages through the Turns of a new Session: the Turn its creation ran and
     * a failed Turn written after it.
     */
    /**
     * Creates a definition, adds a second revision and reads both, with the
     * idempotency, validation and cross-tenant refusals.
     */
    private void exchangeAgents(Map<String, String> drift, String tenant,
            String otherTenant) throws Exception {
        String body = """
                {"model":{"id":"qwen3-coder-plus"},"instructions":"Review code.",
                 "tools":[{"name":"read_file"}],
                 "permission_policy":{"mode":"default"},
                 "metadata":{"team":"contract"}}
                """;
        JsonNode created = json(exchange(drift, "createAgent", 202,
                post("/v1/agents").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "agent-create"), body));
        String agentId = created.path("id").asText();
        assertThat(created.path("revision").asText()).isEqualTo("1");
        assertThat(created.path("metadata").path("team").asText())
                .isEqualTo("contract");
        exchange(drift, "createAgent", 409, post("/v1/agents")
                .header(TENANT, tenant).header(IDEMPOTENCY_KEY, "agent-create"),
                body.replace("Review code.", "Other."));
        exchange(drift, "createAgent", 400, post("/v1/agents")
                .header(TENANT, tenant).header(IDEMPOTENCY_KEY, "agent create"),
                body);
        String changed = body.replace("Review code.", "Review code carefully.");
        JsonNode updated = json(exchange(drift, "updateAgent", 202,
                post("/v1/agents/{id}", agentId).header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "agent-update"), changed));
        assertThat(updated.path("id").asText()).isEqualTo(agentId);
        assertThat(updated.path("revision").asText()).isEqualTo("2");
        exchange(drift, "updateAgent", 404, post("/v1/agents/{id}", agentId)
                .header(TENANT, otherTenant)
                .header(IDEMPOTENCY_KEY, "agent-update"), changed);
        JsonNode first = json(exchange(drift, "getAgent", 200,
                get("/v1/agents/{id}", agentId).param("revision", "1")
                        .header(TENANT, tenant), null));
        assertThat(first.path("digest").asText())
                .isEqualTo(created.path("digest").asText());
        exchange(drift, "getAgent", 404, get("/v1/agents/{id}", agentId)
                .header(TENANT, otherTenant), null);
    }

    private void exchangeTurns(Map<String, String> drift, String tenant,
            String otherTenant) throws Exception {
        String sessionId = json(mvc.perform(post("/v1/agents/sessions")
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-turns")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"agent_id":"qwen-code",
                                 "input":[{"type":"input_text","text":"turns"}]}
                                """))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8)).get("id")
                .asText();
        awaitIdle(tenant, sessionId);
        TurnRecord first = store.findLatestTurn(tenant, sessionId)
                .orElseThrow();
        // The fixture Harness runs one Turn per Session, so the second Turn
        // is written as a failed dispatch would leave it.
        String second = "turn_" + UUID.randomUUID().toString()
                .replace("-", "");
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, error_code, created_at, updated_at,"
                        + " completed_at) VALUES (?, ?, ?, ?, '[]', 'digest',"
                        + " 'FAILED', 'hosted_harness_unavailable', ?, ?,"
                        + " ?)",
                tenant, sessionId, second, UUID.randomUUID().toString(),
                first.createdAt() + 1_000, first.createdAt() + 2_000,
                first.createdAt() + 2_000);

        JsonNode page = json(exchange(drift, "listTurns", 200,
                get("/v1/agents/sessions/{id}/turns", sessionId)
                        .param("limit", "1").header(TENANT, tenant), null));
        assertThat(page.at("/data/0/id").asText()).isEqualTo(second);
        assertThat(page.at("/data/0/status").asText()).isEqualTo("failed");
        assertThat(page.at("/data/0/error_code").asText())
                .isEqualTo("hosted_harness_unavailable");
        assertThat(page.get("has_more").asBoolean()).isTrue();
        JsonNode rest = json(exchange(drift, "listTurns", 200,
                get("/v1/agents/sessions/{id}/turns", sessionId)
                        .param("cursor", page.get("next_cursor").asText())
                        .header(TENANT, tenant), null));
        assertThat(rest.get("data")).hasSize(1);
        assertThat(rest.at("/data/0/id").asText()).isEqualTo(first.turnId());
        assertThat(rest.at("/data/0/status").asText()).isEqualTo("completed");
        assertThat(rest.at("/data/0/input_item_id").asText())
                .isEqualTo("item_" + first.turnId() + "_input");
        assertThat(rest.get("has_more").asBoolean()).isFalse();
        assertThat(rest.get("next_cursor").isNull()).isTrue();
        assertThat(code(exchange(drift, "listTurns", 400,
                get("/v1/agents/sessions/{id}/turns", sessionId)
                        .param("cursor", "bad").header(TENANT, tenant),
                null))).isEqualTo("invalid_cursor");
        assertThat(code(exchange(drift, "listTurns", 400,
                get("/v1/agents/sessions/{id}/turns", sessionId)
                        .param("limit", "101").header(TENANT, tenant),
                null))).isEqualTo("invalid_limit");
        exchange(drift, "listTurns", 400,
                get("/v1/agents/sessions/{id}/turns", sessionId), null);
        exchange(drift, "listTurns", 403,
                get("/v1/agents/sessions/{id}/turns", sessionId)
                        .header(TENANT, tenant)
                        .principal(actor(otherTenant)), null);
        assertThat(code(exchange(drift, "listTurns", 404,
                get("/v1/agents/sessions/{id}/turns", sessionId)
                        .header(TENANT, otherTenant), null)))
                .isEqualTo("session_not_found");

        assertThat(json(exchange(drift, "getTurn", 200,
                get("/v1/agents/sessions/{id}/turns/{turn}", sessionId,
                        first.turnId()).header(TENANT, tenant), null)))
                .isEqualTo(rest.at("/data/0"));
        assertThat(code(exchange(drift, "getTurn", 404,
                get("/v1/agents/sessions/{id}/turns/{turn}", sessionId,
                        "turn_missing").header(TENANT, tenant), null)))
                .isEqualTo("turn_not_found");
        assertThat(code(exchange(drift, "getTurn", 404,
                get("/v1/agents/sessions/{id}/turns/{turn}", sessionId,
                        second).header(TENANT, otherTenant), null)))
                .isEqualTo("session_not_found");
        assertThat(code(exchange(drift, "getTurn", 400,
                get("/v1/agents/sessions/{id}/turns/{turn}", sessionId,
                        "turn_" + "0".repeat(60)).header(TENANT, tenant),
                null))).isEqualTo("invalid_request");
        exchange(drift, "getTurn", 400,
                get("/v1/agents/sessions/{id}/turns/{turn}", sessionId,
                        second), null);
        exchange(drift, "getTurn", 403,
                get("/v1/agents/sessions/{id}/turns/{turn}", sessionId,
                        second).header(TENANT, tenant)
                        .principal(actor(otherTenant)), null);
    }

    private String code(String content) throws IOException {
        return json(content).at("/error/code").asText();
    }

    @Test
    void bothSurfacesReportTheSameSession() throws Exception {
        String tenant = "tenant-parity-" + UUID.randomUUID();
        String sessionId = json(mvc.perform(post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"parity-create",
                                 "agentId":"qwen-code",
                                 "input":[{"type":"input_text","text":"hi"}]}
                                """))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8))
                .get("sessionId").asText();
        awaitMaterialized(tenant, sessionId);
        awaitIdle(tenant, sessionId);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            JsonNode transcript = json(webShell(tenant, "/transcript/query",
                    "{\"sessionId\":\"%s\"}".formatted(sessionId)));
            assertThat(transcript.get("coveredSequence").asLong())
                    .isEqualTo(transcript.get("lastSequence").asLong());
        });

        JsonNode publicSession = json(mvc.perform(
                        get("/v1/agents/sessions/{id}", sessionId)
                                .header(TENANT, tenant))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8));
        JsonNode publicListed = json(mvc.perform(get("/v1/agents/sessions")
                        .header(TENANT, tenant))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8))
                .get("data").get(0);
        JsonNode webShellSession = json(webShell(tenant, "/sessions/get",
                "{\"sessionId\":\"%s\"}".formatted(sessionId)));
        JsonNode webShellListed = json(webShell(tenant, "/sessions/query",
                "{}")).get("data").get(0);
        JsonNode items = json(mvc.perform(
                        get("/v1/agents/sessions/{id}/items", sessionId)
                                .param("limit", "100").header(TENANT, tenant))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8));
        long snapshotThrough = items.get("snapshot_through_sequence").asLong();
        // Events name the Items and Parts that the Snapshot holds.
        Map<String, Set<String>> parts = new TreeMap<>();
        items.get("data").forEach(item -> {
            Set<String> ids = parts.computeIfAbsent(item.get("id").asText(),
                    ignored -> new TreeSet<>());
            item.get("content").forEach(part ->
                    ids.add(part.get("part_id").asText()));
        });
        JsonNode events = json(mvc.perform(
                        get("/v1/agents/sessions/{id}/events", sessionId)
                                .param("limit", "1000").header(TENANT, tenant)
                                .accept(MediaType.APPLICATION_JSON))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8)).get("data");
        List<String> named = new ArrayList<>();
        events.forEach(event -> {
            if (event.hasNonNull("content_part_id")) {
                named.add(event.get("content_part_id").asText());
                assertThat(parts.get(event.get("item_id").asText()))
                        .as("parts of %s", event.get("item_id"))
                        .contains(event.get("content_part_id").asText());
            } else if (event.hasNonNull("item_id")) {
                assertThat(parts).containsKey(event.get("item_id").asText());
            }
        });
        assertThat(named).isNotEmpty();
        for (JsonNode session : List.of(publicSession, publicListed)) {
            assertThat(session.get("id").asText()).isEqualTo(sessionId);
            assertThat(session.get("agent_revision").asText()).isEqualTo("1");
            assertThat(session.get("capabilities")).isEqualTo(json("""
                    {"items":true,"snapshots":true,"artifacts":false,
                     "resync":true,"session_lifecycle":true,"tasks":true,"actions":false,"session_close":true,
                     "session_archive":true,"session_unarchive":true,"session_delete":true}
                    """));
            assertThat(session.get("replay_floor_sequence").asLong()).isZero();
            assertThat(session.get("snapshot_through_sequence").asLong())
                    .isPositive().isEqualTo(snapshotThrough);
            for (JsonNode other : List.of(webShellSession, webShellListed)) {
                assertThat(other.get("sessionId").asText())
                        .isEqualTo(sessionId);
                assertThat(other.get("agentId").asText())
                        .isEqualTo(session.get("agent_id").asText());
                assertThat(other.get("status").asText())
                        .isEqualTo(session.get("status").asText());
                assertThat(other.get("lastSequence").asLong())
                        .isPositive()
                        .isEqualTo(session.get("last_event_id").asLong());
                assertThat(other.get("capabilities"))
                        .isEqualTo(json("""
                                {"tasks":true,"artifacts":false,"actions":false,"workspaceTurns":false,"sessionClose":true,
                                 "sessionArchive":true,"sessionUnarchive":true,"sessionDelete":true}
                                """));
            }
        }

        String otherTenant = tenant + "-other";
        for (MockHttpServletRequestBuilder foreign : List.of(
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, otherTenant),
                post(WEB_SHELL + "/sessions/get").header(TENANT, otherTenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"%s\"}"
                                .formatted(sessionId)))) {
            MockHttpServletResponse response = mvc.perform(foreign)
                    .andReturn().getResponse();
            assertThat(response.getStatus()).isEqualTo(404);
            assertThat(json(response.getContentAsString(
                            StandardCharsets.UTF_8))
                    .at("/error/code").asText())
                    .isEqualTo("session_not_found");
        }
    }

    @Test
    void requestIdsAreEchoedOnlyWhenSafe() throws Exception {
        String tenant = "tenant-request-id-" + UUID.randomUUID();
        MockHttpServletResponse traced = mvc.perform(get("/v1/agents/sessions")
                        .header(TENANT, tenant)
                        .header(RequestIdFilter.HEADER, "gateway-trace-1"))
                .andReturn().getResponse();
        assertThat(traced.getHeader(RequestIdFilter.HEADER))
                .isEqualTo("gateway-trace-1");

        for (String unsafe : List.of("two words", "x".repeat(129))) {
            MockHttpServletResponse replaced = mvc.perform(
                            get("/v1/agents/sessions")
                                    .header(TENANT, tenant)
                                    .header(RequestIdFilter.HEADER, unsafe))
                    .andReturn().getResponse();
            assertThat(UUID.fromString(
                    replaced.getHeader(RequestIdFilter.HEADER))).isNotNull();
        }

        MockHttpServletResponse ignored = mvc.perform(
                        post(WEB_SHELL + "/sessions/create")
                                .header(TENANT, tenant)
                                .header(RequestIdFilter.HEADER,
                                        "gateway-trace-2")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("""
                                        {"requestId":"line\\nbreak",
                                         "idempotencyKey":"request-id",
                                         "agentId":"qwen-code","input":[]}
                                        """))
                .andReturn().getResponse();
        assertThat(ignored.getStatus()).isEqualTo(202);
        assertThat(ignored.getHeader(RequestIdFilter.HEADER))
                .isEqualTo("gateway-trace-2");

        assertThat(mvc.perform(post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"requestId":"%s","idempotencyKey":"too-long",
                                 "agentId":"qwen-code","input":[]}
                                """.formatted("x".repeat(129))))
                .andReturn().getResponse().getStatus()).isEqualTo(400);
    }

    private static AuthenticatedTenantActor actor(String tenant) {
        return new AuthenticatedTenantActor() {
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

    private String webShell(String tenant, String path, String body)
            throws Exception {
        return mvc.perform(post(WEB_SHELL + path).header(TENANT, tenant)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8);
    }

    private String exchange(Map<String, String> drift, String operationId,
            int expectedStatus, MockHttpServletRequestBuilder request,
            String body) throws Exception {
        Operation operation = CONTRACT.operation(operationId);
        exercised.add(operationId);
        assertThat(CONTRACT.responsePointer(operation, expectedStatus))
                .as("%s declares %d", operationId, expectedStatus)
                .isNotNull();
        if (body != null) {
            request.contentType(MediaType.APPLICATION_JSON).content(body);
            // Error probes send invalid bodies on purpose.
            if (expectedStatus < 300) {
                collect(drift, "request " + operationId, CONTRACT.validate(
                        CONTRACT.requestPointer(operation),
                        objectMapper.readTree(body)));
            }
        }
        MockHttpServletResponse response = mvc.perform(request).andReturn()
                .getResponse();
        String content = response.getContentAsString(StandardCharsets.UTF_8);
        int status = response.getStatus();
        if (status != expectedStatus) {
            drift.put("response %s: expected %d, got %d%s".formatted(
                    operationId, expectedStatus, status, errorCode(content)),
                    content);
        }
        if (status == 403 && expectedStatus == 403) {
            String code = content.isEmpty() ? ""
                    : json(content).path("error").path("code").asText();
            if (!"actor_scope_mismatch".equals(code)) {
                drift.put("code %s: expected actor_scope_mismatch, got %s"
                        .formatted(operationId, code), content);
            }
        }
        String label = "response " + operationId + " " + status;
        checkRequestId(drift, label, body, content, response);
        String declared = CONTRACT.responsePointer(operation, status);
        if (declared == null) {
            return content;
        }
        String schema = declared + "/content/application~1json/schema";
        if (!CONTRACT.node(schema).isMissingNode()) {
            if (content.isEmpty()) {
                drift.put(label + ": empty response body", "");
            } else {
                collect(drift, label, CONTRACT.validate(schema,
                        objectMapper.readTree(content)));
            }
        }
        CONTRACT.node(declared).path("headers").fieldNames()
                .forEachRemaining(header -> {
                    if (response.getHeader(header) == null) {
                        drift.put(label + ": missing header " + header, "");
                    }
                });
        return content;
    }

    private void checkRequestId(Map<String, String> drift, String label,
            String body, String content, MockHttpServletResponse response)
            throws IOException {
        String requestId = response.getHeader(RequestIdFilter.HEADER);
        if (requestId == null) {
            drift.put(label + ": no " + RequestIdFilter.HEADER, "");
            return;
        }
        JsonNode sent = body == null ? null
                : objectMapper.readTree(body).get("requestId");
        if (sent != null && sent.isTextual()
                && !sent.asText().equals(requestId)) {
            drift.put(label + ": " + RequestIdFilter.HEADER
                    + " does not echo requestId", requestId);
        }
        JsonNode error = content.isEmpty() ? null
                : objectMapper.readTree(content).path("error");
        if (error != null && error.isObject()
                && !requestId.equals(error.path("request_id").asText())) {
            drift.put(label + ": request_id is not " + RequestIdFilter.HEADER,
                    content);
        }
    }

    private MockHttpServletResponse stream(Map<String, String> drift,
            String operationId, MockHttpServletRequestBuilder request,
            String body) throws Exception {
        if (body != null) {
            request.contentType(MediaType.APPLICATION_JSON).content(body);
            collect(drift, "request " + operationId, CONTRACT.validate(
                    CONTRACT.requestPointer(CONTRACT.operation(operationId)),
                    objectMapper.readTree(body)));
        }
        return mvc.perform(request.accept(MediaType.TEXT_EVENT_STREAM))
                .andReturn().getResponse();
    }

    private void checkStream(Map<String, String> drift, String operationId,
            String eventSchema, MockHttpServletResponse response)
            throws Exception {
        await().atMost(Duration.ofSeconds(5)).until(() -> response
                .getContentAsString(StandardCharsets.UTF_8)
                .contains("event:session.deleted"));
        assertThat(checkFrames(drift, operationId, eventSchema, response))
                .as("%s frames", operationId).isGreaterThan(3);
    }

    // An expired cursor gets one resync frame, after which the stream ends.
    private void checkResync(Map<String, String> drift, String operationId,
            String eventSchema, MockHttpServletResponse response)
            throws Exception {
        await().atMost(Duration.ofSeconds(5)).until(() -> response
                .getContentAsString(StandardCharsets.UTF_8)
                .contains("event:" + RESYNC));
        assertThat(checkFrames(drift, operationId, eventSchema, response))
                .as("%s frames", operationId).isEqualTo(1);
    }

    private int checkFrames(Map<String, String> drift, String operationId,
            String eventSchema, MockHttpServletResponse response)
            throws Exception {
        assertThat(response.getContentType())
                .startsWith(MediaType.TEXT_EVENT_STREAM_VALUE);
        exercised.add(operationId);
        String label = "response " + operationId + " 200 text/event-stream";
        if (response.getHeader(RequestIdFilter.HEADER) == null) {
            drift.put(label + ": no " + RequestIdFilter.HEADER, "");
        }
        String media = CONTRACT.responsePointer(CONTRACT.operation(
                operationId), 200) + "/content/text~1event-stream";
        String[] frames = response.getContentAsString(StandardCharsets.UTF_8)
                .split("\n\n");
        int events = 0;
        for (String frame : frames) {
            Map<String, String> fields = new TreeMap<>();
            for (String line : frame.split("\n")) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    fields.merge(line.substring(0, colon),
                            line.substring(colon + 1), (a, b) -> a + "\n" + b);
                }
            }
            if (!fields.containsKey("data")) {
                continue;
            }
            events++;
            JsonNode event = objectMapper.readTree(fields.get("data"));
            if (RESYNC.equals(fields.get("event"))) {
                if (fields.containsKey("id")) {
                    drift.put(label + ": resync frame has an id", frame);
                }
                collect(drift, label, CONTRACT.validate(
                        media + "/x-qwen-resync-frame", event));
                continue;
            }
            if (!event.path("sequence").asText().equals(fields.get("id"))) {
                drift.put(label + ": id is not the event sequence", frame);
            }
            if (!event.path("type").asText().equals(fields.get("event"))) {
                drift.put(label + ": event is not the event type", frame);
            }
            collect(drift, label, CONTRACT.validate(
                    "/components/schemas/" + eventSchema, event));
        }
        return events;
    }

    // Raises the floor of a fresh Session to its Snapshot and reads below it.
    private void checkReplayFloor(Map<String, String> drift, String tenant)
            throws Exception {
        String sessionId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-floor"),
                """
                {"agent_id":"qwen-code",
                 "input":[{"type":"input_text","text":"hello"}]}
                """)).get("id").asText();
        awaitMaterialized(tenant, sessionId);
        long floor = store.advanceReplayFloor(tenant, sessionId,
                Long.MAX_VALUE).floorSequence();
        assertThat(floor).isPositive();
        JsonNode expired = json(exchange(drift, "getSessionEvents", 409,
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("after", Long.toString(floor - 1))
                        .header(TENANT, tenant)
                        .accept(MediaType.APPLICATION_JSON), null));
        assertThat(expired.at("/error/code").asText())
                .isEqualTo("cursor_expired");
        assertThat(expired.at("/error/replay_floor_sequence").asLong())
                .isEqualTo(floor);
        assertThat(expired.at("/error/snapshot_through_sequence").asLong())
                .isEqualTo(floor);
        exchange(drift, "getSessionEvents", 200,
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("after", Long.toString(floor))
                        .header(TENANT, tenant)
                        .accept(MediaType.APPLICATION_JSON), null);
        checkResync(drift, "getSessionEvents", "PublicEvent", stream(drift,
                "getSessionEvents",
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("stream", "true").header(TENANT, tenant),
                null));
        checkResync(drift, "webShellStreamEvents", "WebShellEvent",
                stream(drift, "webShellStreamEvents",
                        post(WEB_SHELL + "/events/stream")
                                .header(TENANT, tenant),
                        "{\"sessionId\":\"%s\",\"afterSequence\":0}"
                                .formatted(sessionId)));
    }

    private void awaitOperation(String tenant, String sessionId,
            String operationId) {
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(json(mvc.perform(get(
                                "/v1/agents/sessions/{id}/operations/{op}",
                                sessionId, operationId).header(TENANT, tenant))
                        .andReturn().getResponse()
                        .getContentAsString(StandardCharsets.UTF_8))
                        .get("status").asText()).isEqualTo("completed"));
    }

    private int awaitHeldTurn() {
        await().atMost(Duration.ofSeconds(5)).until(harness::hasHeldTurn);
        return harness.cancelCount();
    }

    private void settleCancelledTurn(String tenant, String sessionId,
            int cancels) {
        await().atMost(Duration.ofSeconds(5))
                .until(() -> harness.cancelCount() > cancels);
        harness.releaseHeldTurns();
        awaitIdle(tenant, sessionId);
    }

    private void awaitMaterialized(String tenant, String sessionId) {
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            JsonNode items = json(mvc.perform(
                            get("/v1/agents/sessions/{id}/items", sessionId)
                                    .header(TENANT, tenant))
                    .andReturn().getResponse()
                    .getContentAsString(StandardCharsets.UTF_8));
            assertThat(items.get("data")).hasSizeGreaterThanOrEqualTo(2);
        });
    }

    private void awaitIdle(String tenant, String sessionId) {
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            JsonNode session = json(mvc.perform(
                            get("/v1/agents/sessions/{id}", sessionId)
                                    .header(TENANT, tenant))
                    .andReturn().getResponse()
                    .getContentAsString(StandardCharsets.UTF_8));
            assertThat(session.has("active_turn")).isFalse();
        });
    }

    private Set<String> jsonProperties(Class<?> type) {
        return objectMapper.getSerializationConfig()
                .introspect(objectMapper.constructType(type))
                .findProperties().stream()
                .map(BeanPropertyDefinition::getName)
                .collect(Collectors.toCollection(TreeSet::new));
    }

    private JsonNode json(String content) throws IOException {
        return objectMapper.readTree(content);
    }

    private String errorCode(String content) {
        try {
            String code = objectMapper.readTree(content).path("error")
                    .path("code").asText();
            return code.isEmpty() ? "" : " " + code;
        } catch (IOException error) {
            return "";
        }
    }

    private static void collect(Map<String, String> drift, String label,
            Set<ValidationMessage> messages) {
        for (ValidationMessage message : messages) {
            String location = message.getInstanceLocation().toString()
                    .replaceAll("/\\d+(?=/|$)", "/*");
            if (location.isEmpty()) {
                location = "/";
            }
            String property = message.getProperty() == null ? ""
                    : " " + message.getProperty();
            drift.put(label + ": " + location + " " + message.getType()
                    + property, message.getMessage());
        }
    }

    private static void assertKnownGaps(Map<String, String> drift,
            String... categories) {
        Set<String> known = knownGaps().stream()
                .filter(gap -> Arrays.stream(categories)
                        .anyMatch(category -> gap.startsWith(category + " ")))
                .collect(Collectors.toCollection(TreeSet::new));
        List<String> added = drift.entrySet().stream()
                .filter(entry -> !known.contains(entry.getKey()))
                .map(entry -> "  + " + entry.getKey()
                        + (entry.getValue().isEmpty() ? ""
                                : "\n      " + entry.getValue()))
                .toList();
        List<String> resolved = known.stream()
                .filter(gap -> !drift.containsKey(gap))
                .map(gap -> "  - " + gap).toList();
        if (added.isEmpty() && resolved.isEmpty()) {
            return;
        }
        fail("""
                The Managed Agent API drifted from %s.
                Fix new drift. Actor-scope code drift is not deferrable.
                Record eligible gaps in %s only if a later slice closes them.
                %s
                Remove resolved gaps from %s:
                %s""".formatted(OpenApiContract.RESOURCE, KNOWN_GAPS,
                String.join("\n", added), KNOWN_GAPS,
                String.join("\n", resolved)));
    }

    private static List<String> knownGaps() {
        assertThat(GAP_CATEGORIES)
                .as("actor-scope code drift must stay unwaivable")
                .doesNotContain("code");
        try (InputStream input = ManagedAgentApiContractTest.class
                .getClassLoader().getResourceAsStream(KNOWN_GAPS)) {
            List<String> gaps = new String(input.readAllBytes(),
                    StandardCharsets.UTF_8).lines().map(String::strip)
                    .filter(line -> !line.isEmpty() && !line.startsWith("#"))
                    .toList();
            assertThat(gaps).as("lines of %s", KNOWN_GAPS).allMatch(
                    gap -> GAP_CATEGORIES.stream().anyMatch(
                            category -> gap.startsWith(category + " ")),
                    "start with one of " + GAP_CATEGORIES);
            Set<String> implemented = CONTRACT.operations().stream()
                    .filter(operation -> "implemented".equals(
                            operation.status()))
                    .map(Operation::operationId)
                    .collect(Collectors.toSet());
            assertThat(gaps).as("lines of %s", KNOWN_GAPS).noneMatch(
                    gap -> (gap.startsWith("request ")
                            || gap.startsWith("response "))
                            && implemented.contains(gap.split("[ :]")[1]));
            return gaps;
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}
