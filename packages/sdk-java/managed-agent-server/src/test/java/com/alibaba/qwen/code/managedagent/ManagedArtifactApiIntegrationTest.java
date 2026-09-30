package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.ManagedArtifactController;
import com.alibaba.qwen.code.managedagent.api.RequestIdFilter;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.service.ManagedArtifactService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;

class ManagedArtifactApiIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ROOT = "/v1/agents/sessions/session-1";
    private ToolPublicationStoreTest.ApiFixture fixture;
    private ManagedAgentService sessions;
    private MockMvc mvc;
    private JsonNode stdout;
    private JsonNode stderr;
    private String itemId;

    @BeforeEach
    void setup() {
        String mysql = System.getProperty("qwen.o3.mysql.url");
        fixture = mysql == null ? ToolPublicationStoreTest.apiFixture()
                : ToolPublicationStoreTest.apiFixture(new DriverManagerDataSource(mysql,
                        System.getProperty("qwen.o3.mysql.user", "root"),
                        System.getProperty("qwen.o3.mysql.password", "")));
        configureApi();
        var artifacts = fixture.results().listArtifacts("tenant-1", "session-1", null, null, null, 100).artifacts();
        stdout = artifacts.stream().filter(a -> "stdout".equals(a.streamId())).findFirst().orElseThrow().descriptor();
        stderr = artifacts.stream().filter(a -> "stderr".equals(a.streamId())).findFirst().orElseThrow().descriptor();
        itemId = fixture.sessions().findSnapshot("tenant-1", "session-1").orElseThrow()
                .items().getFirst().itemId();
    }

    private void configureApi() {
        fixture.jdbc().update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant-1', 'workspace-1', 1, 'storage-1', 'Test', 'config', 'policy', 'ACTIVE')");
        for (String actor : new String[] {"reader", "metadata-reader"}) {
            fixture.jdbc().update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id,"
                    + " can_read, can_create) VALUES ('tenant-1', 'workspace-1', ?, TRUE, FALSE)",
                    actor.getBytes(StandardCharsets.UTF_8));
        }
        sessions = new ManagedAgentService(fixture.sessions(), new RequestDigests(),
                mock(HarnessCoordinator.class), mock(HarnessConnector.class),
                new ManagedWorkspaceRegistry(fixture.jdbc()));
        var context = new org.springframework.context.annotation.AnnotationConfigApplicationContext();
        context.registerBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class,
                fixture::properties);
        context.registerBean(com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader.class,
                fixture::reader);
        context.registerBean(ManagedAgentService.class, () -> sessions);
        context.refresh();
        context.close();
        ManagedArtifactPolicy policy = new ManagedArtifactPolicy() {
            public String version() { return fixture.policy().version(); }
            public boolean publishOriginal(String tenant, String workspace, String session) { return true; }
            public boolean publishPreview(String tenant, String workspace, String session) { return true; }
            public boolean readOriginal(String tenant, String actor, String workspace, String session) {
                return "reader".equals(actor);
            }
        };
        var service = new ManagedArtifactService(sessions, fixture.results(), fixture.reader(),
                policy, fixture.properties());
        mvc = MockMvcBuilders.standaloneSetup(new ManagedArtifactController(service))
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .setControllerAdvice(new ApiExceptionHandler())
                .setMessageConverters(new MappingJackson2HttpMessageConverter(JSON))
                .addFilters(new RequestIdFilter(), new TenantContextFilter(JSON)).build();
    }

    @Test
    void advertisesConfiguredArtifactReadsUntilSessionDeletion() {
        assertThat(sessions.getPublicSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isTrue();
        assertThat(sessions.getWebShellSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isTrue();
        fixture.jdbc().update("UPDATE managed_agent_session SET status = 'DELETING' WHERE session_id = 'session-1'");
        assertThat(sessions.getPublicSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isFalse();
        assertThat(sessions.getWebShellSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isFalse();
    }

    @Test
    void exposesOriginalCommittedBytesAfterWriterSealAndSessionClose() throws Exception {
        new TransactionTemplate(fixture.manager()).executeWithoutResult(ignored ->
                new ManagedSessionStore(fixture.jdbc()).sealWriter("tenant-1", "session-1", "a".repeat(32),
                        new SealWriterRequest("workspace-1", "writer-1", 1)));
        assertThat(fixture.jdbc().queryForObject("SELECT state FROM qwen_managed_session_journal_head", String.class))
                .isEqualTo("SEALED");
        assertThat(fixture.sessions().requireSession("tenant-1", "session-1").status()).isEqualTo("CLOSED");

        var result = mvc.perform(asReader(get(ROOT + "/items/" + itemId + "/tool-result")))
                .andExpect(status().isOk()).andExpect(jsonPath("$.result.turn_id").value("turn_public_1"))
                .andExpect(jsonPath("$.result.execution_status").value("success"))
                .andExpect(jsonPath("$.result.capture_status").value("complete"))
                .andExpect(jsonPath("$.result.delivery_status").value("committed"))
                .andExpect(jsonPath("$.access.can_read_content").value(true))
                .andExpect(response -> schema("WebShellToolResultResponse", response.getResponse().getContentAsString()))
                .andReturn().getResponse().getContentAsString();
        assertThat(result).doesNotContain("publicationId", "manifestRef", "object_key", "writerToken", "runtime-call-1");
        var list = mvc.perform(asReader(get(ROOT + "/artifacts"))).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(2))
                .andExpect(response -> schema("PublicArtifactList", response.getResponse().getContentAsString()))
                .andReturn().getResponse().getContentAsString();
        mvc.perform(asReader(bytes(stdout)).header("Range", "bytes=1-2")
                        .header("If-Match", "\"" + stdout.path("sha256").asText() + "\""))
                .andExpect(status().isPartialContent()).andExpect(content().bytes(new byte[] {'b', 'c'}))
                .andExpect(header().string("Content-Range", "bytes 1-2/3"))
                .andExpect(header().string("Content-Length", "2"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Cache-Control", "private, no-store, no-transform"));
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isOk())
                .andExpect(content().bytes("abc".getBytes(StandardCharsets.UTF_8)))
                .andExpect(header().exists("Repr-Digest"));
        mvc.perform(asReader(bytes(stderr))).andExpect(status().isOk()).andExpect(content().bytes(new byte[0]))
                .andExpect(header().string("Content-Length", "0"));
        mvc.perform(asReader(bytes(stdout)).header("If-Match", "\"outdated\""))
                .andExpect(status().isPreconditionFailed());
        mvc.perform(asReader(bytes(stdout)).header("Range", "bytes=3-"))
                .andExpect(status().isRequestedRangeNotSatisfiable()).andExpect(header().string("Content-Range", "bytes */3"));
        assertThat(fixture.jdbc().queryForObject("SELECT state FROM qwen_managed_session_journal_head", String.class))
                .isEqualTo("SEALED");
        assertThat(fixture.sessions().findEvents("tenant-1", "session-1", 0, 100)).hasSize(1);

        String output = System.getProperty("qwen.o3.fixture-output");
        if (output != null) {
            var fixtureJson = JSON.createObjectNode();
            fixtureJson.set("toolResult", JSON.readTree(result));
            fixtureJson.set("artifactList", JSON.readTree(list));
            fixtureJson.set("transcript", JSON.valueToTree(sessions.transcript("tenant-1", "reader", "session-1", null, 100)));
            String before = Long.toString(fixture.sessions().requireSession("tenant-1", "session-1").lastSequence() + 1);
            fixtureJson.set("events", JSON.valueToTree(sessions.transcript("tenant-1", "reader", "session-1", before, 100).events()));
            Files.writeString(Path.of(output), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(fixtureJson));
        }
    }

    @Test
    void distinguishesTrustedActorWorkspaceGrantAndOriginalContentPolicy() throws Exception {
        mvc.perform(bytes(stdout).header(TenantContextFilter.HEADER, "tenant-1"))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.code").value("actor_required"));
        mvc.perform(asActor(bytes(stdout), "tenant-1", "no-grant"))
                .andExpect(status().isNotFound()).andExpect(header().doesNotExist("ETag"));
        mvc.perform(asActor(bytes(stdout), "other-tenant", "reader"))
                .andExpect(status().isNotFound());
        mvc.perform(asReader(get("/v1/agents/sessions/other-session/artifacts/" + stdout.path("id").asText())))
                .andExpect(status().isNotFound());
        mvc.perform(asActor(get(ROOT + "/artifacts/" + stdout.path("id").asText()), "tenant-1", "metadata-reader"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.access.can_read_content").value(false))
                .andExpect(response -> schema("WebShellArtifactResponse", response.getResponse().getContentAsString()));
        mvc.perform(asActor(bytes(stdout), "tenant-1", "metadata-reader").header("Range", "malformed"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("artifact_content_forbidden"))
                .andExpect(header().doesNotExist("Content-Range"));
        fixture.jdbc().update("UPDATE managed_workspace_access SET can_read = FALSE WHERE actor_id = ?",
                "reader".getBytes(StandardCharsets.UTF_8));
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isNotFound());
    }

    @Test
    void webShellRoutesUseTheSameStoredResultsAndBoundedCursor() throws Exception {
        mvc.perform(asReader(post("/api/agent/web-shell/v1/tool-results/get"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(JSON.writeValueAsString(java.util.Map.of("sessionId", "session-1", "itemId", itemId))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.result.item_id").value(itemId))
                .andExpect(response -> schema("WebShellToolResultResponse", response.getResponse().getContentAsString()));
        mvc.perform(asReader(post("/api/agent/web-shell/v1/artifacts/get"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(JSON.writeValueAsString(java.util.Map.of("sessionId", "session-1", "artifactId", stdout.path("id").asText()))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.artifact.byte_length").value(3))
                .andExpect(response -> schema("WebShellArtifactResponse", response.getResponse().getContentAsString()));
        var first = mvc.perform(asReader(post("/api/agent/web-shell/v1/artifacts/query"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"sessionId\":\"session-1\",\"limit\":1}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.hasMore").value(true))
                .andExpect(response -> schema("WebShellArtifactPage", response.getResponse().getContentAsString())).andReturn();
        JsonNode firstPage = JSON.readTree(first.getResponse().getContentAsString());
        var second = mvc.perform(asReader(post("/api/agent/web-shell/v1/artifacts/query"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(JSON.writeValueAsString(java.util.Map.of("sessionId", "session-1", "limit", 1,
                                "cursor", firstPage.path("nextCursor").asText()))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.hasMore").value(false))
                .andExpect(response -> schema("WebShellArtifactPage", response.getResponse().getContentAsString())).andReturn();
        assertThat(JSON.readTree(second.getResponse().getContentAsString()).path("data").get(0).path("artifact").path("id"))
                .isNotEqualTo(firstPage.path("data").get(0).path("artifact").path("id"));
    }

    @Test
    void quarantineBeforeFirstProjectionPreservesExecutionFactsWithoutContent() throws Exception {
        fixture = ToolPublicationStoreTest.quarantinedApiFixture();
        configureApi();
        mvc.perform(asReader(get(ROOT + "/items/" + itemId + "/tool-result")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.result.execution_status").value("success"))
                .andExpect(jsonPath("$.result.capture_status").value("complete"))
                .andExpect(jsonPath("$.result.delivery_status").value("committed"))
                .andExpect(jsonPath("$.result.artifacts").isEmpty())
                .andExpect(jsonPath("$.result.preview").doesNotExist())
                .andExpect(jsonPath("$.access.can_read_content").value(false));
        mvc.perform(asReader(get(ROOT + "/artifacts"))).andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isEmpty());
        assertThat(fixture.jdbc().queryForObject("SELECT quarantined FROM qwen_tool_publication", Boolean.class))
                .isTrue();
    }

    @Test
    void deletionAndQuarantineHideContentWithoutChangingExecutionFacts() throws Exception {
        fixture.jdbc().update("UPDATE qwen_tool_publication SET quarantined = TRUE WHERE publication_id = 'pub-1'");
        mvc.perform(asReader(get(ROOT + "/artifacts/" + stdout.path("id").asText())))
                .andExpect(status().isOk()).andExpect(jsonPath("$.artifact.availability").value("unavailable"))
                .andExpect(jsonPath("$.access.can_read_content").value(false));
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isServiceUnavailable());
        mvc.perform(asReader(get(ROOT + "/items/" + itemId + "/tool-result")))
                .andExpect(status().isOk()).andExpect(jsonPath("$.result.execution_status").value("success"));
        fixture.jdbc().update("UPDATE managed_agent_session SET status = 'DELETING' WHERE session_id = 'session-1'");
        mvc.perform(asReader(get(ROOT + "/artifacts"))).andExpect(status().isNotFound());
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isNotFound());
    }

    private static MockHttpServletRequestBuilder bytes(JsonNode artifact) {
        return get(ROOT + "/artifacts/" + artifact.path("id").asText() + "/content")
                .param("revision", artifact.path("revision").asText());
    }

    private static void schema(String name, String json) throws Exception {
        assertThat(OpenApiContract.load().validate("/components/schemas/" + name, JSON.readTree(json))).isEmpty();
    }

    private static MockHttpServletRequestBuilder asReader(MockHttpServletRequestBuilder request) {
        return asActor(request, "tenant-1", "reader");
    }

    private static MockHttpServletRequestBuilder asActor(MockHttpServletRequestBuilder request, String tenant, String actor) {
        return request.header(TenantContextFilter.HEADER, tenant).principal(new AuthenticatedTenantActor() {
            public String getName() { return actor; }
            public String tenantId() { return tenant; }
            public String actorId() { return actor; }
        });
    }
}
