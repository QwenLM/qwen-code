package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.ManagedArtifactController;
import com.alibaba.qwen.code.managedagent.api.RequestIdFilter;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceDiscoveryController;
import com.alibaba.qwen.code.managedagent.artifact.ManagedArtifactService;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCreationStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.repository.ManagedToolResultStore;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceDiscoveryService;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceActor;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The workspace artifact page against real projected rows: the fixture's
 * session-1 artifacts stay available, while additional sessions are seeded
 * as projected-shaped rows whose bytes were never published — the retired
 * state retention produces. Listing, ordering, visibility, admission, and
 * cursor behavior are asserted through the mounted WebShell route.
 */
class ManagedWorkspaceArtifactApiIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TENANT = "tenant-1";
    private static final String WORKSPACE = "workspace-1";
    private static final String ROUTE = "/api/agent/web-shell/v1/workspaces/artifacts/query";
    ToolPublicationStoreTest.ApiFixture fixture;
    MockMvc mvc;
    JsonNode stdout;
    JsonNode stderr;
    String realOperationSource;

    protected javax.sql.DataSource dataSource() {
        return null;
    }

    @BeforeEach
    void setup() {
        var source = dataSource();
        fixture = source == null ? ToolPublicationStoreTest.apiFixture() : ToolPublicationStoreTest.apiFixture(source);
        fixture.jdbc().update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, ?, 1, 'storage-1', 'Test', 'config', 'policy', 'ACTIVE')", TENANT, WORKSPACE);
        for (String actor : new String[] {"reader", "metadata-reader", "owner"}) {
            fixture.jdbc().update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id,"
                    + " role) VALUES (?, ?, ?, 'READER')", TENANT, WORKSPACE,
                    actor.getBytes(StandardCharsets.UTF_8));
        }
        var registry = new JdbcManagedWorkspaceRegistry(fixture.jdbc());
        var sessions = new ManagedAgentService(fixture.sessions(), new RequestDigests(),
                mock(HarnessCoordinator.class), mock(HarnessConnector.class), registry,
                new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        ManagedArtifactPolicy policy = new ManagedArtifactPolicy() {
            public String version() { return fixture.policy().version(); }
            public boolean publishOriginal(String tenant, String workspace, String session) { return true; }
            public boolean publishPreview(String tenant, String workspace, String session) { return true; }
            public boolean readOriginal(String tenant, String actor, String workspace, String session) {
                return "reader".equals(actor) && !"session-2".equals(session);
            }
        };
        mvc = mvc(new ManagedArtifactService(sessions, fixture.results(), fixture.reader(),
                policy, fixture.properties(), registry));
        var artifacts = fixture.results().listArtifacts(TENANT, "session-1", null, null, null, 100).artifacts();
        stdout = artifacts.stream().filter(a -> "stdout".equals(a.streamId())).findFirst().orElseThrow().descriptor();
        stderr = artifacts.stream().filter(a -> "stderr".equals(a.streamId())).findFirst().orElseThrow().descriptor();
        realOperationSource = fixture.jdbc().queryForObject(
                "SELECT request_json FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'"
                        + " AND session_id = ? LIMIT 1", String.class,
                "session-1".getBytes(StandardCharsets.UTF_8));
    }

    private MockMvc mvc(ManagedArtifactService service) {
        return MockMvcBuilders.standaloneSetup(new ManagedArtifactController(service))
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .setControllerAdvice(new ApiExceptionHandler())
                .setMessageConverters(new MappingJackson2HttpMessageConverter(JSON))
                .addFilters(new RequestIdFilter(), new TenantContextFilter(JSON))
                .build();
    }

    private MockHttpServletRequestBuilder query(String actor, String body) {
        return query(TENANT, actor, body);
    }

    private MockHttpServletRequestBuilder query(String tenant, String actor, String body) {
        var request = post(ROUTE).contentType(MediaType.APPLICATION_JSON).content(body)
                .header(TenantContextFilter.HEADER, tenant);
        if (actor != null) {
            request.principal(new AuthenticatedTenantActor() {
                public String getName() { return actor; }
                public String tenantId() { return tenant; }
                public String actorId() { return actor; }
            });
        }
        return request;
    }

    private JsonNode page(String actor, String body) throws Exception {
        var response = mvc.perform(query(actor, body)).andExpect(status().isOk())
                .andReturn().getResponse();
        // The filter pre-sets no-store and the controller's noStore() replaces
        // it (setHeader semantics on both sides): exactly one value.
        assertThat(response.getHeaders("Cache-Control")).containsExactly("no-store");
        return JSON.readTree(response.getContentAsString());
    }

    private static String body(String cursor, Integer limit) {
        var node = JSON.createObjectNode().put("workspaceId", WORKSPACE);
        if (cursor != null) {
            node.put("cursor", cursor);
        }
        if (limit != null) {
            node.put("limit", limit);
        }
        return node.toString();
    }

    private static List<String> ids(JsonNode page) {
        var ids = new ArrayList<String>();
        for (var row : page.path("data")) {
            ids.add(row.path("artifact").path("id").asText());
        }
        return ids;
    }

    /**
     * Seeds one session with a single projected-shaped stdout artifact by
     * cloning the fixture's real operation and artifact rows and rewriting
     * their identities. The clone has no publication receipt, so the reader
     * reports it unavailable — the state retention leaves behind.
     */
    private String seedArtifactSession(String sessionId, String workspaceId, String status,
            boolean ownerOnly, String ownerActor, String sessionKind, String operationWorkspaceId)
            throws Exception {
        return seedArtifactSession(TENANT, sessionId, workspaceId, status, ownerOnly, ownerActor,
                sessionKind, operationWorkspaceId, "READY");
    }

    private String seedArtifactSession(String tenant, String sessionId, String workspaceId, String status,
            boolean ownerOnly, String ownerActor, String sessionKind, String operationWorkspaceId,
            String operationState) throws Exception {
        byte[] creatorKey = new WorkspaceActor(tenant, "creator").getActorId().getBytes(StandardCharsets.UTF_8);
        byte[] ownerKey = ownerActor == null ? null
                : new WorkspaceActor(tenant, ownerActor).getActorId().getBytes(StandardCharsets.UTF_8);
        if (workspaceId == null) {
            fixture.jdbc().update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                    + " gmt_create, gmt_modified, creator_actor_key, owner_actor_key, owner_only, session_kind)"
                    + " VALUES (?, ?, 'qwen-code', ?, 1, 1, ?, ?, ?, ?)",
                    tenant, sessionId, status, creatorKey, ownerKey, ownerOnly ? 1 : 0, sessionKind);
        } else {
            fixture.jdbc().update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                    + " gmt_create, gmt_modified, workspace_id, workspace_generation, workspace_storage_id,"
                    + " cwd_relative, context_config_ref, context_revision, workspace_config_ref,"
                    + " workspace_policy_ref, creator_actor_key, owner_actor_key, owner_only, session_kind)"
                    + " VALUES (?, ?, 'qwen-code', ?, 1, 1, ?, 1, 'storage-1', '.', 'config', 1, 'config',"
                    + " 'policy', ?, ?, ?, ?)",
                    tenant, sessionId, status, workspaceId, creatorKey, ownerKey, ownerOnly ? 1 : 0, sessionKind);
        }
        String resultId = "result-" + sessionId;
        String scope = ManagedToolResultStore.identity("s", tenant, sessionId).substring(2);
        ObjectNode source = (ObjectNode) JSON.readTree(realOperationSource);
        source.put("id", resultId);
        source.put("sessionId", sessionId);
        source.put("workspaceId", operationWorkspaceId);
        fixture.jdbc().update("INSERT INTO ma_operation (operation_key, scope_key, operation_id,"
                + " operation_kind, tenant_id, session_id, workspace_id, target_kind, target_key,"
                + " request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                + " SELECT ?, ?, ?, operation_kind, ?, ?, ?, target_kind, target_key,"
                + " request_digest, ?, ?, phase, gmt_create, gmt_modified FROM ma_operation"
                + " WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND session_id = ? LIMIT 1",
                DigestUtils.sha256Hex("op-" + sessionId), scope, resultId, tenant, sessionId,
                operationWorkspaceId, source.toString(), operationState,
                "session-1".getBytes(StandardCharsets.UTF_8));
        String artifactId = "artifact_" + DigestUtils.sha256Hex(sessionId);
        ObjectNode descriptor = (ObjectNode) stdout.deepCopy();
        descriptor.put("id", artifactId);
        descriptor.put("session_id", sessionId);
        descriptor.put("result_id", resultId);
        fixture.jdbc().update("INSERT INTO ma_artifact (artifact_id, result_id, scope_key,"
                + " descriptor_json, publication_id, binding_json, manifest_ref_json, stream_id,"
                + " creation_sequence) SELECT ?, ?, ?, ?, publication_id, binding_json, manifest_ref_json,"
                + " stream_id, creation_sequence FROM ma_artifact WHERE artifact_id = ? LIMIT 1",
                artifactId, resultId, scope, descriptor.toString(), stdout.path("id").asText());
        return artifactId;
    }

    @Test
    void listsArtifactsAcrossSessionsNewestFirstWithSessionIdentity() throws Exception {
        String second = seedArtifactSession("session-2", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        var page = page("reader", body(null, null));
        assertThat(ids(page)).hasSize(3);
        var first = page.path("data").get(0);
        assertThat(first.path("artifact").path("id").asText()).isEqualTo(second);
        assertThat(first.path("artifact").path("session_id").asText()).isEqualTo("session-2");
        assertThat(first.path("artifact").path("availability").asText()).isEqualTo("unavailable");
        assertThat(first.path("access").path("can_read_content").asBoolean()).isFalse();
        for (int index = 1; index < 3; index++) {
            var row = page.path("data").get(index);
            assertThat(row.path("artifact").path("session_id").asText()).isEqualTo("session-1");
            assertThat(row.path("artifact").path("availability").asText()).isEqualTo("available");
            assertThat(row.path("access").path("can_read_content").asBoolean()).isTrue();
        }
        assertThat(ids(page).subList(1, 3)).containsExactlyInAnyOrder(
                stdout.path("id").asText(), stderr.path("id").asText());
        assertThat(page.path("hasMore").asBoolean()).isFalse();
        assertThat(page.path("nextCursor").isNull()).isTrue();
        var other = page("metadata-reader", body(null, null));
        assertThat(other.path("data").get(1).path("access").path("can_read_content").asBoolean()).isFalse();
    }

    @Test
    void paginatesWithAStableCursorThatFreezesTheFirstPageWindow() throws Exception {
        seedArtifactSession("session-2", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        var first = page("reader", body(null, 1));
        assertThat(first.path("data")).hasSize(1);
        assertThat(first.path("hasMore").asBoolean()).isTrue();
        String cursor = first.path("nextCursor").asText();
        String late = seedArtifactSession("session-3", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        var walked = new ArrayList<String>(ids(first));
        while (true) {
            var next = page("reader", body(cursor, 1));
            assertThat(next.path("data")).hasSize(1);
            walked.addAll(ids(next));
            if (!next.path("hasMore").asBoolean()) {
                assertThat(next.path("nextCursor").isNull()).isTrue();
                break;
            }
            cursor = next.path("nextCursor").asText();
        }
        assertThat(walked).hasSize(3).doesNotHaveDuplicates().doesNotContain(late);
        var fresh = page("reader", body(null, null));
        assertThat(ids(fresh)).hasSize(4);
        assertThat(ids(fresh).getFirst()).isEqualTo(late);
    }

    @Test
    void filtersRowsBySessionVisibilityAndBinding() throws Exception {
        String visible = seedArtifactSession("session-ok", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        String privateId = seedArtifactSession("session-private", WORKSPACE, "ACTIVE", true, "owner", "PUBLIC", WORKSPACE);
        seedArtifactSession("session-deleting", WORKSPACE, "DELETING", false, null, "PUBLIC", WORKSPACE);
        seedArtifactSession("session-deleted", WORKSPACE, "DELETED", false, null, "PUBLIC", WORKSPACE);
        String archived = seedArtifactSession("session-archived", WORKSPACE, "ARCHIVED", false, null, "PUBLIC", WORKSPACE);
        seedArtifactSession("session-legacy", null, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        seedArtifactSession("session-control", WORKSPACE, "ACTIVE", false, null, "CONTROL", WORKSPACE);
        String drifted = seedArtifactSession("session-drift", WORKSPACE, "ACTIVE", false, null, "PUBLIC", "workspace-2");
        var reader = ids(page("reader", body(null, 100)));
        assertThat(reader).contains(visible, archived, stdout.path("id").asText(), stderr.path("id").asText());
        assertThat(reader).doesNotContain(privateId, drifted);
        assertThat(reader).hasSize(4);
        assertThat(ids(page("owner", body(null, 100)))).contains(privateId);
        fixture.jdbc().update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace-2', 1, 'storage-2', 'Other', 'config', 'policy', 'ACTIVE')", TENANT);
        fixture.jdbc().update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id,"
                + " role) VALUES (?, 'workspace-2', ?, 'READER')", TENANT,
                "reader".getBytes(StandardCharsets.UTF_8));
        var other = page("reader", "{\"workspaceId\":\"workspace-2\"}");
        assertThat(other.path("data")).isEmpty();
        assertThat(ids(page("reader", body(null, 100)))).doesNotContain(drifted);
    }

    @Test
    void refusesAnonymousStrangerAndUnknownWorkspaceBeforeValidation() throws Exception {
        mvc.perform(query(null, body(null, null)))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("actor_required"));
        mvc.perform(query("stranger", body(null, null)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("workspace_not_found"));
        mvc.perform(query("reader", "{\"workspaceId\":\"workspace-missing\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("workspace_not_found"));
        // Admission outranks input validation: an invalid limit or cursor
        // never reaches the validator for a refused actor.
        mvc.perform(query("stranger", body(null, 0)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("workspace_not_found"));
        mvc.perform(query(null, body("!!!", null)))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("actor_required"));
    }

    @Test
    void doesNotLeakArtifactsFromAnotherTenant() throws Exception {
        fixture.jdbc().update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant-2', ?, 1, 'storage-1', 'Other tenant', 'config', 'policy', 'ACTIVE')",
                WORKSPACE);
        fixture.jdbc().update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id,"
                + " role) VALUES ('tenant-2', ?, ?, 'READER')", WORKSPACE,
                "reader".getBytes(StandardCharsets.UTF_8));
        String foreign = seedArtifactSession("tenant-2", "session-foreign", WORKSPACE, "ACTIVE",
                false, null, "PUBLIC", WORKSPACE, "READY");
        // Positive control: the row is visible inside its own tenant.
        var own = JSON.readTree(mvc.perform(query("tenant-2", "reader", body(null, null)))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertThat(ids(own)).containsExactly(foreign);
        assertThat(ids(page("reader", body(null, 100)))).doesNotContain(foreign).hasSize(2);
    }

    @Test
    void excludesProjectionsThatAreNotReady() throws Exception {
        String pending = seedArtifactSession(TENANT, "session-pending", WORKSPACE, "ACTIVE",
                false, null, "PUBLIC", WORKSPACE, "PENDING");
        assertThat(ids(page("reader", body(null, 100)))).doesNotContain(pending).hasSize(2);
        fixture.jdbc().update("UPDATE ma_operation SET state = 'READY' WHERE operation_id = ?",
                "result-session-pending");
        assertThat(ids(page("reader", body(null, 100)))).contains(pending);
    }

    @Test
    void rejectsInvalidLimitsCursorsAndUnknownFields() throws Exception {
        for (int limit : new int[] {0, 101}) {
            mvc.perform(query("reader", body(null, limit)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_limit"));
        }
        String valid = Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", 10).put("before", 5)
                        .toString().getBytes(StandardCharsets.UTF_8));
        var invalid = new ArrayList<String>();
        invalid.add("!!!not-base64!!!");
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{}".getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "other")
                        .put("workspace", WORKSPACE).put("watermark", 10).put("before", 5)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", "other").put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", 10).put("before", 5)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", "workspace-2").put("watermark", 10).put("before", 5)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", 5).put("before", 10)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", -1).put("before", 0)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 2).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", 10).put("before", 5)
                        .put("extra", 1).toString().getBytes(StandardCharsets.UTF_8)));
        // Isolated guards: a six-field v=2 cursor reaches the version check
        // (the extra-field case above is rejected by the size check first);
        // non-numeric watermark AND before each reach their canConvertToLong
        // guard (the sibling field stays in range so dropping either guard
        // would answer 200 with an empty page, not trip a range disjunct);
        // a negative before with a valid watermark reaches before < 0.
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 2).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", 10).put("before", 5)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", true).put("before", 0)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", 10).put("before", true)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add(Base64.getUrlEncoder().withoutPadding().encodeToString(
                JSON.createObjectNode().put("v", 1).put("tenant", TENANT).put("actor", "reader")
                        .put("workspace", WORKSPACE).put("watermark", 10).put("before", -1)
                        .toString().getBytes(StandardCharsets.UTF_8)));
        invalid.add("a".repeat(2049));
        for (String cursor : invalid) {
            mvc.perform(query("reader", body(cursor, null)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_cursor"));
        }
        mvc.perform(query("reader", body(valid, null))).andExpect(status().isOk());
        mvc.perform(query("reader", "{\"workspaceId\":\"" + WORKSPACE + "\",\"extra\":1}"))
                .andExpect(status().isBadRequest());
        // The bare body is rejected by the workspace constraint before
        // cursor parsing; a null cursor with a valid workspace is the first
        // page, not an error.
        mvc.perform(query("reader", "{\"cursor\":null}"))
                .andExpect(status().isBadRequest());
        mvc.perform(query("reader", "{\"workspaceId\":\"" + WORKSPACE + "\",\"cursor\":null}"))
                .andExpect(status().isOk());
    }

    @Test
    void answersArtifactNotFoundWhenDeploymentReadsAreOff() throws Exception {
        fixture.properties().getArtifacts().setEnabled(false);
        try {
            mvc.perform(query("reader", body(null, null)))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.error.code").value("artifact_not_found"));
        } finally {
            fixture.properties().getArtifacts().setEnabled(true);
        }
    }

    @Test
    void rechecksTheWorkspaceGrantOnlyWhenARowIsUnavailable() throws Exception {
        var registry = spy(new JdbcManagedWorkspaceRegistry(fixture.jdbc()));
        // Admission admits both requests; only the second request's
        // re-check (triggered by its unavailable row) refuses. doReturn,
        // not when: stubbing a spy via when() would itself invoke canRead.
        doReturn(true, true, false).when(registry).canRead(TENANT, "reader", WORKSPACE);
        var sessions = new ManagedAgentService(fixture.sessions(), new RequestDigests(),
                mock(HarnessCoordinator.class), mock(HarnessConnector.class), registry,
                new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        var guarded = mvc(new ManagedArtifactService(sessions, fixture.results(), fixture.reader(),
                fixture.policy(), fixture.properties(), registry));
        // Available rows only: the single admission check admits the page,
        // and no re-check fires — an unconditional re-check would consume a
        // second stub value here and fail this count.
        guarded.perform(query("reader", body(null, null))).andExpect(status().isOk());
        verify(registry, times(1)).canRead(TENANT, "reader", WORKSPACE);
        seedArtifactSession("session-2", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        // An unavailable row triggers the re-check, which now refuses.
        guarded.perform(query("reader", body(null, null)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("workspace_not_found"));
        verify(registry, times(3)).canRead(TENANT, "reader", WORKSPACE);
    }

    @Test
    void readsAvailabilityOnceAcrossSessionsThatShareAPublicationId() throws Exception {
        String second = seedArtifactSession("session-2", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        String third = seedArtifactSession("session-3", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        String publicationId = fixture.results().findArtifact(TENANT, "session-1", stdout.path("id").asText())
                .orElseThrow().publicationId();
        String scope = DigestUtils.sha256Hex(
                JSON.createArrayNode().add(TENANT).add(WORKSPACE).add("session-2").toString());
        fixture.jdbc().update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                + " capture_bytes, producer_bytes, admission_bytes, producer_phase, admission_resource_id,"
                + " receipt_revision, receipt_sequence, is_quarantined)"
                + " SELECT ?, tenant_key, tenant_id, workspace_id, ?, publication_id, execution_key, capture_id,"
                + " binding_json, binding_digest, token_hash, state, capture_bytes, producer_bytes, admission_bytes,"
                + " producer_phase, admission_resource_id, receipt_revision, receipt_sequence, is_quarantined"
                + " FROM ma_output_capture WHERE publication_id = ?",
                scope, "session-2", publicationId);
        var jdbc = spy(fixture.jdbc());
        ReflectionTestUtils.setField(fixture.publications(), "jdbc", jdbc);

        var response = page("reader", body(null, null));
        assertThat(ids(response)).containsExactlyInAnyOrder(second, third,
                stdout.path("id").asText(), stderr.path("id").asText());
        for (var row : response.required("data")) {
            var artifact = row.required("artifact");
            boolean available = !third.equals(artifact.required("id").asText());
            assertThat(artifact.required("availability").asText()).isEqualTo(available ? "available" : "unavailable");
            assertThat(row.required("access").required("can_read_content").booleanValue())
                    .isEqualTo("session-1".equals(artifact.required("session_id").asText()));
        }
        verify(jdbc).query(ArgumentMatchers.contains("FROM ma_output_capture"),
                ArgumentMatchers.any(RowMapper.class), ArgumentMatchers.any(Object[].class));
    }

    @Test
    void bindsTheCursorToItsActor() throws Exception {
        seedArtifactSession("session-2", WORKSPACE, "ACTIVE", false, null, "PUBLIC", WORKSPACE);
        var first = page("reader", body(null, 1));
        String cursor = first.path("nextCursor").asText();
        mvc.perform(query("metadata-reader", body(cursor, null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_cursor"));
    }

    @Test
    void answersAnEmptyPageForAWorkspaceWithoutArtifacts() throws Exception {
        fixture.jdbc().update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace-empty', 1, 'storage-e', 'Empty', 'config', 'policy', 'ACTIVE')", TENANT);
        fixture.jdbc().update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id,"
                + " role) VALUES (?, 'workspace-empty', ?, 'READER')", TENANT,
                "reader".getBytes(StandardCharsets.UTF_8));
        var page = page("reader", "{\"workspaceId\":\"workspace-empty\"}");
        assertThat(page.path("data")).isEmpty();
        assertThat(page.path("hasMore").asBoolean()).isFalse();
        assertThat(page.path("nextCursor").isNull()).isTrue();
    }

    @Test
    void gatesTheArtifactLibraryCapabilityOnSettingsAndReaderSupport() throws Exception {
        var reader = mock(ManagedArtifactReader.class);
        when(reader.supported()).thenReturn(true);
        var discovery = new WorkspaceDiscoveryController(
                new WorkspaceDiscoveryService(new JdbcManagedWorkspaceRegistry(fixture.jdbc()), JSON),
                mock(WorkspaceCreationStore.class), fixture.properties(), reader);
        var discoveryMvc = MockMvcBuilders.standaloneSetup(discovery)
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .setControllerAdvice(new ApiExceptionHandler())
                .setMessageConverters(new MappingJackson2HttpMessageConverter(JSON))
                .addFilters(new RequestIdFilter(), new TenantContextFilter(JSON))
                .build();
        var request = post("/api/agent/web-shell/v1/workspaces/query")
                .contentType(MediaType.APPLICATION_JSON).content("{}")
                .header(TenantContextFilter.HEADER, TENANT)
                .principal(new AuthenticatedTenantActor() {
                    public String getName() { return "reader"; }
                    public String tenantId() { return TENANT; }
                    public String actorId() { return "reader"; }
                });
        discoveryMvc.perform(request).andExpect(status().isOk())
                .andExpect(jsonPath("$.capabilities.workspaceArtifactLibrary").value(true));
        fixture.properties().getArtifacts().setEnabled(false);
        try {
            discoveryMvc.perform(request).andExpect(status().isOk())
                    .andExpect(jsonPath("$.capabilities.workspaceArtifactLibrary").value(false));
        } finally {
            fixture.properties().getArtifacts().setEnabled(true);
        }
        when(reader.supported()).thenReturn(false);
        discoveryMvc.perform(request).andExpect(status().isOk())
                .andExpect(jsonPath("$.capabilities.workspaceArtifactLibrary").value(false));
    }

    @Test
    void theWorkspacePagePredicateHasAnIndexAccessPath() throws Exception {
        try (var connection = fixture.jdbc().getDataSource().getConnection();
                var rows = connection.getMetaData()
                        .getIndexInfo(null, null, "ma_operation", false, false)) {
            var columns = new ArrayList<String>();
            while (rows.next()) {
                if ("idx_ma_operation_workspace".equalsIgnoreCase(rows.getString("INDEX_NAME"))) {
                    columns.add(rows.getString("COLUMN_NAME").toLowerCase(java.util.Locale.ROOT));
                }
            }
            assertThat(columns).containsExactly("workspace_id", "operation_kind", "state", "id");
        }
    }
}
