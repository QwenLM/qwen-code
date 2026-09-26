package com.alibaba.qwen.code.managedagent;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.OpenApiContract.Operation;
import com.alibaba.qwen.code.managedagent.api.ApiModels;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CreateSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicWorkspace;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionEventRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.UpdateSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCancelRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCreateRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellListRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellStreamRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSubmitRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscriptRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellWorkspace;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
import com.networknt.schema.ValidationMessage;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
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
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
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
@AutoConfigureMockMvc
@Import(ManagedAgentServerIntegrationTest.FixtureConfiguration.class)
class ManagedAgentApiContractTest {
    private static final String KNOWN_GAPS = "openapi/contract-known-gaps.txt";
    private static final List<String> API_PREFIXES = List.of("/v1/agents",
            "/api/agent/web-shell/v1");
    private static final String WEB_SHELL = "/api/agent/web-shell/v1";
    private static final String TENANT = TenantContextFilter.HEADER;
    private static final String IDEMPOTENCY_KEY = "Idempotency-Key";
    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final Map<Class<?>, List<String>> RECORD_SCHEMAS =
            Map.ofEntries(
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
                    entry(PublicList.class,
                            List.of("PublicSessionList", "PublicEventList")),
                    entry(PublicEvent.class, List.of("PublicEvent")),
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
                    entry(WebShellTurn.class, List.of("WebShellTurn")),
                    entry(WebShellSession.class, List.of("WebShellSession")),
                    entry(WebShellPage.class,
                            List.of("WebShellSessionPage")),
                    entry(WebShellEvent.class, List.of("WebShellEvent")),
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
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

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
    void partialRoutesAnswerWithTheirSchemas() throws Exception {
        Map<String, String> drift = new TreeMap<>();
        String tenant = "tenant-contract-" + UUID.randomUUID();
        String otherTenant = tenant + "-other";

        String sessionId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-create"),
                """
                {"agent_id":"qwen-code","metadata":{"title":"contract"},
                 "input":[{"type":"text","text":"hello"}]}
                """)).get("id").asText();
        MockHttpServletResponse publicStream = stream(drift,
                "getSessionEvents",
                get("/v1/agents/sessions/{id}/events", sessionId)
                        .param("stream", "true").header(TENANT, tenant),
                null);
        exchange(drift, "createSession", 409,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-create"),
                "{\"agent_id\":\"qwen-code\"}");
        exchange(drift, "listSessions", 200, get("/v1/agents/sessions")
                .param("limit", "100").header(TENANT, tenant), null);
        exchange(drift, "getSession", 404,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, otherTenant), null);
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
        exchange(drift, "listItems", 200,
                get("/v1/agents/sessions/{id}/items", sessionId)
                        .param("limit", "100").header(TENANT, tenant), null);
        exchange(drift, "updateSession", 200,
                patch("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-rename"),
                "{\"title\":\"renamed\"}");
        exchange(drift, "archiveSession", 202,
                post("/v1/agents/sessions/{id}/archive", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-archive"), null);
        exchange(drift, "getSession", 200,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant), null);
        exchange(drift, "listSessions", 200, get("/v1/agents/sessions")
                .param("limit", "100").header(TENANT, tenant), null);
        exchange(drift, "unarchiveSession", 200,
                post("/v1/agents/sessions/{id}/unarchive", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-unarchive"), null);

        String cancelledId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-create-idle"),
                "{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .get("id").asText();
        String turnId = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", cancelledId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-input"),
                """
                {"type":"agent.session.input.message",
                 "input":[{"type":"text","text":"hold"}]}
                """)).get("turn_id").asText();
        int cancels = awaitHeldTurn();
        exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", cancelledId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-cancel"),
                """
                {"type":"agent.session.cancel","turn_id":"%s"}
                """.formatted(turnId));
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
        exchange(drift, "webShellGetSession", 404,
                post(WEB_SHELL + "/sessions/get").header(TENANT, otherTenant),
                "{\"sessionId\":\"%s\"}".formatted(webSessionId));
        String webTurnId = json(exchange(drift, "webShellSubmitTurn", 202,
                post(WEB_SHELL + "/turns/submit").header(TENANT, tenant),
                """
                {"requestId":"contract-trace","idempotencyKey":"contract-submit",
                 "sessionId":"%s","metadata":{"clientId":"contract"},
                 "input":[{"type":"text","text":"hold"}]}
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
                 "agentId":"qwen-code","input":[{"type":"text","text":"hello"}]}
                """)).get("sessionId").asText();
        awaitMaterialized(tenant, webInputId);

        for (String id : List.of(sessionId, cancelledId, webSessionId,
                webInputId)) {
            exchange(drift, "deleteSession", 202,
                    delete("/v1/agents/sessions/{id}", id)
                            .header(TENANT, tenant)
                            .header(IDEMPOTENCY_KEY, "contract-delete-" + id),
                    null);
        }
        checkStream(drift, "getSessionEvents", "PublicEvent", publicStream);
        checkStream(drift, "webShellStreamEvents", "WebShellEvent",
                webShellStream);
        assertThat(exercised).containsExactlyInAnyOrderElementsOf(
                CONTRACT.operations().stream()
                        .filter(operation -> !"planned".equals(
                                operation.status()))
                        .map(Operation::operationId).toList());
        assertKnownGaps(drift, "request", "response");
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
            collect(drift, "request " + operationId, CONTRACT.validate(
                    CONTRACT.requestPointer(operation),
                    objectMapper.readTree(body)));
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
        String declared = CONTRACT.responsePointer(operation, status);
        if (declared == null) {
            return content;
        }
        String label = "response " + operationId + " " + status;
        String schema = declared + "/content/application~1json/schema";
        if (!CONTRACT.node(schema).isMissingNode()) {
            collect(drift, label, CONTRACT.validate(schema,
                    objectMapper.readTree(content)));
        }
        CONTRACT.node(declared).path("headers").fieldNames()
                .forEachRemaining(header -> {
                    if (response.getHeader(header) == null) {
                        drift.put(label + ": missing header " + header, "");
                    }
                });
        return content;
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
        assertThat(response.getContentType())
                .startsWith(MediaType.TEXT_EVENT_STREAM_VALUE);
        exercised.add(operationId);
        String label = "response " + operationId + " 200 text/event-stream";
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
            if (!event.path("sequence").asText().equals(fields.get("id"))) {
                drift.put(label + ": id is not the event sequence", frame);
            }
            if (!event.path("type").asText().equals(fields.get("event"))) {
                drift.put(label + ": event is not the event type", frame);
            }
            collect(drift, label, CONTRACT.validate(
                    "/components/schemas/" + eventSchema, event));
        }
        assertThat(events).as("%s frames", operationId).isGreaterThan(3);
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
                Fix new drift. Record a line in %s only for a gap that a \
                later slice closes.
                %s
                Remove resolved gaps from %s:
                %s""".formatted(OpenApiContract.RESOURCE, KNOWN_GAPS,
                String.join("\n", added), KNOWN_GAPS,
                String.join("\n", resolved)));
    }

    private static List<String> knownGaps() {
        try (InputStream input = ManagedAgentApiContractTest.class
                .getClassLoader().getResourceAsStream(KNOWN_GAPS)) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8)
                    .lines().map(String::strip)
                    .filter(line -> !line.isEmpty() && !line.startsWith("#"))
                    .toList();
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}
