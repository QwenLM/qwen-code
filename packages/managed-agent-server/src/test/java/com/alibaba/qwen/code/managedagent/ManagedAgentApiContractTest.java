package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.OpenApiContract.Operation;
import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.RequestIdFilter;
import com.alibaba.qwen.code.managedagent.api.SshWorkspaceController;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceDiscoveryController;
import com.alibaba.qwen.code.managedagent.model.ApiModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.ChangeCwdRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CreateSessionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicContentPart;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicCwdOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicItem;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicTask;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicTaskEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicWorkspace;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionCapabilities;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionEventRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionResyncRequired;
import com.alibaba.qwen.code.managedagent.model.ApiModels.UpdateSessionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCancelRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellChangeCwdRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellContentPart;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCreateRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCwdOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellItem;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellListRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellOperationRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellResyncRequired;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionCapabilities;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellStreamRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSubmitRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTask;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskEvent;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskEventQueryRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskGetRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTaskQueryRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTranscriptRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTurn;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellWorkspace;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.ManagedTaskEventStore;
import com.alibaba.qwen.code.managedagent.persistence.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.session.SessionRenameCoordinator;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.ValidationMessage;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Collectors;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-agent-contract;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.automation.enabled=true",
        "qwen.managed-agent.session-store.enabled=true",
        "qwen.managed-agent.dispatch.scan-delay=50ms",
        "qwen.managed-agent.events.poll-interval=10ms",
        "qwen.managed-agent.events.materialize-interval=10ms"
})
// SSE responses are still being written when MockMvc runs its result printer.
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(ManagedAgentServerIntegrationTest.FixtureConfiguration.class)
// Keep background recovery from claiming the synchronous schema-check rename.
@MockitoBean(types = SessionRenameCoordinator.class)
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
                    entry(ApiModels.WebShellToolDetails.class, List.of("WebShellToolDetails")),
                    entry(ApiModels.WebShellShellResult.class, List.of("WebShellShellResult")),
                    entry(ApiModels.WebShellArtifactQueryRequest.class, List.of("WebShellArtifactQueryRequest")),
                    entry(ApiModels.WebShellArtifactRequest.class, List.of("WebShellArtifactRequest")),
                    entry(ApiModels.WebShellToolResultRequest.class, List.of("WebShellToolResultRequest")),
                    entry(SshWorkspaceController.DirectoryRequest.class, List.of("WebShellWorkspaceDirectoryRequest")),
                    entry(WorkspaceDiscoveryController.DirectoryRequest.class, List.of("WebShellWorkspaceDirectoryQueryRequest")),
                    entry(SshWorkspaceController.CreateRequest.class, List.of("WebShellWorkspaceRegisterRequest")),
                    entry(SshWorkspaceController.OperationRequest.class, List.of("WebShellWorkspaceOperationRequest")),
                    entry(SshWorkspaceService.NodeSummary.class, List.of("WebShellRuntimeNode")),
                    entry(SshWorkspaceService.NodePage.class, List.of("WebShellRuntimeNodePage")),
                    entry(SshWorkspaceService.Directory.class, List.of("WebShellWorkspaceDirectory")),
                    entry(SshWorkspaceStore.Operation.class, List.of("WebShellWorkspaceCreateOperation")),
                    entry(InputBlock.class, List.of("InputBlock")),
                    entry(CreateSessionRequest.class,
                            List.of("CreateSessionRequest")),
                    entry(SessionEventRequest.class,
                            List.of("SessionEventRequest")),
                    entry(UpdateSessionRequest.class,
                            List.of("UpdateSessionRequest")),
                    entry(ChangeCwdRequest.class, List.of("ChangeCwdRequest")),
                    entry(PublicCwdOperation.class,
                            List.of("PublicCwdOperation")),
                    entry(WebShellChangeCwdRequest.class,
                            List.of("WebShellChangeCwdRequest")),
                    entry(WebShellCwdOperation.class,
                            List.of("WebShellCwdOperation")),
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
                            "PublicTaskEventList", "PublicTurnList",
                            "PublicArtifactList", "PublicAutomationList",
                            "PublicAutomationRunList", "PublicChannelList",
                            "PublicChannelDeliveryList")),
                    entry(ApiModels.AutomationDefinitionRequest.class,
                            List.of("AutomationDefinitionRequest")),
                    entry(ApiModels.PublicAutomation.class,
                            List.of("PublicAutomation")),
                    entry(ApiModels.PublicAutomationRun.class,
                            List.of("PublicAutomationRun")),
                    entry(ApiModels.PublicChannel.class,
                            List.of("PublicChannel")),
                    entry(ApiModels.PublicChannelRoute.class,
                            List.of("PublicChannelRoute")),
                    entry(ApiModels.PublicChannelDelivery.class,
                            List.of("PublicChannelDelivery")),
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
                    entry(ApiModels.WebShellSessionOptionsRequest.class,
                            List.of("WebShellSessionOptionsRequest")),
                    entry(ApiModels.WebShellSessionOptions.class,
                            List.of("WebShellSessionOptions")),
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
                    entry(ApiModels.WebShellModelContext.class,
                            List.of("WebShellModelContext")),
                    entry(ApiModels.WebShellModelOption.class, List.of("WebShellModelOption")),
                    entry(ApiModels.WebShellModelSelection.class, List.of("WebShellModelSelection")),
                    entry(ApiModels.WebShellSessionApprovalRequest.class, List.of("WebShellSessionApprovalRequest")),
                    entry(ApiModels.WebShellSessionApproval.class, List.of("WebShellSessionApproval")),
                    entry(ApiModels.WebShellChangeApprovalRequest.class, List.of("WebShellChangeApprovalRequest")),
                    entry(ApiModels.WebShellApprovalChangeResult.class, List.of("WebShellApprovalChangeResult")),
                    entry(ApiModels.WebShellApprovalSelection.class, List.of("WebShellApprovalSelection")),
                    entry(ApiModels.WebShellSessionModelsRequest.class, List.of("WebShellSessionModelsRequest")),
                    entry(ApiModels.WebShellSessionModels.class, List.of("WebShellSessionModels")),
                    entry(ApiModels.WebShellSkill.class, List.of("WebShellSkill")),
                    entry(ApiModels.WebShellSessionSkills.class, List.of("WebShellSessionSkills")),
                    entry(ApiModels.WebShellChangeModelRequest.class, List.of("WebShellChangeModelRequest")),
                    entry(ApiModels.WebShellModelChangeResult.class, List.of("WebShellModelChangeResult")),
                    entry(WebShellSessionCapabilities.class,
                            List.of("WebShellSessionCapabilities")),
                    entry(WebShellPage.class, List.of("WebShellSessionPage",
                            "WebShellTaskPage", "WebShellTaskEventPage",
                            "WebShellActionPage", "WebShellArtifactPage")),
                    entry(PublicTask.class, List.of("PublicTask")),
                    entry(WebShellTask.class, List.of("WebShellTask")),
                    entry(PublicTaskEvent.class, List.of("PublicTaskEvent")),
                    entry(WebShellTaskEvent.class,
                            List.of("WebShellTaskEvent")),
                    entry(WebShellTaskQueryRequest.class,
                            List.of("WebShellTaskQueryRequest")),
                    entry(WebShellTaskGetRequest.class,
                            List.of("WebShellTaskGetRequest")),
                    entry(WebShellTaskEventQueryRequest.class,
                            List.of("WebShellTaskEventQueryRequest")),
                    entry(ApiModels.WebShellTaskCancelRequest.class,
                            List.of("WebShellTaskCancelRequest")),
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
    private ManagedTaskEventStore taskEvents;

    @Autowired
    private SshWorkspaceStore sshWorkspaces;

    // D7-3: present only where the deployment enables the java_durable
    // admission profile (JavaDurableAdmissionContractTest).
    @Autowired(required = false)
    private com.alibaba.qwen.code.managedagent.session.JavaDurableAdmission
            javaDurableAdmission;

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

    private void exchangeApprovalOptions(Map<String, String> drift, String tenant) throws Exception {
        String request = "{\"agentId\":\"qwen-code\"}";
        exchange(drift, "queryWebShellSessionOptions", 401,
                post(WEB_SHELL + "/session-options/query").header(TENANT, tenant), request);
        String response = exchange(drift, "queryWebShellSessionOptions", 200,
                post(WEB_SHELL + "/session-options/query").header(TENANT, tenant).principal(actor(tenant)),
                request);
        assertThat(json(response).path("approvalMode").asText()).isEqualTo("yolo");
        assertThat(json(response).path("availableApprovalModes").size()).isEqualTo(3);
        exchange(drift, "queryWebShellSessionOptions", 400,
                post(WEB_SHELL + "/session-options/query").header(TENANT, tenant).principal(actor(tenant)), "{}");
        exchange(drift, "queryWebShellSessionOptions", 403,
                post(WEB_SHELL + "/session-options/query").header(TENANT, tenant).principal(actor("other")), request);
        exchange(drift, "queryWebShellSessionOptions", 404,
                post(WEB_SHELL + "/session-options/query").header(TENANT, tenant).principal(actor(tenant)),
                "{\"agentId\":\"unknown\"}");
    }

    @Test
    void migrationRefusalsDeclareTheActualErrorCodeAndRetryability() throws Exception {
        String tenant = "contract-migration-" + UUID.randomUUID();
        var actor = actor(tenant);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, display_name,"
                + " workspace_generation, storage_id, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace', 'Workspace', 1, 'storage', 'config', 'policy', 'ACTIVE')", tenant);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, actor.actorId().getBytes(StandardCharsets.UTF_8));
        new JdbcRuntimeBindingRepository(jdbc.getDataSource(),
                new com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector("fixture", new byte[32]))
                .requestStorageFence(tenant, "storage", UUID.randomUUID().toString());
        assertThat(CONTRACT.node("/components/schemas/ErrorEnvelope/properties/error/properties/retryable/type").asText())
                .isEqualTo("boolean");
        assertThat(CONTRACT.node("/components/responses/Conflict/description").asText())
                .contains("workspace_unavailable", "retryable=false", "migration");
        Map<String, String> drift = new TreeMap<>();
        String publicBody = exchange(drift, "createSession", 409,
                post("/v1/agents/sessions").header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "fenced-public"),
                "{\"agent_id\":\"qwen-code\",\"input\":[],\"workspace\":{\"workspace_id\":\"workspace\"}}");
        String webBody = exchange(drift, "webShellCreateSession", 409,
                post(WEB_SHELL + "/sessions/create").header(TENANT, tenant).principal(actor),
                "{\"agentId\":\"qwen-code\",\"idempotencyKey\":\"fenced-web\",\"input\":[],\"workspace\":{\"workspaceId\":\"workspace\"}}");
        assertThat(drift).isEmpty();
        for (String body : List.of(publicBody, webBody)) {
            ObjectNode envelope = (ObjectNode) json(body);
            assertThat(envelope.at("/error/code").asText()).isEqualTo("workspace_unavailable");
            assertThat(envelope.at("/error/retryable").isBoolean()).isTrue();
            assertThat(envelope.at("/error/retryable").booleanValue()).isFalse();
            ((ObjectNode) envelope.required("error")).put("retryable", true);
            assertThat(CONTRACT.validate("/components/schemas/ErrorEnvelope", envelope)).isEmpty();
            ((ObjectNode) envelope.required("error")).put("retryable", "true");
            assertThat(CONTRACT.validate("/components/schemas/ErrorEnvelope", envelope)).isNotEmpty();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?", Long.class, tenant))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ?", Long.class, tenant))
                .isZero();
    }

    @Test
    void publicAutomationRunStateValidatesAsLegallyNull() throws Exception {
        ObjectNode run = (ObjectNode) json("""
                {"id":"arun_x","object":"agent.automation.run",
                 "automation_id":"asch_0123456789abcdef0123456789abcdef",
                 "session_id":"session-00000000000000000000000000000001",
                 "occurrence_key":"manual:k","trigger":"manual",
                 "outcome":"firing","reason":null,"definition_revision":1,
                 "state":null,"created_at":1,"updated_at":1}""");
        assertThat(CONTRACT.validate("/components/schemas/PublicAutomationRun", run))
                .isEmpty();
        run.put("state", "running");
        assertThat(CONTRACT.validate("/components/schemas/PublicAutomationRun", run))
                .isEmpty();
        run.put("state", "bogus");
        assertThat(CONTRACT.validate("/components/schemas/PublicAutomationRun", run))
                .isNotEmpty();
    }

    @Test
    void theCreateRequestRequiresACatchUpLimitOnlyWhenBounded() throws Exception {
        ObjectNode create = (ObjectNode) json("""
                {"session_id":"s","goal":"g","cron":"0 2 * * *",
                 "timezone":"UTC","prompt":"p","catch_up":"bounded"}""");
        assertThat(CONTRACT.validate(
                "/components/schemas/AutomationDefinitionCreateRequest",
                create)).isNotEmpty();
        create.put("catch_up_limit", 3);
        assertThat(CONTRACT.validate(
                "/components/schemas/AutomationDefinitionCreateRequest",
                create)).isEmpty();
    }

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
    void everyMappedPublicRouteIsCoveredByTheSharedSurfacePredicate() {
        // A controller method added outside the predicate's prefixes would
        // silently skip both the tenant filter and the signature filter.
        Set<String> uncovered = new TreeSet<>();
        handlerMapping.getHandlerMethods().keySet().forEach(info -> {
            for (String pattern : info.getPatternValues()) {
                if (pattern.startsWith("/internal/")
                        || pattern.startsWith("/error")) {
                    continue;
                }
                if (!com.alibaba.qwen.code.managedagent.security.PublicSurface
                        .covers(pattern)) {
                    uncovered.add(pattern);
                }
            }
        });
        assertThat(uncovered)
                .as("every public controller route must satisfy PublicSurface.covers")
                .isEmpty();
    }

    @Test
    void theCreatorOnlyResponderContractNamesTheOwnerlessFallThrough() {
        // ManagedActionStore.admit answers through the create-command
        // actor recorded for a bound Session without an owner record, or
        // through the Workspace role arm, and admits a tenant caller on an
        // unbound Session with neither. The contract phrasing keeps both
        // halves: enumerate the responder operations structurally so a
        // reworded or newly added responder cannot escape the
        // qualification.
        Set<String> responderPaths = Set.of(
                "/v1/agents/sessions/{sessionId}/actions/{actionId}/responses",
                "/api/agent/web-shell/v1/actions/respond");
        int responders = 0;
        for (Operation operation : CONTRACT.operations()) {
            boolean responder = responderPaths.contains(operation.path());
            JsonNode node = operation.node();
            String description = node.path("description").asText();
            String forbidden = node.path("responses").path("403")
                    .path("description").asText();
            if (responder) {
                responders++;
                assertThat(description + "\n" + forbidden)
                        .as(operation.operationId())
                        .contains("no recorded creator and no recorded"
                                + " create command")
                        .contains("answers through the create-command"
                                + " actor recorded for it, or through the"
                                + " Workspace role arm");
            }
            // action_forbidden is documented only where requireOwner can
            // fire, and a 403 sibling description overrides the shared
            // Forbidden component, so it must name its other code.
            assertThat((description + forbidden).contains("action_forbidden"))
                    .as(operation.operationId()).isEqualTo(responder);
            if (!forbidden.isEmpty()) {
                assertThat(forbidden).as(operation.operationId())
                        .contains("actor_scope_mismatch");
            }
        }
        assertThat(responders).isEqualTo(2);
    }

    @Test
    void transcriptContractPromisesTheFullTailPastTheSnapshot() {
        // The cursor-less transcript serves every event after the Snapshot;
        // a server-side paging change that leaves this published sentence
        // stale must turn the suite red, so pin the sentence itself.
        String description = CONTRACT.operation("webShellTranscript").node()
                .path("description").asText();
        assertThat(description).contains("and every event after it");
        assertThat(description).contains("limit bounds the page of events");
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
        Set<Class<?>> records = new LinkedHashSet<>(Arrays.asList(ApiModels.class.getDeclaredClasses()));
        records.addAll(RECORD_SCHEMAS.keySet());
        for (Class<?> type : records) {
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
        exchange(drift, "getWebShellToolDetails", 401,
                post("/api/agent/web-shell/v1/tool-details/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"itemId\":\"item_missing\"}".formatted(sessionId));
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
                                    + " ma_operation WHERE"
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
        // D7-1: the input and its cancel each read back as their own
        // command operation, settled from the Turn the Harness cancelled.
        for (String kind : List.of("SUBMIT_INPUT", "CANCEL")) {
            JsonNode command = json(exchange(drift, "getSessionCwdOperation",
                    200, get("/v1/agents/sessions/{id}/operations/{op}",
                            cancelledId, turnCommandOperation(cancelledId,
                                    kind)).header(TENANT, tenant), null));
            assertThat(command.get("type").asText())
                    .isEqualTo(kind.toLowerCase(Locale.ROOT));
            assertThat(command.get("status").asText()).isEqualTo("completed");
            assertThat(command.get("admission_stage").asText())
                    .isEqualTo("harness_confirmed");
        }

        String webSessionId = json(exchange(drift, "webShellCreateSession",
                202, post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant),
                """
                {"requestId":"contract-trace","idempotencyKey":"contract-web",
                 "agentId":"qwen-code","title":"web",
                 "metadata":{"clientId":"contract"},"input":[]}
                """)).get("sessionId").asText();
        // The widened metadata contract: a body with keys beyond clientId
        // is both served (202) and schema-valid. exchange() validates
        // sub-300 request bodies, so re-tightening WebShellMetadata to
        // additionalProperties: false turns this arm red.
        exchange(drift, "webShellCreateSession", 202,
                post(WEB_SHELL + "/sessions/create").header(TENANT, tenant),
                """
                {"idempotencyKey":"contract-web-metadata",
                 "agentId":"qwen-code","input":[],
                 "metadata":{"clientId":"client-1","other":"trace"}}
                """);
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
        for (String kind : List.of("SUBMIT_INPUT", "CANCEL")) {
            JsonNode command = json(exchange(drift,
                    "webShellQueryCwdOperation", 200,
                    post(WEB_SHELL + "/operations/query").header(TENANT, tenant),
                    """
                    {"sessionId":"%s","operationId":"%s"}
                    """.formatted(webSessionId,
                            turnCommandOperation(webSessionId, kind))));
            assertThat(command.get("type").asText())
                    .isEqualTo(kind.toLowerCase(Locale.ROOT));
            assertThat(command.get("deliveryState").asText())
                    .isEqualTo("confirmed");
        }
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
            jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                            + " workspace_id, workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref, state)"
                            + " VALUES (?, ?, 1, 'storage', ?, 'config', 'policy',"
                            + " 'ACTIVE')", workspaceTenant, workspaceId,
                    workspaceId);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                            + " workspace_id, actor_id, role)"
                            + " VALUES (?, ?, ?, 'OPERATOR')", workspaceTenant,
                    workspaceId, actor.actorId().getBytes(StandardCharsets.UTF_8));
        }
        jdbc.update("UPDATE ma_workspace SET is_default=TRUE WHERE tenant_id=? AND workspace_id=?", workspaceTenant, "ws-default");
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
        exchangeApprovalOptions(drift, tenant);
        exchange(drift, "webShellCreateWorkspace", 409,
                post(WEB_SHELL + "/workspaces/create")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{\"displayName\":\"New workspace\",\"idempotencyKey\":\"workspace-create\"}");
        exchange(drift, "queryWebShellWorkspaceDirectories", 409,
                post(WEB_SHELL + "/workspaces/directories/query")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{\"workspaceId\":\"ws-default\",\"cwdRelative\":\".\"}");
        exchange(drift, "webShellWorkspaceFilesQuery", 409,
                post(WEB_SHELL + "/workspaces/files/query")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{\"workspaceId\":\"ws-default\",\"cwdRelative\":\".\",\"directory\":\".\"}");
        exchange(drift, "webShellWorkspaceFilesRead", 409,
                post(WEB_SHELL + "/workspaces/files/read")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{\"workspaceId\":\"ws-default\",\"cwdRelative\":\".\",\"path\":\"a.txt\",\"expectedScopeRevision\":\"old\"}");
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
        exchange(drift, "queryWebShellSessionApproval", 200,
                post(WEB_SHELL + "/session-approval/query").header(TENANT, workspaceTenant).principal(actor),
                "{\"sessionId\":\"" + webBoundId + "\"}");
        exchange(drift, "queryWebShellSessionApproval", 401,
                post(WEB_SHELL + "/session-approval/query").header(TENANT, workspaceTenant),
                "{\"sessionId\":\"" + webBoundId + "\"}");
        exchange(drift, "changeWebShellSessionApproval", 409,
                post(WEB_SHELL + "/session-approval/change").header(TENANT, workspaceTenant).principal(actor),
                "{\"sessionId\":\"" + webBoundId + "\",\"approvalMode\":\"yolo\",\"expectedRevision\":0,\"idempotencyKey\":\"approval-key\"}");
        exchange(drift, "changeWebShellSessionApproval", 401,
                post(WEB_SHELL + "/session-approval/change").header(TENANT, workspaceTenant),
                "{\"sessionId\":\"" + webBoundId + "\",\"approvalMode\":\"yolo\",\"expectedRevision\":0,\"idempotencyKey\":\"approval-key\"}");
        exchange(drift, "queryWebShellSessionModels", 200,
                post(WEB_SHELL + "/session-models/query").header(TENANT, workspaceTenant).principal(actor),
                "{\"sessionId\":\"" + webBoundId + "\"}");
        exchange(drift, "queryWebShellSessionSkills", 200,
                post(WEB_SHELL + "/session-skills/query").header(TENANT, workspaceTenant).principal(actor),
                "{\"sessionId\":\"" + webBoundId + "\"}");
        exchange(drift, "queryWebShellSessionSkills", 401,
                post(WEB_SHELL + "/session-skills/query").header(TENANT, workspaceTenant),
                "{\"sessionId\":\"" + webBoundId + "\"}");
        exchange(drift, "queryWebShellSessionModels", 401,
                post(WEB_SHELL + "/session-models/query").header(TENANT, workspaceTenant),
                "{\"sessionId\":\"" + webBoundId + "\"}");
        exchange(drift, "changeWebShellSessionModel", 409,
                post(WEB_SHELL + "/session-models/change").header(TENANT, workspaceTenant).principal(actor),
                "{\"sessionId\":\"" + webBoundId + "\",\"modelId\":\"model-a\",\"expectedRevision\":0,\"idempotencyKey\":\"model-key\"}");
        exchange(drift, "changeWebShellSessionModel", 401,
                post(WEB_SHELL + "/session-models/change").header(TENANT, workspaceTenant),
                "{\"sessionId\":\"" + webBoundId + "\",\"modelId\":\"model-a\",\"expectedRevision\":0,\"idempotencyKey\":\"model-key\"}");
        exchangeAutomations(drift, workspaceTenant, otherTenant, actor,
                publicBoundId);
        // W2 refuses the operation on this fixture's deployment: the
        // workspace-files opt-in is disabled, so a bound Session answers
        // workspace_unavailable; the operation-level behavior is exercised
        // by the cwd integration tests.
        String cwdBody = """
                {"cwd_relative":"services/api","expected_context_revision":1}
                """;
        exchange(drift, "changeSessionCwd", 400,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "cwd-contract-shape"),
                "{}");
        exchange(drift, "changeSessionCwd", 401,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant)
                        .header(IDEMPOTENCY_KEY, "cwd-contract-noactor"),
                cwdBody);
        // 401 precedes the key-form check on the wire, on both surfaces.
        exchange(drift, "changeSessionCwd", 401,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant)
                        .header(IDEMPOTENCY_KEY, "not a key with space"),
                cwdBody);
        exchange(drift, "changeSessionCwd", 400,
                post("/v1/agents/sessions/{id}/cwd", sessionId)
                        .header(TENANT, tenant).principal(actor(tenant))
                        .header(IDEMPOTENCY_KEY, "cwd-contract-legacy"),
                cwdBody);
        exchange(drift, "changeSessionCwd", 404,
                post("/v1/agents/sessions/{id}/cwd", sessionId)
                        .header(TENANT, workspaceTenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "cwd-contract-foreign"),
                cwdBody);
        exchange(drift, "changeSessionCwd", 409,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "cwd-contract-bound"),
                cwdBody);
        exchange(drift, "changeSessionCwd", 400,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "cwd-contract-min-rev"),
                """
                {"cwd_relative":"services/api","expected_context_revision":0}
                """);
        String webCwdBody = """
                {"sessionId":"%s","idempotencyKey":"cwd-web-contract",
                 "cwdRelative":"services/api","expectedContextRevision":1}
                """.formatted(webBoundId);
        exchange(drift, "webShellChangeCwd", 400,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant).principal(actor),
                "{}");
        exchange(drift, "webShellChangeCwd", 401,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant), webCwdBody);
        String webCwdBadKeyBody = """
                {"sessionId":"%s","idempotencyKey":"not a key",
                 "cwdRelative":"services/api","expectedContextRevision":1}
                """.formatted(webBoundId);
        exchange(drift, "webShellChangeCwd", 401,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant), webCwdBadKeyBody);
        // The key-form refusals themselves, pinned with a trusted actor on
        // both surfaces: public header and WebShell body field both answer
        // invalid_idempotency_key below 129 chars; the WebShell body field
        // alone answers invalid_request at 129+ (the disclosed divergence).
        String publicBadKey = exchange(drift, "changeSessionCwd", 400,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "key with space"), cwdBody);
        assertThat(json(publicBadKey).at("/error/code").asText())
                .isEqualTo("invalid_idempotency_key");
        String publicLongKeyBody = exchange(drift, "changeSessionCwd", 400,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "k".repeat(129)), cwdBody);
        assertThat(json(publicLongKeyBody).at("/error/code").asText())
                .isEqualTo("invalid_idempotency_key");
        String webBadKeyBody2 = "{\"sessionId\":\"" + webBoundId
                + "\",\"idempotencyKey\":\"not a key\","
                + " \"cwdRelative\":\"services/api\","
                + "\"expectedContextRevision\":1}";
        String webBad = exchange(drift, "webShellChangeCwd", 400,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant).principal(actor),
                webBadKeyBody2);
        assertThat(json(webBad).at("/error/code").asText())
                .isEqualTo("invalid_idempotency_key");
        String webLongKeyBody = "{\"sessionId\":\"" + webBoundId
                + "\",\"idempotencyKey\":\"" + "k".repeat(129) + "\","
                + " \"cwdRelative\":\"services/api\","
                + "\"expectedContextRevision\":1}";
        String webLong = exchange(drift, "webShellChangeCwd", 400,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant).principal(actor),
                webLongKeyBody);
        assertThat(json(webLong).at("/error/code").asText())
                .isEqualTo("invalid_request");
        // A blank (whitespace-only) key diverges the same way: the public
        // header answers invalid_idempotency_key, the WebShell body field
        // refuses at bean validation with invalid_request.
        String publicBlank = exchange(drift, "changeSessionCwd", 400,
                post("/v1/agents/sessions/{id}/cwd", publicBoundId)
                        .header(TENANT, workspaceTenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, " "), cwdBody);
        assertThat(json(publicBlank).at("/error/code").asText())
                .isEqualTo("invalid_idempotency_key");
        String webBlankKeyBody = "{\"sessionId\":\"" + webBoundId
                + "\",\"idempotencyKey\":\" \","
                + " \"cwdRelative\":\"services/api\","
                + "\"expectedContextRevision\":1}";
        String webBlank = exchange(drift, "webShellChangeCwd", 400,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant).principal(actor),
                webBlankKeyBody);
        assertThat(json(webBlank).at("/error/code").asText())
                .isEqualTo("invalid_request");
        exchange(drift, "webShellChangeCwd", 409,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant).principal(actor),
                webCwdBody);
        exchange(drift, "webShellChangeCwd", 400,
                post(WEB_SHELL + "/sessions/cwd/change")
                        .header(TENANT, workspaceTenant).principal(actor),
                """
                {"sessionId":"%s","idempotencyKey":"cwd-web-min-rev",
                 "cwdRelative":"services/api","expectedContextRevision":0}
                """.formatted(webBoundId));
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
        exchangeChannels(drift, tenant, otherTenant);
        exchangeWorkspaceRegistration(drift, tenant);
        assertThat(exercised).containsExactlyInAnyOrderElementsOf(
                CONTRACT.operations().stream()
                        .filter(operation -> !"planned".equals(
                                operation.status()))
                        .map(Operation::operationId).toList());
        assertKnownGaps(drift, "request", "response");
    }

    private void exchangeWorkspaceRegistration(Map<String, String> drift, String tenant) throws Exception {
        var owner = actor(tenant);
        JsonNode nodes = json(exchange(drift, "webShellQueryRuntimeNodes", 200,
                post(WEB_SHELL + "/runtime-nodes/query").header(TENANT, tenant).principal(owner), null));
        assertThat(nodes.path("supported").asBoolean()).isFalse();
        assertThat(nodes.path("data")).isEmpty();
        String directory = "{\"nodeId\":\"mac\",\"path\":\"/work/project\"}";
        String create = """
                {"nodeId":"mac","path":"/work/project","displayName":"Project",
                 "idempotencyKey":"contract-registration","requestId":"registration-trace"}
                """;
        for (String code : List.of(
                exchange(drift, "webShellCheckWorkspaceDirectory", 404,
                        post(WEB_SHELL + "/workspaces/check-directory").header(TENANT, tenant).principal(owner), directory),
                exchange(drift, "webShellRegisterWorkspace", 404,
                        post(WEB_SHELL + "/workspaces/register").header(TENANT, tenant).principal(owner), create))) {
            assertThat(json(code).at("/error/code").asText()).isEqualTo("ssh_runtime_disabled");
        }
        exchange(drift, "webShellGetWorkspaceOperation", 404,
                post(WEB_SHELL + "/workspaces/operations/get").header(TENANT, tenant).principal(owner),
                "{\"operationId\":\"missing\"}");
        exchange(drift, "webShellQueryRuntimeNodes", 401,
                post(WEB_SHELL + "/runtime-nodes/query").header(TENANT, tenant), null);
        exchange(drift, "webShellCheckWorkspaceDirectory", 401,
                post(WEB_SHELL + "/workspaces/check-directory").header(TENANT, tenant), directory);
        exchange(drift, "webShellRegisterWorkspace", 401,
                post(WEB_SHELL + "/workspaces/register").header(TENANT, tenant), create);
        exchange(drift, "webShellGetWorkspaceOperation", 401,
                post(WEB_SHELL + "/workspaces/operations/get").header(TENANT, tenant), "{\"operationId\":\"missing\"}");
    }

    @Test
    void localWorkspaceCreationRejectsRemotePayloadsBeforeAdmission() throws Exception {
        String tenant = "contract-local-remote-boundary-" + UUID.randomUUID();
        Map<String, String> drift = new TreeMap<>();
        for (String extra : List.of(
                ",\"nodeId\":\"mac\",\"path\":\"/work/project\"",
                ",\"nodeId\":null,\"path\":\"/work/project\"",
                ",\"nodeId\":null", ",\"path\":null")) {
            String body = "{\"displayName\":\"Remote\",\"idempotencyKey\":\"original\"" + extra + "}";
            assertThat(json(exchange(drift, "webShellCreateWorkspace", 400,
                    post(WEB_SHELL + "/workspaces/create").header(TENANT, tenant).principal(actor(tenant)), body))
                    .at("/error/code").asText()).isEqualTo("invalid_request");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id = ?"
                + " AND namespace = 'WORKSPACE_CREATE'", Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(drift).isEmpty();
    }

    @Test
    void sshRegistrationOperationsStayActorOwnedWhenNewAdmissionIsDisabled() throws Exception {
        String tenant = "contract-registration-" + UUID.randomUUID();
        var operation = sshWorkspaces.begin(tenant, "actor-a", "original", "mac", "/work/project", "Project");
        var intent = sshWorkspaces.claim(tenant, "actor-a", operation.operationId(), "fixture");
        // D7-2: only a reserved registration parks recovery_blocked.
        sshWorkspaces.reserve(intent, "fixture", SurfaceAdmissionAcceptanceTest.reservedRegistration(intent, tenant));
        sshWorkspaces.fail(intent, "fixture", "ssh_runtime_identity_conflict", false);
        String body = objectMapper.writeValueAsString(Map.of("operationId", operation.operationId()));
        Map<String, String> drift = new TreeMap<>();
        JsonNode saved = json(exchange(drift, "webShellGetWorkspaceOperation", 200,
                post(WEB_SHELL + "/workspaces/operations/get").header(TENANT, tenant).principal(actor(tenant)), body));
        assertThat(saved.path("operationId").asText()).isEqualTo(operation.operationId());
        assertThat(saved.path("status").asText()).isEqualTo("recovery_blocked");
        assertThat(saved.path("replayed").asBoolean()).isTrue();
        for (var request : List.of(
                post(WEB_SHELL + "/workspaces/operations/get").header(TENANT, tenant).principal(actor(tenant, "actor-b")),
                post(WEB_SHELL + "/workspaces/operations/get").header(TENANT, tenant + "-other").principal(actor(tenant + "-other")))) {
            assertThat(json(exchange(drift, "webShellGetWorkspaceOperation", 404, request, body))
                    .at("/error/code").asText()).isEqualTo("operation_not_found");
        }
        assertThat(drift).isEmpty();
    }

    @Test
    void sshRegistrationSuccessResponsesMatchTheContractWithoutConnectingToSsh() throws Exception {
        String tenant = "contract-ssh-proxy";
        SshWorkspaceService ssh = mock(SshWorkspaceService.class);
        when(ssh.list(tenant, "actor-a")).thenReturn(new SshWorkspaceService.NodePage(true,
                List.of(new SshWorkspaceService.NodeSummary("mac", "Build Mac"))));
        when(ssh.check(tenant, "actor-a", "mac", "/work/project"))
                .thenReturn(new SshWorkspaceService.Directory("mac", "/work/project", "darwin"));
        when(ssh.create(tenant, "actor-a", "mac", "/work/project", "Project", "original"))
                .thenReturn(new SshWorkspaceStore.Operation("registration", "workspace_create", "pending", null, null, false));
        MockMvc proxy = MockMvcBuilders.standaloneSetup(new SshWorkspaceController(ssh))
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .setControllerAdvice(new ApiExceptionHandler())
                .setMessageConverters(new MappingJackson2HttpMessageConverter(objectMapper))
                .addFilters(new RequestIdFilter(), new TenantContextFilter(objectMapper)).build();
        Map<String, String> drift = new TreeMap<>();
        exchange(proxy, drift, "webShellQueryRuntimeNodes", 200,
                post(WEB_SHELL + "/runtime-nodes/query").header(TENANT, tenant).principal(actor(tenant)), null);
        exchange(proxy, drift, "webShellCheckWorkspaceDirectory", 200,
                post(WEB_SHELL + "/workspaces/check-directory").header(TENANT, tenant).principal(actor(tenant)),
                "{\"nodeId\":\"mac\",\"path\":\"/work/project\"}");
        exchange(proxy, drift, "webShellRegisterWorkspace", 202,
                post(WEB_SHELL + "/workspaces/register").header(TENANT, tenant).principal(actor(tenant)),
                """
                {"nodeId":"mac","path":"/work/project","displayName":"Project",
                 "idempotencyKey":"original","requestId":"create-registration-trace"}
                """);
        for (String status : List.of("pending", "running", "completed", "failed", "cancelled", "recovery_blocked")) {
            when(ssh.get(tenant, "actor-a", "registration")).thenReturn(new SshWorkspaceStore.Operation(
                    "registration", "workspace_create", status, "completed".equals(status) ? "workspace" : null,
                    "recovery_blocked".equals(status) ? "ssh_runtime_identity_conflict" : null, true));
            exchange(proxy, drift, "webShellGetWorkspaceOperation", 200,
                    post(WEB_SHELL + "/workspaces/operations/get").header(TENANT, tenant).principal(actor(tenant)),
                    "{\"operationId\":\"registration\"}");
        }
        verify(ssh).check(tenant, "actor-a", "mac", "/work/project");
        verify(ssh).create(tenant, "actor-a", "mac", "/work/project", "Project", "original");
        assertThat(drift).isEmpty();
    }

    private void exchangeActions(Map<String, String> drift, String tenant) throws Exception {
        String session = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "actions-contract"),
                "{\"agent_id\":\"qwen-code\",\"input\":[]}")).path("id").asText();
        jdbc.update("UPDATE ma_session SET creator_actor_key=? WHERE tenant_id=? AND session_id=?",
                "actor-a".getBytes(StandardCharsets.UTF_8), tenant, session);
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

        String eventsPath = "/v1/agents/sessions/" + sessionId + "/tasks/"
                + taskId + "/events";
        JsonNode events = json(exchange(drift, "listSessionTaskEvents", 200,
                get(eventsPath).header(TENANT, tenant), null));
        assertThat(events.get("data")).hasSize(1);
        assertThat(events.at("/data/0/type").asText())
                .isEqualTo("state_changed");
        assertThat(events.at("/data/0/state").asText()).isEqualTo("pending");
        assertThat(events.get("has_more").asBoolean()).isFalse();
        assertThat(events.get("next_cursor").isTextual()).isTrue();
        JsonNode taskView = json(exchange(drift, "getSessionTask", 200,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        taskId).header(TENANT, tenant), null));
        assertThat(taskView.get("output_cursor").isTextual()).isTrue();
        exchange(drift, "listSessionTaskEvents", 400,
                get(eventsPath).param("after", "bad").header(TENANT, tenant),
                null);
        String otherTask = rest.at("/data/0/id").asText();
        exchange(drift, "listSessionTaskEvents", 400,
                get("/v1/agents/sessions/{id}/tasks/{task}/events", sessionId,
                        otherTask)
                        .param("after", events.at("/data/0/cursor").asText())
                        .header(TENANT, tenant),
                null);
        exchange(drift, "listSessionTaskEvents", 400,
                get(eventsPath).param("limit", "0").header(TENANT, tenant),
                null);
        exchange(drift, "listSessionTaskEvents", 404,
                get(eventsPath).header(TENANT, otherTenant), null);
        exchange(drift, "listSessionTaskEvents", 403,
                get(eventsPath).header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                null);
        exchange(drift, "listSessionTaskEvents", 404,
                get("/v1/agents/sessions/{id}/tasks/{task}/events", sessionId,
                        "task_missing").header(TENANT, tenant),
                null);
        taskEvents.expireThrough(tenant, sessionId, taskId, 1);
        exchange(drift, "listSessionTaskEvents", 409,
                get(eventsPath)
                        .param("after", ManagedTaskEventStore
                                .encodeCursor(tenant, sessionId, taskId, 0))
                        .header(TENANT, tenant),
                null);
        exchange(drift, "listSessionTaskEvents", 200,
                get(eventsPath)
                        .param("after", ManagedTaskEventStore
                                .encodeCursor(tenant, sessionId, taskId, 1))
                        .header(TENANT, tenant),
                null);

        JsonNode webShellEvents = json(exchange(drift,
                "queryWebShellTaskEvents", 200,
                post(WEB_SHELL + "/tasks/events/query").header(TENANT,
                        tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(sessionId, taskId)));
        assertThat(webShellEvents.get("data")).isEmpty();
        assertThat(webShellEvents.get("nextCursor").isTextual()).isTrue();
        exchange(drift, "queryWebShellTaskEvents", 400,
                post(WEB_SHELL + "/tasks/events/query").header(TENANT,
                        tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\",\"after\":\"bad\"}"
                        .formatted(sessionId, taskId));
        exchange(drift, "queryWebShellTaskEvents", 400,
                post(WEB_SHELL + "/tasks/events/query").header(TENANT,
                        tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\",\"limit\":0}"
                        .formatted(sessionId, taskId));
        exchange(drift, "queryWebShellTaskEvents", 404,
                post(WEB_SHELL + "/tasks/events/query").header(TENANT,
                        otherTenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(sessionId, taskId));
        exchange(drift, "queryWebShellTaskEvents", 403,
                post(WEB_SHELL + "/tasks/events/query").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(sessionId, taskId));
        exchange(drift, "queryWebShellTaskEvents", 400,
                post(WEB_SHELL + "/tasks/events/query").header(TENANT,
                        tenant),
                "{\"sessionId\":\"%s\"}".formatted(sessionId));
        exchangeTaskCancels(drift, tenant, otherTenant, sessionId, taskId);

        // The served task bodies say exactly what the shared fixture views
        // say, down to the settled task's start and settle times.
        JsonNode finalView = chain.get(chain.size() - 1).required("view");
        assertThat(rest.at("/data/0/state").asText()).isEqualTo(
                finalView.required("state").textValue());
        assertThat(rest.at("/data/0/created_at").asLong()).isEqualTo(
                finalView.required("createdAt").longValue());
        assertThat(rest.at("/data/0/started_at").asLong()).isEqualTo(
                finalView.required("startedAt").longValue());
        assertThat(rest.at("/data/0/settled_at").asLong()).isEqualTo(
                finalView.required("settledAt").longValue());
        assertThat(rest.at("/data/0").hasNonNull("runtime_state")).isFalse();
        assertThat(rest.at("/data/0").hasNonNull("definition_revision"))
                .isFalse();
        JsonNode detail = json(exchange(drift, "getSessionTask", 200,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        rest.at("/data/0/id").asText())
                                .header(TENANT, tenant), null));
        assertThat(detail.at("/state").asText()).isEqualTo(
                finalView.required("state").textValue());
        assertThat(detail.at("/settled_at").asLong()).isEqualTo(
                finalView.required("settledAt").longValue());

        // A Session with no Stage H record lists no task at all, the only
        // response today's production offers, and the detail of another
        // Session's task is the documented 404, not an error.
        String emptySession = json(mvc.perform(post("/v1/agents/sessions")
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-empty-tasks")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\"}"))
                .andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8)).get("id")
                .asText();
        JsonNode emptyPage = json(exchange(drift, "listSessionTasks", 200,
                get("/v1/agents/sessions/{id}/tasks", emptySession)
                        .header(TENANT, tenant), null));
        assertThat(emptyPage.get("data").size()).isZero();
        assertThat(emptyPage.get("has_more").asBoolean()).isFalse();
        exchange(drift, "getSessionTask", 404,
                get("/v1/agents/sessions/{id}/tasks/{task}", emptySession,
                        rest.at("/data/0/id").asText())
                                .header(TENANT, tenant), null);
        exchange(drift, "getWebShellTask", 404,
                post(WEB_SHELL + "/tasks/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(emptySession,
                                rest.at("/data/0/id").asText()));
    }

    /** A committed record body for a synthetic child_run row. */
    private void childRunResource(String tenant, String sessionId,
            String resourceId, String json) {
        String scope = com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore.sessionScopeKey(tenant, sessionId);
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource (resource_key,"
                + " session_scope_key, tenant_id, workspace_id, session_id,"
                + " resource_id, kind, schema_version, byte_length, sha256,"
                + " storage_kind, inline_bytes, publish_command_id, state,"
                + " gmt_create) VALUES (?, ?, ?, 'workspace-contract', ?, ?,"
                + " 'managed-child-run', 1, ?, ?, 'MYSQL_INLINE', ?,"
                + " 'command', 'REFERENCED', "
                + com.alibaba.qwen.code.runtimebroker.managedschema
                        .ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.runtimebroker.managedschema
                        .ManagedSchemaKeys.key(scope, resourceId),
                scope, tenant, sessionId, resourceId, body.length,
                org.apache.commons.codec.digest.DigestUtils.sha256Hex(body),
                body);
    }

    /**
     * H4f: the cancel routes over a monitor task (no cancel action) and a
     * running child-agent task row. Delivery is the coordinator's and is
     * asserted elsewhere; here the admission answers and the read-back of
     * the admitted task_cancel operation meet the contract.
     */
    private void exchangeTaskCancels(Map<String, String> drift, String tenant,
            String otherTenant, String sessionId, String monitorTask)
            throws Exception {
        String recordKey = "c".repeat(64);
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, runtime_state,"
                        + " delivery_target, delivery_state, gmt_create,"
                        + " started_at) VALUES (?, ?, ?, 'workspace-contract',"
                        + " ?, 'child_run', 'run-contract', ?, 1,"
                        + " 'resource-run-contract', 'child_agent', 'running',"
                        + " 'ready', 'session', 'planned', 1, 2)",
                com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore
                        .sessionScopeKey(tenant, sessionId),
                recordKey, tenant, sessionId, "d".repeat(64));
        // #13746 F2: the run's committed record names its child Session,
        // and both task views carry that link inside their schemas.
        String childSession = UUID.randomUUID().toString();
        childRunResource(tenant, sessionId, "resource-run-contract",
                "{\"kind\":\"child_agent\",\"childSessionId\":\""
                        + childSession + "\"}");
        String childTask = "task_" + recordKey;
        JsonNode view = json(exchange(drift, "getSessionTask", 200,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        childTask).header(TENANT, tenant), null));
        assertThat(view.get("action_capabilities").toString())
                .isEqualTo("[\"cancel\"]");
        assertThat(view.get("child_session_id").asText())
                .isEqualTo(childSession);
        JsonNode webShellView = json(exchange(drift, "getWebShellTask", 200,
                post(WEB_SHELL + "/tasks/get").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(sessionId, childTask)));
        assertThat(webShellView.get("childSessionId").asText())
                .isEqualTo(childSession);
        String cancelPath = "/v1/agents/sessions/{id}/tasks/{task}/cancel";
        JsonNode admitted = json(exchange(drift, "cancelSessionTask", 202,
                post(cancelPath, sessionId, childTask).header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-task-cancel"),
                null));
        assertThat(admitted.get("type").asText()).isEqualTo("task_cancel");
        assertThat(admitted.get("task_id").asText()).isEqualTo(childTask);
        assertThat(admitted.get("replayed").asBoolean()).isFalse();
        JsonNode replayed = json(exchange(drift, "cancelSessionTask", 202,
                post(cancelPath, sessionId, childTask).header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-task-cancel"),
                null));
        assertThat(replayed.get("id").asText())
                .isEqualTo(admitted.get("id").asText());
        assertThat(replayed.get("replayed").asBoolean()).isTrue();
        JsonNode readBack = json(exchange(drift, "getSessionCwdOperation", 200,
                get("/v1/agents/sessions/{id}/operations/{operation}",
                        sessionId, admitted.get("id").asText())
                        .header(TENANT, tenant), null));
        assertThat(readBack.get("task_id").asText()).isEqualTo(childTask);
        exchange(drift, "webShellQueryCwdOperation", 200,
                post(WEB_SHELL + "/operations/query").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"operationId\":\"%s\"}"
                        .formatted(sessionId, admitted.get("id").asText()));
        // The same key for another task is another request.
        exchange(drift, "cancelSessionTask", 409,
                post(cancelPath, sessionId, monitorTask).header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-task-cancel"),
                null);
        // A monitor task has no cancel path: a new key is refused.
        exchange(drift, "cancelSessionTask", 409,
                post(cancelPath, sessionId, monitorTask).header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-monitor-cancel"),
                null);
        exchange(drift, "cancelSessionTask", 400,
                post(cancelPath, sessionId, childTask).header(TENANT, tenant),
                null);
        exchange(drift, "cancelSessionTask", 404,
                post(cancelPath, sessionId, "task_missing")
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-missing-cancel"),
                null);
        exchange(drift, "cancelSessionTask", 404,
                post(cancelPath, sessionId, childTask)
                        .header(TENANT, otherTenant)
                        .header(IDEMPOTENCY_KEY, "contract-foreign-cancel"),
                null);
        exchange(drift, "cancelSessionTask", 403,
                post(cancelPath, sessionId, childTask).header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-scope-cancel")
                        .principal(actor(otherTenant)), null);

        JsonNode webShell = json(exchange(drift, "cancelWebShellTask", 202,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                ("{\"requestId\":\"contract-request\",\"sessionId\":\"%s\","
                        + "\"taskId\":\"%s\",\"idempotencyKey\":"
                        + "\"contract-task-cancel\"}")
                        .formatted(sessionId, childTask)));
        assertThat(webShell.get("operationId").asText())
                .isEqualTo(admitted.get("id").asText());
        assertThat(webShell.get("taskId").asText()).isEqualTo(childTask);
        assertThat(webShell.get("replayed").asBoolean()).isTrue();
        exchange(drift, "cancelWebShellTask", 409,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                ("{\"sessionId\":\"%s\",\"taskId\":\"%s\","
                        + "\"idempotencyKey\":\"contract-web-monitor\"}")
                        .formatted(sessionId, monitorTask));
        exchange(drift, "cancelWebShellTask", 400,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                "{\"sessionId\":\"%s\",\"taskId\":\"%s\"}"
                        .formatted(sessionId, childTask));
        // The closed request object refuses an unknown field, and an
        // overlong key is the contract's malformed-key refusal.
        exchange(drift, "cancelWebShellTask", 400,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                ("{\"sessionId\":\"%s\",\"taskId\":\"%s\","
                        + "\"idempotencyKey\":\"contract-web-unknown\","
                        + "\"extra\":true}").formatted(sessionId, childTask));
        assertThat(json(exchange(drift, "cancelWebShellTask", 400,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                ("{\"sessionId\":\"%s\",\"taskId\":\"%s\","
                        + "\"idempotencyKey\":\"%s\"}").formatted(sessionId,
                        childTask, "k".repeat(129))))
                .at("/error/code").asText())
                .isEqualTo("invalid_idempotency_key");
        exchange(drift, "cancelWebShellTask", 404,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                ("{\"sessionId\":\"%s\",\"taskId\":\"task_missing\","
                        + "\"idempotencyKey\":\"contract-web-missing\"}")
                        .formatted(sessionId));
        exchange(drift, "cancelWebShellTask", 403,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant)
                        .principal(actor(otherTenant)),
                ("{\"sessionId\":\"%s\",\"taskId\":\"%s\","
                        + "\"idempotencyKey\":\"contract-web-scope\"}")
                        .formatted(sessionId, childTask));

        // H4f-b: a workflow task serves the same cancel on both surfaces,
        // and its view advertises the action.
        String workflowKey = "e".repeat(64);
        jdbc.update("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, record_id, operation_hash, revision, record_resource_id, task_kind, task_state, runtime_state, delivery_target, delivery_state, gmt_create, started_at) VALUES (?, ?, ?, 'workspace-contract', ?, 'child_run', 'run-contract-wf', ?, 1, 'resource-run-contract-wf', 'workflow', 'running', 'ready', 'session', 'planned', 1, 2)",
                com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore
                        .sessionScopeKey(tenant, sessionId),
                workflowKey, tenant, sessionId, "f".repeat(64));
        childRunResource(tenant, sessionId, "resource-run-contract-wf",
                "{\"kind\":\"workflow\",\"childSessionId\":null}");
        String workflowTask = "task_" + workflowKey;
        JsonNode workflowView = json(exchange(drift, "getSessionTask", 200,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        workflowTask).header(TENANT, tenant), null));
        assertThat(workflowView.get("action_capabilities").toString())
                .isEqualTo("[\"cancel\"]");
        // Before its child is known, a child task names none.
        assertThat(workflowView.has("child_session_id")).isFalse();
        // The child_agent cancel above stays open in this fixture, and the
        // one open operation per Session rule spans task kinds.
        assertThat(json(exchange(drift, "cancelSessionTask", 409,
                post(cancelPath, sessionId, workflowTask).header(TENANT,
                        tenant).header(IDEMPOTENCY_KEY,
                        "contract-workflow-blocked"), null))
                .at("/error/code").asText())
                .isEqualTo("session_operation_active");
        jdbc.update("UPDATE ma_operation SET state = 'COMPLETED'"
                + " WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_kind = 'TASK_CANCEL'"
                + " AND state IN ('PENDING', 'RUNNING')", tenant, sessionId);
        JsonNode workflowAdmitted = json(exchange(drift, "cancelSessionTask",
                202, post(cancelPath, sessionId, workflowTask)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-workflow-cancel"),
                null));
        assertThat(workflowAdmitted.get("type").asText())
                .isEqualTo("task_cancel");
        assertThat(workflowAdmitted.get("task_id").asText())
                .isEqualTo(workflowTask);
        assertThat(workflowAdmitted.get("replayed").asBoolean()).isFalse();
        JsonNode workflowReplayed = json(exchange(drift, "cancelSessionTask",
                202, post(cancelPath, sessionId, workflowTask)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-workflow-cancel"),
                null));
        assertThat(workflowReplayed.get("id").asText())
                .isEqualTo(workflowAdmitted.get("id").asText());
        assertThat(workflowReplayed.get("replayed").asBoolean()).isTrue();
        JsonNode workflowWebShell = json(exchange(drift, "cancelWebShellTask",
                202, post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                ("{\"sessionId\":\"%s\",\"taskId\":\"%s\","
                        + "\"idempotencyKey\":\"contract-workflow-cancel\"}")
                        .formatted(sessionId, workflowTask)));
        assertThat(workflowWebShell.get("operationId").asText())
                .isEqualTo(workflowAdmitted.get("id").asText());
        assertThat(workflowWebShell.get("replayed").asBoolean()).isTrue();

        String automationKey = "1".repeat(64);
        jdbc.update("UPDATE ma_operation SET state = 'COMPLETED'"
                + " WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_kind = 'TASK_CANCEL'"
                + " AND state IN ('PENDING', 'RUNNING')", tenant, sessionId);
        jdbc.update("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, record_id, operation_hash, revision, record_resource_id, task_kind, task_state, runtime_state, delivery_target, delivery_state, gmt_create, started_at) VALUES (?, ?, ?, 'workspace-contract', ?, 'automation_run', 'arun-contract', ?, 2, 'resource-automation-contract', 'automation_run', 'running', 'ready', 'session', 'planned', 1, 2)",
                com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore
                        .sessionScopeKey(tenant, sessionId),
                automationKey, tenant, sessionId, "2".repeat(64));
        childRunResource(tenant, sessionId, "resource-automation-contract",
                "{\"scheduleId\":\"asch_" + "1".repeat(32)
                        + "\",\"occurrenceKey\":\"manual:contract\"}");
        String automationTask = "task_" + automationKey;
        assertThat(json(exchange(drift, "getSessionTask", 200,
                get("/v1/agents/sessions/{id}/tasks/{task}", sessionId,
                        automationTask).header(TENANT, tenant), null))
                .get("action_capabilities").toString()).isEqualTo("[\"cancel\"]");
        JsonNode automationAdmitted = json(exchange(drift, "cancelSessionTask", 202,
                post(cancelPath, sessionId, automationTask).header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "contract-automation-cancel"), null));
        assertThat(automationAdmitted.get("type").asText()).isEqualTo("task_cancel");
        assertThat(automationAdmitted.get("task_id").asText()).isEqualTo(automationTask);
        JsonNode automationWebShell = json(exchange(drift, "cancelWebShellTask", 202,
                post(WEB_SHELL + "/tasks/cancel").header(TENANT, tenant),
                ("{\"sessionId\":\"%s\",\"taskId\":\"%s\","
                        + "\"idempotencyKey\":\"contract-automation-cancel\"}")
                        .formatted(sessionId, automationTask)));
        assertThat(automationWebShell.get("operationId").asText())
                .isEqualTo(automationAdmitted.get("id").asText());
        assertThat(automationWebShell.get("replayed").asBoolean()).isTrue();
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
        ObjectNode configured = (ObjectNode) objectMapper.readTree(body);
        configured.putArray("skills").addObject().put("name", "评审:review").put("description", "Review changes")
                .put("body", "Read the diff.").put("base_directory", ".qwen/skills/review");
        configured.putArray("mcp_servers").addObject().put("server_id", "docs").put("server_revision", 1)
                .put("definition_digest", "a".repeat(64));
        configured.putObject("hook_catalog").put("catalog_id", "review").put("catalog_revision", 2)
                .put("definition_digest", "b".repeat(64));
        body = configured.toString();
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
        exchange(drift, "updateAgent", 400, post("/v1/agents/{id}", agentId)
                .header(TENANT, tenant).header(IDEMPOTENCY_KEY, "agent update"),
                changed);
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

    /**
     * H6b: the automation resources over the fixture Harness's automation
     * funnel — a definition created, read, revised and retired under the
     * bound Session its creator owns, a manual run with its replay and the
     * overlap refusal, and the occurrence list.
     */
    private void exchangeAutomations(Map<String, String> drift, String tenant,
            String otherTenant, AuthenticatedTenantActor actor,
            String sessionId) throws Exception {
        String body = """
                {"session_id":"%s","goal":"Nightly build","cron":"0 2 * * *",
                 "timezone":"Asia/Shanghai","prompt":"Run the build."}
                """.formatted(sessionId);
        // The bound Session becomes ACTIVE when its creation operation has
        // attached the fixture Harness; automation admission requires it.
        await().atMost(Duration.ofSeconds(10)).until(() -> store
                .findSession(tenant, sessionId)
                .map(session -> "ACTIVE".equals(session.status()))
                .orElse(false));
        JsonNode created = json(exchange(drift, "createAgentAutomation", 202,
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create"), body));
        String automationId = created.path("id").asText();
        assertThat(automationId).startsWith("asch_");
        assertThat(created.path("definition_revision").asLong()).isEqualTo(1);
        assertThat(created.path("state").asText()).isEqualTo("live");
        assertThat(created.path("session_id").asText()).isEqualTo(sessionId);
        exchange(drift, "createAgentAutomation", 202,
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create"), body);
        MockHttpServletResponse replay = mvc.perform(
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
        assertThat(replay.getStatus()).isEqualTo(202);
        assertThat(replay.getHeader("X-Qwen-Idempotent-Replay"))
                .isEqualTo("true");
        assertThat(objectMapper.readTree(replay.getContentAsString())
                .path("id").asText()).isEqualTo(automationId);
        exchange(drift, "createAgentAutomation", 409,
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create"),
                body.replace("Nightly build", "Weekly build"));
        exchange(drift, "createAgentAutomation", 400,
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create-tz"),
                body.replace("Asia/Shanghai", "Mars/Olympus_Mons"));
        // Grammar-valid but over the declared mirror bound
        // (cron VARCHAR(400), OpenAPI maxLength 400): the service refuses
        // before the funnel commits, instead of answering 500 from the
        // mirror INSERT with the Idempotency-Key already burned.
        String longCron = String.join(",", java.util.Collections.nCopies(300, "0"))
                + " 0 1 1 0";
        JsonNode longCronRefusal = json(exchange(drift, "createAgentAutomation",
                400, post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create-long-cron"),
                body.replace("\"cron\":\"0 2 * * *\"",
                        "\"cron\":\"" + longCron + "\"")));
        assertThat(longCronRefusal.path("error").path("code").asText())
                .isEqualTo("invalid_automation");
        exchange(drift, "createAgentAutomation", 409,
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create-mode"),
                body.replace("\"prompt\"", "\"session_mode\":\"per_run\",\"prompt\""));
        exchange(drift, "createAgentAutomation", 404,
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-create-missing"),
                body.replace(sessionId, UUID.randomUUID().toString()));
        exchange(drift, "createAgentAutomation", 403,
                post("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor(otherTenant))
                        .header(IDEMPOTENCY_KEY, "automation-create-foreign"),
                body);
        JsonNode list = json(exchange(drift, "listAgentAutomations", 200,
                get("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor).param("limit", "10"), null));
        assertThat(list.path("data")).hasSize(1);
        assertThat(list.path("data").get(0).path("id").asText())
                .isEqualTo(automationId);
        exchange(drift, "listAgentAutomations", 400,
                get("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor).param("cursor", "!!"), null);
        exchange(drift, "listAgentAutomations", 400,
                get("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor).param("limit", "0"), null);
        exchange(drift, "listAgentAutomations", 403,
                get("/v1/agent-automations").header(TENANT, tenant)
                        .principal(actor(otherTenant)), null);
        String missing = "asch_" + "0".repeat(32);
        exchange(drift, "getAgentAutomation", 200,
                get("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor), null);
        exchange(drift, "getAgentAutomation", 404,
                get("/v1/agent-automations/{id}", missing)
                        .header(TENANT, tenant).principal(actor), null);
        exchange(drift, "getAgentAutomation", 403,
                get("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor(otherTenant)),
                null);
        JsonNode revised = json(exchange(drift, "updateAgentAutomation", 202,
                post("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-update"),
                "{\"cron\":\"30 2 * * *\"}"));
        assertThat(revised.path("definition_revision").asLong()).isEqualTo(2);
        assertThat(revised.path("cron").asText()).isEqualTo("30 2 * * *");
        assertThat(revised.path("goal").asText()).isEqualTo("Nightly build");
        exchange(drift, "updateAgentAutomation", 400,
                post("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-update-bad"),
                "{\"cron\":\"0 25 * * *\"}");
        exchange(drift, "updateAgentAutomation", 404,
                post("/v1/agent-automations/{id}", missing)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-update-missing"),
                "{\"cron\":\"30 2 * * *\"}");
        exchange(drift, "updateAgentAutomation", 403,
                post("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor(otherTenant))
                        .header(IDEMPOTENCY_KEY, "automation-update-foreign"),
                "{\"cron\":\"30 2 * * *\"}");
        JsonNode run = json(exchange(drift, "runAgentAutomation", 202,
                post("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-run-1"), null));
        assertThat(run.path("outcome").asText()).isEqualTo("fired");
        assertThat(run.path("trigger").asText()).isEqualTo("manual");
        assertThat(run.path("occurrence_key").asText())
                .isEqualTo("manual:automation-run-1");
        assertThat(run.path("id").asText()).startsWith("arun_");
        MockHttpServletResponse runReplay = mvc.perform(
                post("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-run-1"))
                .andReturn().getResponse();
        assertThat(runReplay.getStatus()).isEqualTo(202);
        assertThat(runReplay.getHeader("X-Qwen-Idempotent-Replay"))
                .isEqualTo("true");
        assertThat(objectMapper.readTree(runReplay.getContentAsString())
                .path("id").asText()).isEqualTo(run.path("id").asText());
        // The first run has not settled, and the definition's overlap policy
        // is skip: a second manual run is dropped and recorded.
        exchange(drift, "runAgentAutomation", 409,
                post("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-run-2"), null);
        exchange(drift, "runAgentAutomation", 404,
                post("/v1/agent-automations/{id}/runs", missing)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-run-missing"),
                null);
        exchange(drift, "runAgentAutomation", 403,
                post("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor(otherTenant))
                        .header(IDEMPOTENCY_KEY, "automation-run-foreign"),
                null);
        JsonNode runs = json(exchange(drift, "listAgentAutomationRuns", 200,
                get("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor), null));
        assertThat(runs.path("data")).hasSize(2);
        assertThat(runs.path("data").findValuesAsText("outcome"))
                .containsExactlyInAnyOrder("fired", "skipped");
        exchange(drift, "listAgentAutomationRuns", 400,
                get("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .param("cursor", "!!"), null);
        exchange(drift, "listAgentAutomationRuns", 404,
                get("/v1/agent-automations/{id}/runs", missing)
                        .header(TENANT, tenant).principal(actor), null);
        exchange(drift, "listAgentAutomationRuns", 403,
                get("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor(otherTenant)),
                null);
        JsonNode retired = json(exchange(drift, "retireAgentAutomation", 202,
                delete("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-retire"), null));
        assertThat(retired.path("state").asText()).isEqualTo("retired");
        assertThat(retired.path("enabled").asBoolean()).isFalse();
        exchange(drift, "retireAgentAutomation", 400,
                delete("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "k".repeat(129)), null);
        exchange(drift, "retireAgentAutomation", 404,
                delete("/v1/agent-automations/{id}", missing)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-retire-missing"),
                null);
        exchange(drift, "retireAgentAutomation", 403,
                delete("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor(otherTenant))
                        .header(IDEMPOTENCY_KEY, "automation-retire-foreign"),
                null);
        exchange(drift, "runAgentAutomation", 409,
                post("/v1/agent-automations/{id}/runs", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-run-3"), null);
        exchange(drift, "updateAgentAutomation", 409,
                post("/v1/agent-automations/{id}", automationId)
                        .header(TENANT, tenant).principal(actor)
                        .header(IDEMPOTENCY_KEY, "automation-update-retired"),
                "{\"cron\":\"0 3 * * *\"}");
    }

    /**
     * H5c: the three channel resources, served over seeded rows exactly as
     * the channel service writes them — a registered connection, an
     * admitted ingress row and a delivered ledger row.
     */
    private void exchangeChannels(Map<String, String> drift, String tenant,
            String otherTenant) throws Exception {
        String channelTenant = tenant + "-channel";
        AuthenticatedTenantActor reader = new AuthenticatedTenantActor() {
            @Override
            public String getName() {
                return actorId();
            }

            @Override
            public String tenantId() {
                return channelTenant;
            }

            @Override
            public String actorId() {
                return "channel-reader";
            }
        };
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, 'ws-channel', 1, 'storage', 'Channel',"
                        + " 'config', 'policy', 'ACTIVE')", channelTenant);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, 'ws-channel', ?, 'OPERATOR')",
                channelTenant,
                reader.actorId().getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO ma_channel_instance (tenant_id,"
                        + " channel_id, platform, account_id,"
                        + " account_generation, state, actor_id, workspace_id,"
                        + " cwd_relative, policy_json, gmt_create, gmt_modified)"
                        + " VALUES (?, 'mail-1', 'email', 'agent@example.com',"
                        + " 1, 'connected', 'channel-reader', 'ws-channel',"
                        + " '.', '{}', 1000, 1000)", channelTenant);
        String sessionId = UUID.randomUUID().toString();
        var routeRepository = new com.alibaba.qwen.code.managedagent.persistence.JdbcChannelRouteRepository(jdbc);
        routeRepository.findOrCreate(new com.alibaba.qwen.code.managedagent.persistence.ChannelRouteRepository.ChannelRoute(
                channelTenant, "a".repeat(64), "mail-1", 1, "1700:42", 1, sessionId,
                "alice@example.com", "alice@example.com", "thread-1", "admitted", "chin-" + "a".repeat(64),
                List.of("sha256:" + "b".repeat(64)), 1000, 1000));
        var deliveryRepository = new com.alibaba.qwen.code.managedagent.persistence.JdbcChannelDeliveryRepository(jdbc);
        deliveryRepository.findOrCreate(new com.alibaba.qwen.code.managedagent.persistence.ChannelDeliveryRepository.ChannelDelivery(
                channelTenant, "mail-1", "delivery-1", "delivery-1:0", 0, "planned", null, 1000, 1000));
        deliveryRepository.transition(channelTenant, "mail-1", "delivery-1", "planned", "sending", null);
        deliveryRepository.transition(channelTenant, "mail-1", "delivery-1", "sending", "delivered", "<m1@example.com>");
        JsonNode channels = json(exchange(drift, "listAgentChannels", 200,
                get("/v1/agent-channels").header(TENANT, channelTenant)
                        .principal(reader).param("limit", "10"), null));
        assertThat(channels.path("data")).hasSize(1);
        assertThat(channels.path("data").get(0).path("routes")).hasSize(1);
        assertThat(channels.path("data").get(0).path("routes").get(0)
                .path("session_id").asText()).isEqualTo(sessionId);
        exchange(drift, "listAgentChannels", 400,
                get("/v1/agent-channels").header(TENANT, channelTenant)
                        .principal(reader).param("cursor", "!!"), null);
        exchange(drift, "listAgentChannels", 400,
                get("/v1/agent-channels").header(TENANT, channelTenant)
                        .principal(reader).param("limit", "0"), null);
        exchange(drift, "listAgentChannels", 403,
                get("/v1/agent-channels").header(TENANT, channelTenant)
                        .principal(actor(otherTenant)), null);
        JsonNode deliveries = json(exchange(drift,
                "listAgentChannelDeliveries", 200,
                get("/v1/agent-channels/{id}/deliveries", "mail-1")
                        .header(TENANT, channelTenant).principal(reader),
                null));
        assertThat(deliveries.path("data")).hasSize(1);
        assertThat(deliveries.path("data").get(0).path("state").asText())
                .isEqualTo("delivered");
        exchange(drift, "listAgentChannelDeliveries", 404,
                get("/v1/agent-channels/{id}/deliveries", "missing")
                        .header(TENANT, channelTenant).principal(reader),
                null);
        exchange(drift, "listAgentChannelDeliveries", 400,
                get("/v1/agent-channels/{id}/deliveries", "mail-1")
                        .header(TENANT, channelTenant).principal(reader)
                        .param("cursor", "!!"), null);
        exchange(drift, "listAgentChannelDeliveries", 403,
                get("/v1/agent-channels/{id}/deliveries", "mail-1")
                        .header(TENANT, channelTenant)
                        .principal(actor(otherTenant)), null);
        JsonNode delivery = json(exchange(drift, "getAgentChannelDelivery",
                200, get("/v1/agent-channels/{id}/deliveries/{d}", "mail-1",
                        "delivery-1").header(TENANT, channelTenant)
                        .principal(reader), null));
        assertThat(delivery.path("provider_receipt").asText())
                .isEqualTo("<m1@example.com>");
        exchange(drift, "getAgentChannelDelivery", 404,
                get("/v1/agent-channels/{id}/deliveries/{d}", "mail-1",
                        "missing").header(TENANT, channelTenant)
                        .principal(reader), null);
        exchange(drift, "getAgentChannelDelivery", 403,
                get("/v1/agent-channels/{id}/deliveries/{d}", "mail-1",
                        "delivery-1").header(TENANT, channelTenant)
                        .principal(actor(otherTenant)), null);
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
        TurnSummary first = java.util.Objects.requireNonNull(
                store.findLatestTurns(tenant, java.util.List.of(sessionId))
                        .get(sessionId));
        // The fixture Harness runs one Turn per Session, so the second Turn
        // is written as a failed dispatch would leave it.
        String second = "turn_" + UUID.randomUUID().toString()
                .replace("-", "");
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, error_code, gmt_create, gmt_modified,"
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
            // D7-3: durable_operations appears only where the profile is on.
            JsonNode capabilities = json("""
                    {"items":true,"snapshots":true,"artifacts":false,
                     "resync":true,"session_lifecycle":true,"tasks":true,"actions":false,"session_close":true,
                     "session_archive":true,"session_unarchive":true,"session_delete":true}
                    """);
            if (javaDurableAdmission != null) {
                ((com.fasterxml.jackson.databind.node.ObjectNode) capabilities)
                        .put("durable_operations", true);
            }
            assertThat(session.get("capabilities")).isEqualTo(capabilities);
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
                JsonNode webCapabilities = json("""
                                {"tasks":true,"artifacts":false,"actions":false,"workspaceTurns":false,"sessionClose":true,
                                 "sessionArchive":true,"sessionUnarchive":true,"sessionDelete":true,"cwdChange":false,"modelChange":false,"approvalModeChange":false,"inputAttachments":false}
                                """);
                if (javaDurableAdmission != null) {
                    ((com.fasterxml.jackson.databind.node.ObjectNode) webCapabilities)
                            .put("durableOperations", true);
                }
                assertThat(other.get("capabilities")).isEqualTo(webCapabilities);
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
    void webShellSubmitAcceptsTheWidenedMetadataShape() throws Exception {
        // The exact body the integration suite posts to /turns/submit for
        // the metadata widening must conform to the published
        // WebShellSubmitRequest: re-tightening WebShellMetadata (or the
        // request's additionalProperties) turns this red.
        assertThat(CONTRACT.validate(
                "#/components/schemas/WebShellSubmitRequest",
                objectMapper.readTree("""
                        {"sessionId":"00000000-0000-4000-8000-000000000000",
                         "idempotencyKey":"metadata-submit",
                         "input":[{"type":"input_text","text":"hi"}],
                         "metadata":{"clientId":"client-1","other":"trace"}}
                        """))).isEmpty();
    }

    @Test
    void thePublishedAggregateBudgetIsTheEnforcedOne() throws Exception {
        String tenant = "tenant-contract-budget-" + UUID.randomUUID();
        String sessionId = json(webShell(tenant, "/sessions/create",
                "{\"idempotencyKey\":\"budget-create\","
                        + "\"agentId\":\"qwen-code\",\"input\":[]}"))
                .get("sessionId").asText();
        // Every published copy of the budget states the same three
        // enforced numbers: the aggregate, the per-block cap and the
        // durable-record ceiling.
        long publishedAggregate = 0, publishedBlock = 0, publishedKib = 0;
        for (String schema : List.of("CreateSessionRequest",
                "InputMessageEventRequest", "WebShellCreateRequest",
                "WebShellSubmitRequest")) {
            String description = CONTRACT.node("/components/schemas/"
                    + schema + "/properties/input/description").asText();
            long aggregate = publishedNumber(description,
                    "([0-9,]+)-character aggregate", schema);
            long perBlock = publishedNumber(description,
                    "per-block ([0-9,]+)-character cap", schema);
            long kib = publishedNumber(description,
                    "(\\d+) KiB durable-record limit", schema);
            if (publishedAggregate == 0) {
                publishedAggregate = aggregate;
                publishedBlock = perBlock;
                publishedKib = kib;
            } else {
                assertThat(aggregate).as("%s aggregate", schema)
                        .isEqualTo(publishedAggregate);
                assertThat(perBlock).as("%s per-block cap", schema)
                        .isEqualTo(publishedBlock);
                assertThat(kib).as("%s durable-record KiB", schema)
                        .isEqualTo(publishedKib);
            }
        }
        assertThat(publishedKib * 1024)
                .as("published durable-record limit is the enforced one")
                .isEqualTo(ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES);
        assertThat(CONTRACT.node("/components/schemas/InputTextBlock"
                + "/properties/text/maxLength").asLong())
                .as("published per-block maxLength is the enforced"
                        + " per-block cap")
                .isEqualTo(publishedBlock);

        // The enforced numbers are read out of the 400s the server
        // returns, so no copy of either constant lives in this test.
        String block = "{\"type\":\"input_text\",\"text\":\""
                + "x".repeat((int) publishedBlock) + "\"}";
        String oversizedInput = (block + ",").repeat(4) + block;
        String oversized = "{\"idempotencyKey\":\"budget-submit\","
                + "\"sessionId\":\"" + sessionId + "\",\"input\":["
                + oversizedInput + "]}";
        String message = json(webShell(tenant, "/turns/submit", oversized))
                .path("error").path("message").asText();
        var enforcedMatcher = java.util.regex.Pattern
                .compile("exceeds the (\\d+) character aggregate limit")
                .matcher(message);
        assertThat(enforcedMatcher.find())
                .as("400 message names the budget: %s", message).isTrue();
        assertThat(Long.parseLong(enforcedMatcher.group(1)))
                .as("enforced aggregate matches the published one")
                .isEqualTo(publishedAggregate);

        // The public events route enforces the same budget, not just the
        // WebShell one; there the idempotency key travels in the
        // Idempotency-Key header instead of the body.
        MockHttpServletResponse publicRefusal = mvc.perform(
                        post("/v1/agents/sessions/{id}/events", sessionId)
                                .header(TENANT, tenant)
                                .header(IDEMPOTENCY_KEY,
                                        "budget-public-submit")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"type\":\"agent.session.input."
                                        + "message\",\"input\":["
                                        + oversizedInput + "]}"))
                .andReturn().getResponse();
        assertThat(publicRefusal.getStatus())
                .as("public events route refuses the oversized body")
                .isEqualTo(400);
        JsonNode publicError = json(publicRefusal.getContentAsString(
                StandardCharsets.UTF_8)).path("error");
        assertThat(publicError.path("code").asText())
                .isEqualTo("invalid_input");
        assertThat(publicError.path("message").asText())
                .as("public route 400 names the same aggregate budget")
                .isEqualTo(message);

        // One block at published+1 characters stays under the aggregate,
        // so this 400 can only come from the per-block cap.
        String overCap = "{\"idempotencyKey\":\"budget-block\","
                + "\"sessionId\":\"" + sessionId + "\",\"input\":["
                + "{\"type\":\"input_text\",\"text\":\""
                + "x".repeat((int) publishedBlock + 1) + "\"}]}";
        String blockMessage = json(webShell(tenant, "/turns/submit", overCap))
                .path("error").path("message").asText();
        var enforcedBlockMatcher = java.util.regex.Pattern
                .compile("exceeds the (\\d+) character per-block limit")
                .matcher(blockMessage);
        assertThat(enforcedBlockMatcher.find())
                .as("400 message names the per-block cap: %s", blockMessage)
                .isTrue();
        assertThat(Long.parseLong(enforcedBlockMatcher.group(1)))
                .as("enforced per-block cap matches the published one")
                .isEqualTo(publishedBlock);

        // The counted unit is the code point, matching the published
        // maxLength: a 600,000-emoji block is 1,200,000 UTF-16 units, so a
        // String.length()-based cap would refuse what the schema admits.
        // Each arm submits to its own session: a second submit while a Turn
        // is active is a 409, not a budget decision.
        String emojiBlock = "{\"type\":\"input_text\",\"text\":\""
                + "\uD83D\uDE00".repeat(600_000) + "\"}";
        mvc.perform(post(WEB_SHELL + "/turns/submit").header(TENANT, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"idempotencyKey\":\"budget-emoji-block\","
                                + "\"sessionId\":\"" + budgetSession(tenant, 1)
                                + "\",\"input\":[" + emojiBlock + "]}"))
                .andExpect(status().isAccepted());
        // 2,000,001 code points stay inside the 4,000,000 aggregate but are
        // 4,000,002 UTF-16 units: admitted only when the aggregate counts
        // code points too.
        String emojiThird = "{\"type\":\"input_text\",\"text\":\""
                + "\uD83D\uDE00".repeat(666_667) + "\"}";
        mvc.perform(post(WEB_SHELL + "/turns/submit").header(TENANT, tenant)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"idempotencyKey\":\"budget-emoji-sum\","
                                + "\"sessionId\":\"" + budgetSession(tenant, 2)
                                + "\",\"input\":[" + emojiThird + ","
                                + emojiThird + "," + emojiThird + "]}"))
                .andExpect(status().isAccepted());
    }

    private String budgetSession(String tenant, int index) throws Exception {
        return json(webShell(tenant, "/sessions/create",
                "{\"idempotencyKey\":\"budget-create-" + index + "\","
                        + "\"agentId\":\"qwen-code\",\"input\":[]}"))
                .get("sessionId").asText();
    }

    private static long publishedNumber(String description, String pattern,
            String schema) {
        var matcher = java.util.regex.Pattern.compile(pattern)
                .matcher(description);
        assertThat(matcher.find())
                .as("%s input description publishes %s", schema, pattern)
                .isTrue();
        return Long.parseLong(matcher.group(1).replace(",", ""));
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
        return actor(tenant, "actor-a");
    }

    private static AuthenticatedTenantActor actor(String tenant, String actorId) {
        return new AuthenticatedTenantActor() {
            @Override
            public String tenantId() {
                return tenant;
            }

            @Override
            public String actorId() {
                return actorId;
            }

            @Override
            public String getName() {
                return actorId;
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

    // D7-3, profile off (the default): asking for java_durable is refused
    // before anything is admitted, harness_confirmed answers the legacy
    // body, and no Session advertises durable_operations.
    @Test
    void javaDurableAdmissionIsRefusedWhileTheProfileIsOff() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(
                javaDurableAdmission == null);
        String tenant = "contract-durable-off-" + UUID.randomUUID();
        Map<String, String> drift = new TreeMap<>();
        String sessionId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-off-create"),
                """
                {"agent_id":"qwen-code","agent_revision":"1","input":[]}
                """)).get("id").asText();
        JsonNode session = json(exchange(drift, "getSession", 200,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant), null));
        assertThat(session.path("capabilities").has("durable_operations"))
                .isFalse();
        for (String body : List.of("""
                {"type":"agent.session.input.message","admission_profile":"java_durable",
                 "input":[{"type":"input_text","text":"refused"}]}
                """, """
                {"type":"agent.session.cancel","admission_profile":"java_durable",
                 "turn_id":"turn_absent"}
                """)) {
            assertThat(json(exchange(drift, "postSessionEvent", 400,
                    post("/v1/agents/sessions/{id}/events", sessionId)
                            .header(TENANT, tenant)
                            .header(IDEMPOTENCY_KEY, "durable-off-refused"),
                    body)).at("/error/code").asText())
                    .isEqualTo("unsupported_feature");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE"
                + " tenant_id = ?", Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE"
                + " tenant_id = ? AND operation_kind IN ('SUBMIT_INPUT', 'CANCEL')",
                Integer.class, tenant)).isZero();
        JsonNode legacy = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-off-default"),
                """
                {"type":"agent.session.input.message","admission_profile":"harness_confirmed",
                 "input":[{"type":"input_text","text":"default"}]}
                """));
        assertThat(legacy.has("operation_id")).isFalse();
        assertThat(legacy.has("admission_stage")).isFalse();
        String webSessionId = json(exchange(drift, "webShellCreateSession",
                202, post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant),
                """
                {"requestId":"durable-off","idempotencyKey":"durable-off-web",
                 "agentId":"qwen-code","title":"web","input":[]}
                """)).get("sessionId").asText();
        assertThat(json(exchange(drift, "webShellSubmitTurn", 400,
                post(WEB_SHELL + "/turns/submit").header(TENANT, tenant),
                """
                {"idempotencyKey":"durable-off-web-submit","sessionId":"%s",
                 "admissionProfile":"java_durable",
                 "input":[{"type":"input_text","text":"refused"}]}
                """.formatted(webSessionId))).at("/error/code").asText())
                .isEqualTo("unsupported_feature");
        assertThat(json(exchange(drift, "webShellCancelTurn", 400,
                post(WEB_SHELL + "/turns/cancel").header(TENANT, tenant),
                """
                {"idempotencyKey":"durable-off-web-cancel","sessionId":"%s",
                 "turnId":"turn_absent","admissionProfile":"java_durable"}
                """.formatted(webSessionId))).at("/error/code").asText())
                .isEqualTo("unsupported_feature");
        assertThat(drift).isEmpty();
    }

    // D7-3, profile on: an admission that asks for java_durable names the
    // operation it saved, before the dispatcher runs; a retry under the key
    // answers the same operation; the default stays harness_confirmed.
    @Test
    void javaDurableAdmissionNamesTheOperationItsAdmissionSaved()
            throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(
                javaDurableAdmission != null);
        String tenant = "contract-durable-on-" + UUID.randomUUID();
        Map<String, String> drift = new TreeMap<>();
        String sessionId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-on-create"),
                """
                {"agent_id":"qwen-code","agent_revision":"1","input":[]}
                """)).get("id").asText();
        assertThat(json(exchange(drift, "getSession", 200,
                get("/v1/agents/sessions/{id}", sessionId)
                        .header(TENANT, tenant), null))
                .at("/capabilities/durable_operations").asBoolean()).isTrue();
        String hold = """
                {"type":"agent.session.input.message","admission_profile":"java_durable",
                 "input":[{"type":"input_text","text":"hold"}]}
                """;
        JsonNode input = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-on-input"), hold));
        String operationId = input.get("operation_id").asText();
        assertThat(operationId).startsWith("op_");
        assertThat(input.get("admission_stage").asText())
                .isEqualTo("java_durable");
        assertThat(input.get("delivery_state").asText()).isEqualTo("pending");
        assertThat(input.get("replayed").asBoolean()).isFalse();
        String turnId = input.get("turn_id").asText();
        int cancels = awaitHeldTurn();
        // A lost response: the retry names the same operation, whatever its
        // latest stage; without the profile it keeps the legacy body.
        JsonNode retry = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-on-input"), hold));
        assertThat(retry.get("replayed").asBoolean()).isTrue();
        assertThat(retry.get("operation_id").asText()).isEqualTo(operationId);
        assertThat(retry.get("turn_id").asText()).isEqualTo(turnId);
        JsonNode legacyRetry = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-on-input"),
                """
                {"type":"agent.session.input.message",
                 "input":[{"type":"input_text","text":"hold"}]}
                """));
        assertThat(legacyRetry.get("replayed").asBoolean()).isTrue();
        assertThat(legacyRetry.has("operation_id")).isFalse();
        JsonNode cancel = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", sessionId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-on-cancel"),
                """
                {"type":"agent.session.cancel","admission_profile":"java_durable",
                 "turn_id":"%s"}
                """.formatted(turnId)));
        String cancelId = cancel.get("operation_id").asText();
        assertThat(cancelId).startsWith("op_").isNotEqualTo(operationId);
        assertThat(cancel.get("admission_stage").asText())
                .isEqualTo("java_durable");
        assertThat(cancel.get("delivery_state").asText()).isEqualTo("pending");
        settleCancelledTurn(tenant, sessionId, cancels);
        // Each id resolves through the operation query to its own command.
        for (var expected : Map.of(operationId, "submit_input", cancelId,
                "cancel").entrySet()) {
            JsonNode operation = json(exchange(drift, "getSessionCwdOperation",
                    200, get("/v1/agents/sessions/{id}/operations/{op}",
                            sessionId, expected.getKey())
                            .header(TENANT, tenant), null));
            assertThat(operation.get("type").asText())
                    .isEqualTo(expected.getValue());
            assertThat(operation.get("status").asText()).isEqualTo("completed");
        }
        // harness_confirmed stays the default with the profile on. The
        // fixture Harness serves one Turn per Session, so it gets its own.
        String plainId = json(exchange(drift, "createSession", 202,
                post("/v1/agents/sessions").header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-on-plain-create"),
                """
                {"agent_id":"qwen-code","agent_revision":"1","input":[]}
                """)).get("id").asText();
        JsonNode plain = json(exchange(drift, "postSessionEvent", 202,
                post("/v1/agents/sessions/{id}/events", plainId)
                        .header(TENANT, tenant)
                        .header(IDEMPOTENCY_KEY, "durable-on-plain"),
                """
                {"type":"agent.session.input.message",
                 "input":[{"type":"input_text","text":"plain"}]}
                """));
        assertThat(plain.has("operation_id")).isFalse();
        assertThat(plain.has("admission_stage")).isFalse();
        awaitIdle(tenant, plainId);
        String webSessionId = json(exchange(drift, "webShellCreateSession",
                202, post(WEB_SHELL + "/sessions/create")
                        .header(TENANT, tenant),
                """
                {"requestId":"durable-on","idempotencyKey":"durable-on-web",
                 "agentId":"qwen-code","title":"web","input":[]}
                """)).get("sessionId").asText();
        JsonNode web = json(exchange(drift, "webShellSubmitTurn", 202,
                post(WEB_SHELL + "/turns/submit").header(TENANT, tenant),
                """
                {"idempotencyKey":"durable-on-web-submit","sessionId":"%s",
                 "admissionProfile":"java_durable",
                 "input":[{"type":"input_text","text":"web"}]}
                """.formatted(webSessionId)));
        assertThat(web.get("operationId").asText()).startsWith("op_");
        assertThat(web.get("admissionStage").asText()).isEqualTo("java_durable");
        assertThat(web.get("deliveryState").asText()).isEqualTo("pending");
        awaitIdle(tenant, webSessionId);
        assertThat(drift).isEmpty();
    }

    private String exchange(Map<String, String> drift, String operationId,
            int expectedStatus, MockHttpServletRequestBuilder request,
            String body) throws Exception {
        return exchange(mvc, drift, operationId, expectedStatus, request, body);
    }

    private String exchange(MockMvc target, Map<String, String> drift, String operationId,
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
        MockHttpServletResponse response = target.perform(request).andReturn()
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
                .isGreaterThanOrEqualTo(floor);
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

    private String turnCommandOperation(String sessionId, String kind) {
        return jdbc.queryForObject("SELECT operation_id FROM ma_operation"
                + " WHERE session_id = ? AND operation_kind = ?", String.class,
                sessionId, kind);
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
