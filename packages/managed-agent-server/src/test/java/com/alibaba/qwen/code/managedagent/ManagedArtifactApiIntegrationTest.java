package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.ManagedArtifactController;
import com.alibaba.qwen.code.managedagent.api.ManagedToolDetailsController;
import com.alibaba.qwen.code.managedagent.api.RequestIdFilter;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.artifact.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.artifact.ManagedArtifactService;
import com.alibaba.qwen.code.managedagent.artifact.ManagedToolDetailsService;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedToolDetailsStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ManagedArtifactApiIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ROOT = "/v1/agents/sessions/session-1";
    ToolPublicationStoreTest.ApiFixture fixture;
    ManagedAgentService sessions;
    MockMvc mvc;
    JsonNode stdout;
    JsonNode stderr;
    String itemId;

    @BeforeEach
    void setup() {
        var source = dataSource();
        fixture = source == null ? ToolPublicationStoreTest.apiFixture() : ToolPublicationStoreTest.apiFixture(source);
        configureApi();
        var artifacts = fixture.results().listArtifacts("tenant-1", "session-1", null, null, null, 100).artifacts();
        stdout = artifacts.stream().filter(a -> "stdout".equals(a.streamId())).findFirst().orElseThrow().descriptor();
        stderr = artifacts.stream().filter(a -> "stderr".equals(a.streamId())).findFirst().orElseThrow().descriptor();
        itemId = fixture.sessions().findSnapshot("tenant-1", "session-1").orElseThrow()
                .items().getFirst().itemId();
    }

    protected javax.sql.DataSource dataSource() {
        return null;
    }

    void configureApi() {
        fixture.jdbc().update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant-1', 'workspace-1', 1, 'storage-1', 'Test', 'config', 'policy', 'ACTIVE')");
        for (String actor : new String[] {"reader", "metadata-reader"}) {
            fixture.jdbc().update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id,"
                    + " role) VALUES ('tenant-1', 'workspace-1', ?, 'READER')",
                    actor.getBytes(StandardCharsets.UTF_8));
        }
        sessions = new ManagedAgentService(fixture.sessions(), new RequestDigests(),
                mock(HarnessCoordinator.class), mock(HarnessConnector.class),
                new ManagedWorkspaceRegistry(fixture.jdbc()));
        var context = new org.springframework.context.annotation.AnnotationConfigApplicationContext();
        context.registerBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class,
                fixture::properties);
        context.registerBean(com.alibaba.qwen.code.managedagent.persistence.ManagedArtifactReader.class,
                fixture::reader);
        context.registerBean(com.alibaba.qwen.code.managedagent.persistence.ManagedActionStore.class,
                () -> mock(com.alibaba.qwen.code.managedagent.persistence.ManagedActionStore.class));
        context.registerBean(java.time.Clock.class, () -> java.time.Clock.systemUTC());
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
        var details = new ManagedToolDetailsService(sessions,
                new ManagedToolDetailsStore(fixture.jdbc(), new ManagedExtensionRecordStore(fixture.jdbc()), JSON));
        mvc = MockMvcBuilders.standaloneSetup(new ManagedArtifactController(service), new ManagedToolDetailsController(details))
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .setControllerAdvice(new ApiExceptionHandler())
                .setMessageConverters(new MappingJackson2HttpMessageConverter(JSON))
                .addFilters(new RequestIdFilter(), new TenantContextFilter(JSON))
                .alwaysDo(exchange -> {
                    var response = exchange.getResponse();
                    if (response.getStatus() == 200 && response.getContentType() != null
                            && response.getContentType().startsWith("application/json")) {
                        assertThat(response.getHeader("Cache-Control")).isEqualTo("private, no-store");
                    }
                }).build();
    }

    @Test
    void readsCommittedFileErrorsWithoutAnArtifactPublication() throws Exception {
        savedDetails("read_file", "error", "Path must be relative to the Workspace.",
                JSON.createObjectNode().put("file_path", "/tmp/pr-14599.diff").put("offset", 10).put("limit", 100));
        fixture.jdbc().update("DELETE FROM ma_artifact");
        fixture.jdbc().update("DELETE FROM ma_output_capture");
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.input.file_path").value("/tmp/pr-14599.diff"))
                .andExpect(jsonPath("$.input.offset").doesNotExist())
                .andExpect(jsonPath("$.input.limit").doesNotExist())
                .andExpect(jsonPath("$.output").value("Path must be relative to the Workspace."))
                .andExpect(jsonPath("$.truncated").value(false))
                .andExpect(response -> contract("getWebShellToolDetails", "WebShellToolDetails",
                        response.getResponse().getContentAsString()));
    }

    @Test
    void preservesSavedShellTextAndDistinguishesEmptyOutput() throws Exception {
        String text = "Command: printf sentinel\nDirectory: /workspace\nOutput: sentinel\nExit Code: 0";
        savedDetails("run_shell_command", "output", text);
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.input.command").value("printf sentinel"))
                .andExpect(jsonPath("$.output").value(text));
        fixture.jdbc().update("DELETE FROM ma_resource WHERE resource_id IN (?, ?)", "details-call", "details-result");
        savedDetails("run_shell_command", "output", "");
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value(""));
    }

    @Test
    void preservesBothSavedShellOutputAndFailureText() throws Exception {
        savedDetails("run_shell_command", JSON.createObjectNode().put("command", "false"),
                JSON.createObjectNode().put("output", "saved stdout").put("error", "saved failure"));
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("saved stdout\n\nsaved failure"));
    }

    @Test
    void preservesUpstreamTruncationForShortSavedShellPreviews() throws Exception {
        for (boolean nested : new boolean[] {false, true}) {
            var response = JSON.createObjectNode().put("output", "short preview");
            if (nested) {
                response.set("capture", JSON.createObjectNode().put("previewTruncated", true));
            } else {
                response.put("previewTruncated", true);
            }
            savedDetails("run_shell_command", JSON.createObjectNode().put("command", "printf sentinel"), response);
            mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                    .andExpect(jsonPath("$.output").value("short preview"))
                    .andExpect(jsonPath("$.truncated").value(true));
            fixture.jdbc().update("DELETE FROM ma_resource WHERE resource_id IN (?, ?)", "details-call", "details-result");
        }
    }

    @Test
    void readsSavedStructuredShellResultsThroughTheExistingDetailsRoute() throws Exception {
        var display = savedShellDisplay();
        display.put("privateCaptureRef", "must-not-leave-history");
        savedDetails("run_shell_command", JSON.createObjectNode().put("command", "exit 7"),
                JSON.createObjectNode().put("output", "legacy text"), display, "model-1");
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("legacy text"))
                .andExpect(jsonPath("$.shellResult.type").value("shell_result"))
                .andExpect(jsonPath("$.shellResult.version").value(1))
                .andExpect(jsonPath("$.shellResult.output").value("saved stdout"))
                .andExpect(jsonPath("$.shellResult.directory").value("/workspace/project"))
                .andExpect(jsonPath("$.shellResult.exitCode").value(7))
                .andExpect(jsonPath("$.shellResult.pid").value(123))
                .andExpect(jsonPath("$.shellResult.signal").value(org.hamcrest.Matchers.nullValue()))
                .andExpect(jsonPath("$.shellResult.outcome").value("failed"))
                .andExpect(jsonPath("$.shellResult.error").value("saved failure"))
                .andExpect(jsonPath("$.shellResult.notices[0]").value("saved notice"))
                .andExpect(jsonPath("$.shellResult.outputFiles[0]").value("/tmp/saved.log"))
                .andExpect(jsonPath("$.shellResult.truncated").value(false))
                .andExpect(jsonPath("$.shellResult.privateCaptureRef").doesNotExist())
                .andExpect(response -> contract("getWebShellToolDetails", "WebShellToolDetails",
                        response.getResponse().getContentAsString()));
    }

    @Test
    void structuredShellResultsPreserveTimeoutSignalAndUpstreamTruncationWithoutLegacyText() throws Exception {
        var display = savedShellDisplay().put("outcome", "timed_out").put("signal", 15).put("truncated", true);
        display.putNull("exitCode").putNull("pid");
        savedDetails("run_shell_command", JSON.createObjectNode(), JSON.createObjectNode(), display, "model-1");
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("saved display text"))
                .andExpect(jsonPath("$.shellResult.outcome").value("timed_out"))
                .andExpect(jsonPath("$.shellResult.signal").value(15))
                .andExpect(jsonPath("$.shellResult.truncated").value(true))
                .andExpect(jsonPath("$.truncated").value(true));
    }

    @Test
    void boundsCombinedStructuredShellTextWithoutDroppingExecutionMetadata() throws Exception {
        var display = savedShellDisplay().put("text", "界\n".repeat(3000)).put("output", "界".repeat(5000))
                .put("error", "error\n".repeat(3000));
        display.putArray("notices").add("notice\n".repeat(3000));
        savedDetails("run_shell_command", JSON.createObjectNode(), JSON.createObjectNode().put("output", "legacy"), display, "model-1");
        String body = mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.shellResult.exitCode").value(7))
                .andExpect(jsonPath("$.shellResult.truncated").value(true))
                .andExpect(jsonPath("$.truncated").value(false))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode result = JSON.readTree(body).path("shellResult");
        int bytes = 0;
        int lines = 0;
        for (String field : new String[] {"text", "output", "error"}) {
            String value = result.path(field).textValue();
            bytes += value.getBytes(StandardCharsets.UTF_8).length;
            lines += (int) value.lines().count();
            assertThat(value).doesNotContain("\uFFFD");
        }
        for (JsonNode value : result.path("notices")) {
            bytes += value.textValue().getBytes(StandardCharsets.UTF_8).length;
            lines += (int) value.textValue().lines().count();
        }
        assertThat(bytes).isLessThanOrEqualTo(8192);
        assertThat(lines).isLessThanOrEqualTo(200);
    }

    @Test
    void malformedUnsupportedAndMismatchedShellDisplaysFallBackToText() throws Exception {
        var invalid = new java.util.ArrayList<JsonNode>();
        invalid.add(savedShellDisplay().put("version", 2));
        invalid.add(savedShellDisplay().put("version", new java.math.BigInteger("18446744073709551617")));
        invalid.add(savedShellDisplay().put("exitCode", "7"));
        invalid.add(savedShellDisplay().put("signal", 9007199254740992L));
        invalid.add(savedShellDisplay().put("outcome", "unknown"));
        invalid.add(savedShellDisplay().put("output", 42));
        invalid.add(savedShellDisplay().put("directory", "x".repeat(8193)));
        var oversizedList = savedShellDisplay();
        for (int index = 0; index < 33; index++) {
            oversizedList.withArray("notices").add("notice");
        }
        invalid.add(oversizedList);
        invalid.add(savedShellDisplay().set("outputFiles", JSON.createArrayNode().add(123)));
        var missingError = savedShellDisplay();
        missingError.remove("error");
        invalid.add(missingError);
        for (JsonNode display : invalid) {
            assertShellDisplayFallback("run_shell_command", display, "model-1");
        }
        assertShellDisplayFallback("run_shell_command", savedShellDisplay(), "other-call");
        assertShellDisplayFallback("read_file", savedShellDisplay(), "model-1");
    }

    private void assertShellDisplayFallback(String tool, JsonNode display, String callId) throws Exception {
        fixture.jdbc().update("DELETE FROM ma_resource WHERE resource_id IN (?, ?)", "details-call", "details-result");
        savedDetails(tool, JSON.createObjectNode(), JSON.createObjectNode().put("output", "legacy text"), display, callId);
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("legacy text"))
                .andExpect(jsonPath("$.shellResult").doesNotExist());
    }

    private com.fasterxml.jackson.databind.node.ObjectNode savedShellDisplay() {
        var display = JSON.createObjectNode().put("type", "shell_result").put("version", 1)
                .put("text", "saved display text").put("output", "saved stdout").put("directory", "/workspace/project")
                .put("exitCode", 7).putNull("signal").put("pid", 123).put("error", "saved failure")
                .put("outcome", "failed").put("truncated", false);
        display.putArray("notices").add("saved notice");
        display.putArray("outputFiles").add("/tmp/saved.log");
        return display;
    }

    @Test
    void toolDetailsRequireActorAndCurrentWorkspaceGrant() throws Exception {
        savedDetails("read_file", "error", "private error");
        mvc.perform(toolDetails().header(TenantContextFilter.HEADER, "tenant-1"))
                .andExpect(status().isUnauthorized());
        mvc.perform(asActor(toolDetails(), "other-tenant", "reader")).andExpect(status().isNotFound());
        mvc.perform(asActor(toolDetails(), "tenant-1", "no-grant")).andExpect(status().isNotFound());
        mvc.perform(asActor(toolDetails(), "tenant-1", "metadata-reader"))
                .andExpect(status().isOk());
        fixture.jdbc().update("DELETE FROM ma_workspace_access WHERE actor_id = ?", "reader".getBytes(StandardCharsets.UTF_8));
        mvc.perform(asReader(toolDetails())).andExpect(status().isNotFound());
    }

    @Test
    void toolDetailsIgnoreObsoleteDisableConfiguration() throws Exception {
        savedDetails("read_file", "error", "saved error");
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("saved error"));
        var source = new MapConfigurationPropertySource(Map.of(
                "qwen.managed-agent.harness.tool-details-enabled", "false"));
        new Binder(source).bind("qwen.managed-agent", Bindable.ofInstance(fixture.properties()));
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("saved error"));
    }

    @Test
    void oversizedArgumentsDoNotMarkCompleteOutputAsTruncated() throws Exception {
        savedDetails("run_shell_command", "output", "complete output",
                JSON.createObjectNode().put("command", "x".repeat(5000)));
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.input").value(org.hamcrest.Matchers.nullValue()))
                .andExpect(jsonPath("$.output").value("complete output"))
                .andExpect(jsonPath("$.truncated").value(false));
    }

    @Test
    void toolDetailsExcludeUnsupportedToolsAndPrivateArgumentFields() throws Exception {
        savedDetails("run_shell_command", "output", "saved output",
                JSON.createObjectNode().put("command", "true").put("timeout", "not-a-number")
                        .put("captureRef", "private"));
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.input.command").value("true"))
                .andExpect(jsonPath("$.input.timeout").doesNotExist())
                .andExpect(jsonPath("$.input.captureRef").doesNotExist());
        fixture.jdbc().update("UPDATE ma_message SET attributes_json = ? WHERE item_id = ?",
                JSON.createObjectNode().put("name", "mcp__private").put("toolCallId", "model-1").toString(), itemId);
        mvc.perform(asReader(toolDetails())).andExpect(status().isNotFound());
    }

    @Test
    void toolDetailsDoNotSubstituteAnotherPromptOrExposeDeletingSessions() throws Exception {
        savedDetails("read_file", "error", "private error");
        fixture.jdbc().update("UPDATE ma_turn SET prompt_id = ?", "other-prompt");
        mvc.perform(asReader(toolDetails())).andExpect(status().isNotFound());
        fixture.jdbc().update("UPDATE ma_session SET status='DELETING'");
        mvc.perform(asReader(toolDetails())).andExpect(status().isNotFound());
    }

    @Test
    void boundsToolDetailsAndRejectsCorruptCommittedBytes() throws Exception {
        savedDetails("read_file", "output", "界".repeat(4000));
        String body = mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.truncated").value(true)).andReturn().getResponse().getContentAsString();
        assertThat(JSON.readTree(body).path("output").asText().getBytes(StandardCharsets.UTF_8).length)
                .isLessThanOrEqualTo(8192);
        fixture.jdbc().update("UPDATE ma_resource SET inline_bytes = ? WHERE resource_id = ?",
                "changed".getBytes(StandardCharsets.UTF_8), "details-result");
        mvc.perform(asReader(toolDetails())).andExpect(status().isConflict());
    }

    @Test
    void readsChunkedToolMessagesAndRefusesOversizedJournalRows() throws Exception {
        savedDetails("read_file", "output", "saved chunk\n".repeat(7000));
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.truncated").value(true));
        byte[] oversized = new byte[8 * 1024 * 1024 + 1];
        fixture.jdbc().update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ?",
                oversized, oversized.length, org.apache.commons.codec.digest.DigestUtils.sha256Hex(oversized));
        mvc.perform(asReader(toolDetails())).andExpect(status().isPayloadTooLarge());
    }

    @Test
    void readsTheLaterCommittedMessageWhenO3KeptAnEarlierItemSequence() throws Exception {
        savedDetails("read_file", "error", "saved file error");
        long first = fixture.jdbc().queryForObject("SELECT MIN(journal_revision) FROM ma_session_journal_tx", Long.class);
        long last = fixture.jdbc().queryForObject("SELECT MAX(journal_revision) FROM ma_session_journal_tx", Long.class);
        assertThat(last).isGreaterThan(first);
        long earlier = fixture.jdbc().queryForObject("SELECT first_sequence FROM ma_session_journal_tx WHERE journal_revision = ?",
                Long.class, first);
        long later = fixture.jdbc().queryForObject("SELECT last_sequence FROM ma_session_journal_tx WHERE journal_revision = ?",
                Long.class, last);
        byte[] full = fixture.jdbc().queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE journal_revision = ?",
                byte[].class, last);
        byte[] call = new String(full, StandardCharsets.UTF_8).split("\n")[0].getBytes(StandardCharsets.UTF_8);
        fixture.jdbc().update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ?"
                        + " WHERE journal_revision < ?", call, call.length,
                org.apache.commons.codec.digest.DigestUtils.sha256Hex(call), last);
        var attributes = (com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(fixture.jdbc().queryForObject(
                "SELECT attributes_json FROM ma_message WHERE item_id = ?", String.class, itemId));
        attributes.put("sourceSequence", earlier);
        fixture.jdbc().update("UPDATE ma_message SET attributes_json = ? WHERE item_id = ?", attributes.toString(), itemId);
        fixture.jdbc().update("UPDATE ma_public_event SET event_type = 'item.tool_call.updated', source_key = ?",
                "boot:epoch:" + later);
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("saved file error"));
        attributes.put("sourceSequence", later);
        fixture.jdbc().update("UPDATE ma_message SET attributes_json = ? WHERE item_id = ?", attributes.toString(), itemId);
        fixture.jdbc().update("DELETE FROM ma_public_event");
        mvc.perform(asReader(toolDetails())).andExpect(status().isOk())
                .andExpect(jsonPath("$.output").value("saved file error"));
    }

    private MockHttpServletRequestBuilder toolDetails() {
        return post("/api/agent/web-shell/v1/tool-details/get").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.createObjectNode().put("sessionId", "session-1").put("itemId", itemId).toString());
    }

    private void savedDetails(String tool, String field, String output) throws Exception {
        var input = JSON.createObjectNode();
        input.put("read_file".equals(tool) ? "file_path" : "command",
                "read_file".equals(tool) ? "/tmp/pr-14599.diff" : "printf sentinel");
        savedDetails(tool, field, output, input);
    }

    private void savedDetails(String tool, String field, String output, JsonNode input) throws Exception {
        savedDetails(tool, input, JSON.createObjectNode().put(field, output));
    }

    private void savedDetails(String tool, JsonNode input, JsonNode result) throws Exception {
        savedDetails(tool, input, result, null, null);
    }

    private void savedDetails(String tool, JsonNode input, JsonNode result, JsonNode display, String displayCallId) throws Exception {
        String prompt = fixture.jdbc().queryForObject("SELECT prompt_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                String.class, "tenant-1", "session-1");
        var attributes = (com.fasterxml.jackson.databind.node.ObjectNode) JSON.readTree(fixture.jdbc().queryForObject(
                "SELECT attributes_json FROM ma_message WHERE item_id = ?", String.class, itemId));
        attributes.put("name", tool);
        fixture.jdbc().update("UPDATE ma_message SET attributes_json = ? WHERE item_id = ?", attributes.toString(), itemId);
        var call = JSON.createObjectNode().put("id", "model-1").put("name", tool).set("args", input);
        var response = JSON.createObjectNode().put("id", "model-1").put("name", tool)
                .set("response", result);
        var callRecord = JSON.createObjectNode().put("uuid", "details-call").put("daemonPromptId", prompt);
        callRecord.putObject("message").putArray("parts").addObject().set("functionCall", call);
        var resultRecord = JSON.createObjectNode().put("uuid", "details-result").put("daemonPromptId", prompt);
        resultRecord.putObject("message").putArray("parts").addObject().set("functionResponse", response);
        if (display != null) {
            resultRecord.putObject("toolCallResult").put("callId", displayCallId).set("resultDisplay", display);
        }
        String records = detailsEvent("assistant", callRecord) + "\n" + detailsEvent("tool_result", resultRecord);
        byte[] bytes = records.getBytes(StandardCharsets.UTF_8);
        fixture.jdbc().update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ?",
                bytes, bytes.length, org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes));
    }

    private String detailsEvent(String role, JsonNode record) throws Exception {
        String id = record.path("uuid").asText();
        byte[] bytes = JSON.writeValueAsBytes(record);
        JsonNode ref;
        if (bytes.length > 64 * 1024) {
            var manifest = JSON.createObjectNode();
            var parts = manifest.putArray("parts");
            for (int offset = 0; offset < bytes.length; offset += 60 * 1024) {
                parts.add(detailsResource(id + "-" + offset, "managed-message-part",
                        java.util.Arrays.copyOfRange(bytes, offset, Math.min(offset + 60 * 1024, bytes.length))));
            }
            ref = detailsResource(id, "managed-message-chunks", JSON.writeValueAsBytes(manifest));
        } else {
            ref = detailsResource(id, "managed-message", bytes);
        }
        var event = JSON.createObjectNode().put("kind", "message.committed");
        event.putObject("sessionKey").put("tenantId", "tenant-1").put("workspaceId", "workspace-1").put("sessionId", "session-1");
        event.putObject("payload").put("role", role).put("messageId", id).set("contentRef", ref);
        return JSON.createObjectNode().set("managedSession", event).toString();
    }

    private JsonNode detailsResource(String id, String kind, byte[] bytes) {
        String digest = org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes);
        String scope = ManagedSessionStore.sessionScopeKey("tenant-1", "session-1");
        fixture.jdbc().update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id,"
                        + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', 1)",
                org.apache.commons.codec.digest.DigestUtils.sha256Hex(id), scope, "tenant-1", "workspace-1", "session-1",
                id, kind, bytes.length, digest, bytes);
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind)
                .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", digest);
    }

    @Test
    void unboundReadableSessionHasNoArtifactCapabilityOrRoutes() throws Exception {
        fixture.jdbc().update("UPDATE ma_session SET workspace_id=NULL, workspace_generation=NULL, workspace_storage_id=NULL, cwd_relative=NULL, context_config_ref=NULL, context_revision=NULL, workspace_config_ref=NULL, workspace_policy_ref=NULL");
        assertThat(sessions.getPublicSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isFalse();
        assertThat(sessions.getWebShellSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isFalse();
        for (String path : new String[] {"/items/" + itemId + "/tool-result", "/artifacts",
                "/artifacts/" + stdout.path("id").asText(), "/artifacts/" + stdout.path("id").asText() + "/content"}) {
            mvc.perform(asReader(get(ROOT + path))).andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.error.code").value("artifact_not_found"));
        }
        for (String route : new String[] {"tool-results/get", "artifacts/get", "artifacts/query"}) {
            var body = JSON.createObjectNode().put("sessionId", "session-1");
            if (route.equals("tool-results/get")) {
                body.put("itemId", itemId);
            } else if (route.equals("artifacts/get")) {
                body.put("artifactId", stdout.path("id").asText());
            }
            mvc.perform(asReader(post("/api/agent/web-shell/v1/" + route))
                    .contentType(MediaType.APPLICATION_JSON).content(body.toString()))
                    .andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("artifact_not_found"));
        }
    }

    @Test
    void contentAdmissionChecksCatalogOnceAndChunkGuardsStillRun() throws Exception {
        var reader = org.mockito.Mockito.spy(fixture.reader());
        var policy = org.mockito.Mockito.spy(fixture.policy());
        var service = new ManagedArtifactService(sessions, fixture.results(), reader, policy, fixture.properties());
        var response = new org.springframework.mock.web.MockHttpServletResponse();
        service.content(new com.alibaba.qwen.code.managedagent.model.TenantContext("tenant-1", "reader"),
                "session-1", stdout.path("id").asText(), stdout.path("revision").asText(), "bytes=0-2", null, null, response);
        assertThat(response.getContentAsByteArray()).isEqualTo("abc".getBytes(StandardCharsets.UTF_8));
        org.mockito.Mockito.verify(reader, org.mockito.Mockito.times(1)).available(org.mockito.ArgumentMatchers.any());
        org.mockito.Mockito.verify(policy, org.mockito.Mockito.atLeast(2)).readOriginal("tenant-1", "reader", "workspace-1", "session-1");
    }

    @Test
    void advertisesConfiguredArtifactReadsUntilSessionDeletion() {
        assertThat(sessions.getPublicSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isTrue();
        assertThat(sessions.getWebShellSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isTrue();
        assertThat(sessions.getPublicSession("tenant-1", "reader", "session-1").capabilities().sessionClose()).isFalse();
        assertThat(sessions.getWebShellSession("tenant-1", "reader", "session-1").capabilities().sessionClose()).isFalse();
        fixture.jdbc().update("UPDATE ma_session SET status = 'DELETING' WHERE session_id = X'73657373696f6e2d31'");
        assertThat(sessions.getPublicSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isFalse();
        assertThat(sessions.getWebShellSession("tenant-1", "reader", "session-1").capabilities().artifacts()).isFalse();
    }

    @Test
    void exposesOriginalCommittedBytesAfterWriterSealAndSessionClose() throws Exception {
        new TransactionTemplate(fixture.manager()).executeWithoutResult(ignored ->
                new ManagedSessionStore(fixture.jdbc()).sealWriter("tenant-1", "session-1", "a".repeat(32),
                        new SealWriterRequest("workspace-1", "writer-1", 1)));
        assertThat(fixture.jdbc().queryForObject("SELECT state FROM ma_session_head", String.class))
                .isEqualTo("SEALED");
        assertThat(fixture.sessions().requireSession("tenant-1", "session-1").status()).isEqualTo("CLOSED");

        var result = mvc.perform(asReader(get(ROOT + "/items/" + itemId + "/tool-result")))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "private, no-store")).andExpect(jsonPath("$.result.turn_id").value("turn_public_1"))
                .andExpect(jsonPath("$.result.execution_status").value("success"))
                .andExpect(jsonPath("$.result.capture_status").value("complete"))
                .andExpect(jsonPath("$.result.delivery_status").value("committed"))
                .andExpect(jsonPath("$.access.can_read_content").value(true))
                .andExpect(response ->
                                        contract(
                                                "getToolResult",
                                                "ToolResultResponse", response.getResponse().getContentAsString()))
                .andReturn().getResponse().getContentAsString();
        assertThat(result).doesNotContain("publicationId", "manifestRef", "object_key", "writerToken", "runtime-call-1");
        var list = mvc.perform(asReader(get(ROOT + "/artifacts"))).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "private, no-store"))
                .andExpect(jsonPath("$.data.length()").value(2))
                .andExpect(response ->
                                        contract(
                                                "listArtifacts",
                                                "PublicArtifactList", response.getResponse().getContentAsString()))
                .andReturn().getResponse().getContentAsString();
        mvc.perform(asReader(bytes(stdout)).header("Range", "bytes=1-2")
                        .header("If-Match", "\"" + stdout.path("sha256").asText() + "\""))
                .andExpect(status().isPartialContent()).andExpect(content().bytes(new byte[] {'b', 'c'}))
                .andExpect(header().string("Content-Range", "bytes 1-2/3"))
                .andExpect(header().string("Content-Length", "2"))
                .andExpect(header().string("Repr-Digest", reprDigest()))
                .andExpect(response -> binaryContract(response.getResponse()))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Cache-Control", "private, no-store, no-transform"));
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isOk())
                .andExpect(content().bytes("abc".getBytes(StandardCharsets.UTF_8)))
                .andExpect(header().string("Repr-Digest", reprDigest()))
                .andExpect(response -> binaryContract(response.getResponse()));
        mvc.perform(asReader(bytes(stderr))).andExpect(status().isOk()).andExpect(content().bytes(new byte[0]))
                .andExpect(header().string("Content-Length", "0"));
        mvc.perform(asReader(bytes(stdout)).header("If-Match", "\"outdated\""))
                .andExpect(status().isPreconditionFailed());
        mvc.perform(asReader(bytes(stdout)).header("Range", "bytes=3-"))
                .andExpect(status().isRequestedRangeNotSatisfiable()).andExpect(header().string("Content-Range", "bytes */3"));
        assertThat(fixture.jdbc().queryForObject("SELECT state FROM ma_session_head", String.class))
                .isEqualTo("SEALED");
        assertThat(fixture.sessions().findEvents("tenant-1", "session-1", 0, 100)).hasSize(1);

        var fixtureJson = JSON.createObjectNode();
        fixtureJson.set("toolResult", JSON.readTree(result));
        fixtureJson.set("artifactList", JSON.readTree(list));
        fixtureJson.set("transcript", JSON.valueToTree(sessions.transcript("tenant-1", "reader", "session-1", null, 100)));
        String before = Long.toString(fixture.sessions().requireSession("tenant-1", "session-1").lastSequence() + 1);
        fixtureJson.set("events", JSON.valueToTree(sessions.transcript("tenant-1", "reader", "session-1", before, 100).events()));
        String output = System.getProperty("qwen.o3.fixture-output");
        if (output != null) {
            Files.writeString(Path.of(output), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(fixtureJson));
        }
        JsonNode committed =
                JSON.readTree(
                        Files.readString(
                                Path.of(
                                        "../web-shell/client/components/managed/managed-tool-result.java-fixture.json")));
        assertThat(JSON.readTree(normalizeTimes(fixtureJson).toString()))
                .isEqualTo(JSON.readTree(normalizeTimes(committed).toString()));
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
                .andExpect(response ->
                                contract(
                                        "getArtifact",
                                        "ArtifactResponse", response.getResponse().getContentAsString()));
        mvc.perform(asActor(bytes(stdout), "tenant-1", "metadata-reader").header("Range", "malformed"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("artifact_content_forbidden"))
                .andExpect(header().doesNotExist("Content-Range"));
        fixture.jdbc().update("DELETE FROM ma_workspace_access WHERE actor_id = ?",
                "reader".getBytes(StandardCharsets.UTF_8));
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isNotFound());
    }

    @Test
    void webShellRoutesUseTheSameStoredResultsAndBoundedCursor() throws Exception {
        mvc.perform(asReader(post("/api/agent/web-shell/v1/tool-results/get"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(JSON.writeValueAsString(java.util.Map.of("sessionId", "session-1", "itemId", itemId))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.result.item_id").value(itemId))
                .andExpect(response ->
                                contract(
                                        "getWebShellToolResult",
                                        "ToolResultResponse", response.getResponse().getContentAsString()));
        mvc.perform(asReader(post("/api/agent/web-shell/v1/artifacts/get"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(JSON.writeValueAsString(java.util.Map.of("sessionId", "session-1", "artifactId", stdout.path("id").asText()))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.artifact.byte_length").value(3))
                .andExpect(response ->
                                contract(
                                        "getWebShellArtifact",
                                        "ArtifactResponse", response.getResponse().getContentAsString()));
        var first = mvc.perform(asReader(post("/api/agent/web-shell/v1/artifacts/query"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"sessionId\":\"session-1\",\"limit\":1}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.hasMore").value(true))
                .andExpect(response ->
                                        contract(
                                                "queryWebShellArtifacts",
                                                "WebShellArtifactPage", response.getResponse().getContentAsString())).andReturn();
        JsonNode firstPage = JSON.readTree(first.getResponse().getContentAsString());
        var second = mvc.perform(asReader(post("/api/agent/web-shell/v1/artifacts/query"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(JSON.writeValueAsString(java.util.Map.of("sessionId", "session-1", "limit", 1,
                                "cursor", firstPage.path("nextCursor").asText()))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.hasMore").value(false))
                .andExpect(response ->
                                        contract(
                                                "queryWebShellArtifacts",
                                                "WebShellArtifactPage", response.getResponse().getContentAsString())).andReturn();
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
        mvc.perform(asReader(get(ROOT + "/artifacts"))).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "private, no-store"))
                .andExpect(jsonPath("$.data").isEmpty());
        assertThat(fixture.jdbc().queryForObject("SELECT quarantined FROM ma_output_capture", Boolean.class))
                .isTrue();
    }

    @Test
    void deletionAndQuarantineHideContentWithoutChangingExecutionFacts() throws Exception {
        fixture.jdbc().update("UPDATE ma_output_capture SET quarantined = TRUE WHERE publication_id = X'7075622d31'");
        mvc.perform(asReader(get(ROOT + "/artifacts/" + stdout.path("id").asText())))
                .andExpect(status().isOk()).andExpect(jsonPath("$.artifact.availability").value("unavailable"))
                .andExpect(jsonPath("$.access.can_read_content").value(false));
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isServiceUnavailable());
        mvc.perform(asReader(get(ROOT + "/items/" + itemId + "/tool-result")))
                .andExpect(status().isOk()).andExpect(jsonPath("$.result.execution_status").value("success"));
        fixture.jdbc().update("UPDATE ma_session SET status = 'DELETING' WHERE session_id = X'73657373696f6e2d31'");
        mvc.perform(asReader(get(ROOT + "/artifacts"))).andExpect(status().isNotFound());
        mvc.perform(asReader(bytes(stdout))).andExpect(status().isNotFound());
    }

    @Test
    void rejectsInvalidCursorLimitsAndRangesWithStableCodes() throws Exception {
        for (String limit : new String[] {"0", "101"}) {
            mvc.perform(asReader(get(ROOT + "/artifacts").param("limit", limit)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_limit"));
        }
        for (String cursor :
                new String[] {
                    "invalid",
                    Base64.getUrlEncoder()
                            .withoutPadding()
                            .encodeToString(
                                    JSON.createObjectNode()
                                            .put("v", 1)
                                            .put("tenant", "other-tenant")
                                            .put("session", "session-1")
                                            .put("watermark", 1)
                                            .put("before", 1)
                                            .put("id", stdout.path("id").asText())
                                            .toString()
                                            .getBytes(StandardCharsets.UTF_8))
                }) {
            mvc.perform(asReader(get(ROOT + "/artifacts").param("cursor", cursor)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_cursor"));
        }
        for (String[] range :
                new String[][] {{"bad", "invalid_range"}, {"bytes=0-1,2-2", "unsupported_range"}}) {
            mvc.perform(asReader(bytes(stdout)).header("Range", range[0]))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value(range[1]));
        }
        mvc.perform(asReader(get(ROOT + "/artifacts/" + stdout.path("id").asText() + "/content")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("revision_required"));
    }

    @Test
    void ifRangeUsesTheWholeRepresentationWhenItsValidatorDoesNotMatch() throws Exception {
        mvc.perform(
                        asReader(bytes(stdout))
                                .header("Range", "bytes=1-2")
                                .header("If-Range", "\"" + stdout.path("sha256").asText() + "\""))
                .andExpect(status().isPartialContent())
                .andExpect(content().bytes(new byte[] {'b', 'c'}));
        mvc.perform(
                        asReader(bytes(stdout))
                                .header("Range", "bytes=1-2")
                                .header("If-Range", "\"old\""))
                .andExpect(status().isOk())
                .andExpect(content().bytes("abc".getBytes(StandardCharsets.UTF_8)))
                .andExpect(header().doesNotExist("Content-Range"));
    }

    @Test
    void hidesMetadataFromActorsWithoutGrantsAndAllWebBodyRoutesFromForeignTenants()
            throws Exception {
        for (String path :
                new String[] {
                    ROOT + "/items/" + itemId + "/tool-result",
                    ROOT + "/artifacts",
                    ROOT + "/artifacts/" + stdout.path("id").asText()
                }) {
            mvc.perform(asActor(get(path), "tenant-1", "no-grant"))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.error.code").value("session_not_found"));
        }
        for (String route : new String[] {"tool-results/get", "artifacts/get", "artifacts/query"}) {
            var body = JSON.createObjectNode().put("sessionId", "session-1");
            if (route.equals("tool-results/get")) {
                body.put("itemId", itemId);
            }
            if (route.equals("artifacts/get")) {
                body.put("artifactId", stdout.path("id").asText());
            }
            mvc.perform(
                            asActor(
                                            post("/api/agent/web-shell/v1/" + route),
                                            "other-tenant",
                                            "reader")
                                    .contentType(MediaType.APPLICATION_JSON)
                                    .content(body.toString()))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.error.code").value("session_not_found"));
        }
    }

    @Test
    void contractRejectsUnknownCaptureScopesAndReasons() throws Exception {
        var result = fixture.results().findResult("tenant-1", "session-1", itemId).orElseThrow();
        var contract = OpenApiContract.load();
        for (String field : new String[] {"capture_scope", "reason_code"}) {
            var changed = result.deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) changed).put(field, "unknown");
            assertThat(contract.validate("/components/schemas/PublicToolResult", changed)).isNotEmpty();
        }
    }

    @Test
    void deletionDuringLeaseAdmissionPreservesPublicNotFound() {
        var reader = org.mockito.Mockito.spy(fixture.reader());
        org.mockito.Mockito.doAnswer(call -> {
            fixture.jdbc().update("UPDATE ma_session SET status = 'DELETED' WHERE session_id = X'73657373696f6e2d31'");
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(org.springframework.http.HttpStatus.CONFLICT,
                    "tool_output_session_retired", "Retired during lease admission");
        }).when(reader).lease(org.mockito.ArgumentMatchers.any());
        var service = new ManagedArtifactService(sessions, fixture.results(), reader, fixture.policy(), fixture.properties());
        assertThatThrownBy(() -> service.content(new com.alibaba.qwen.code.managedagent.model.TenantContext("tenant-1", "reader"),
                "session-1", stdout.path("id").asText(), stdout.path("revision").asText(), null, null, null,
                new org.springframework.mock.web.MockHttpServletResponse()))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(org.springframework.http.HttpStatus.NOT_FOUND));
    }

    private static MockHttpServletRequestBuilder bytes(JsonNode artifact) {
        return get(ROOT + "/artifacts/" + artifact.path("id").asText() + "/content")
                .param("revision", artifact.path("revision").asText());
    }

    private static void contract(String operationId, String component, String json)
            throws Exception {
        var contract = OpenApiContract.load();
        String response = contract.responsePointer(contract.operation(operationId), 200);
        String schema = response + "/content/application~1json/schema";
        assertThat(contract.node(schema).path("$ref").asText())
                .isEqualTo("#/components/schemas/" + component);
        assertThat(contract.validate(schema, JSON.readTree(json))).isEmpty();
    }

    private static void binaryContract(
            org.springframework.mock.web.MockHttpServletResponse response) {
        var contract = OpenApiContract.load();
        String pointer =
                contract.responsePointer(
                        contract.operation("getArtifactContent"), response.getStatus());
        assertThat(
                        contract.node(pointer + "/content/application~1octet-stream/schema/format")
                                .asText())
                .isEqualTo("binary");
        for (String name :
                Set.of(
                        "ETag",
                        "Repr-Digest",
                        "Content-Length",
                        "Content-Disposition",
                        "Accept-Ranges",
                        "Cache-Control")) {
            assertThat(contract.node(pointer + "/headers/" + name).isMissingNode())
                    .as(name)
                    .isFalse();
            assertThat(response.getHeader(name)).as(name).isNotBlank();
        }
        assertThat(contract.node(pointer + "/headers/Content-Range").isMissingNode())
                .isEqualTo(response.getStatus() == 200);
        if (response.getStatus() == 206) {
            assertThat(response.getHeader("Content-Range")).isNotBlank();
            assertThat(response.getHeader("Connection")).isNull();
        } else {
            assertThat(response.getHeader("Content-Range")).isNull();
            assertThat(response.getHeader("Connection")).isEqualTo("close");
        }
    }

    private static String reprDigest() throws Exception {
        return "sha-256=:"
                + Base64.getEncoder()
                        .encodeToString(
                                MessageDigest.getInstance("SHA-256")
                                        .digest("abc".getBytes(StandardCharsets.UTF_8)))
                + ":";
    }

    private static JsonNode normalizeTimes(JsonNode value) {
        JsonNode copy = value.deepCopy();
        if (copy.isObject()) {
            for (var field : copy.properties()) {
                if (Set.of("created_at", "createdAt", "updatedAt").contains(field.getKey())) {
                    ((com.fasterxml.jackson.databind.node.ObjectNode) copy).put(field.getKey(), 0);
                } else if ("eventId".equals(field.getKey())) {
                    assertThat(field.getValue().asText()).matches("evt_[0-9a-f]{32}");
                    ((com.fasterxml.jackson.databind.node.ObjectNode) copy)
                            .put(field.getKey(), "evt_fixture");
                } else {
                    ((com.fasterxml.jackson.databind.node.ObjectNode) copy)
                            .set(field.getKey(), normalizeTimes(field.getValue()));
                }
            }
        } else if (copy.isArray()) {
            for (int index = 0; index < copy.size(); index++) {
                ((com.fasterxml.jackson.databind.node.ArrayNode) copy)
                        .set(index, normalizeTimes(copy.get(index)));
            }
        }
        return copy;
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
