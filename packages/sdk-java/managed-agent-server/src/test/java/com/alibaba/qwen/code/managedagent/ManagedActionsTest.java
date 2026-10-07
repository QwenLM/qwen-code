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

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.ManagedActionService;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.stubbing.Answer;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
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

    // The logback context is JVM-wide, so a failed assertion must not leave the
    // capture attached for the rest of the surefire fork.
    private final Logger serviceLog = (Logger) LoggerFactory.getLogger(ManagedActionService.class);
    private final ListAppender<ILoggingEvent> logged = new ListAppender<>();

    @BeforeEach
    void captureServiceLog() {
        logged.start();
        serviceLog.addAppender(logged);
    }

    @AfterEach
    void releaseServiceLog() {
        serviceLog.detachAppender(logged);
        logged.stop();
    }

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

    @ParameterizedTest
    @ValueSource(strings = {"read_file", "write_file", "edit", "run_shell_command"})
    void previewsExactInputOnPublicAndWebShellListsAndDetails(String tool) throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        String arguments = switch (tool) {
            case "read_file" -> "{ \"file_path\" : \"notes.md\", \"offset\" : 1e2 }";
            case "write_file" -> "{ \"file_path\" : \"notes.md\", \"content\" : \"\\u4e2d\\n\" }";
            case "edit" -> "{ \"file_path\" : \"notes.md\", \"old_string\" : \"a\", \"new_string\" : \"b\" }";
            case "run_shell_command" -> "{ \"command\" : \"printf 'text'\" }";
            default -> throw new AssertionError(tool);
        };
        String payload = " { \"toolName\" : \"" + tool + "\", \"input\" : " + arguments + " } ";
        ActionJournal journal = inputJournal(tenant, session, payload);
        journal.options.put("toolName", tool);
        journal.change("requested", null);
        for (JsonNode view : inputViews(tenant, session, journal.id)) {
            boolean web = view.has("actionId");
            JsonNode preview = view.path(web ? "inputPreview" : "input_preview");
            assertThat(preview.path("text").asText()).isEqualTo(payload);
            assertThat(preview.path("truncated").asBoolean()).isFalse();
            assertThat(preview.path(web ? "byteLength" : "byte_length").asLong())
                    .isEqualTo(payload.getBytes(StandardCharsets.UTF_8).length);
        }
        mvc.perform(auth(get(path(session, journal.id)), tenant(), "owner"))
                .andExpect(status().isNotFound());
    }

    @Test
    void boundsInputByUtf8BytesWithoutSplittingCodePoints() throws Exception {
        String prefix = "{\"toolName\":\"write_file\",\"input\":{\"file_path\":\"notes.md\",\"content\":\"";
        String suffix = "\"}}";
        for (String boundary : List.of("exact", "ascii-over", "multibyte")) {
            String tenant = tenant();
            String session = session(tenant);
            boolean multibyte = "multibyte".equals(boundary);
            int length = "ascii-over".equals(boundary) ? 8193 : 8192;
            int prefixBytes = multibyte ? 8191 : 8192;
            String payload = multibyte
                    ? prefix + "a".repeat(8191 - prefix.length()) + "😀tail" + suffix
                    : prefix + "a".repeat(length - prefix.length() - suffix.length()) + suffix;
            ActionJournal journal = inputAction(tenant, session, payload);
            for (JsonNode view : inputViews(tenant, session, journal.id)) {
                boolean web = view.has("actionId");
                JsonNode preview = view.path(web ? "inputPreview" : "input_preview");
                String text = preview.path("text").asText();
                assertThat(text).isEqualTo(payload.substring(0, prefixBytes));
                assertThat(text.getBytes(StandardCharsets.UTF_8).length)
                        .isEqualTo(prefixBytes);
                assertThat(preview.path("truncated").asBoolean())
                        .isEqualTo(!"exact".equals(boundary));
                assertThat(preview.path(web ? "byteLength" : "byte_length").asLong())
                        .isEqualTo(payload.getBytes(StandardCharsets.UTF_8).length);
            }
        }
    }

    @Test
    void missingInvalidAndCorruptInputNeverFailsTheActionRead() throws Exception {
        for (String fault : List.of("missing", "null", "scalar", "shape", "kind", "version", "length", "digest",
                "corrupt", "unreferenced", "null-bytes")) {
            String tenant = tenant();
            String session = session(tenant);
            ActionJournal journal = inputJournal(tenant, session, "{\"toolName\":\"write_file\",\"input\":{}}");
            ObjectNode ref = (ObjectNode) journal.options.path("inputRef");
            String resourceId = ref.path("resourceId").asText();
            journal.change("requested", null);
            switch (fault) {
                case "missing" -> ref.put("resourceId", "missing-input");
                case "null" -> journal.options.putNull("inputRef");
                case "scalar" -> journal.options.put("inputRef", 1);
                case "shape" -> ref.remove("digest");
                case "kind" -> ref.put("kind", "managed-action-options");
                case "version" -> ref.put("schemaVersion", 2);
                case "length" -> ref.put("byteLength", 1);
                case "digest" -> ref.put("digest", "0".repeat(64));
                default -> {}
            }
            if ("corrupt".equals(fault)) {
                jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ?"
                                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                        new byte[] {1}, tenant, session, resourceId);
            } else if ("null-bytes".equals(fault)) {
                // The damage shape the other two arms miss: the row is still
                // committed and REFERENCED, but its bytes are gone.
                jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = NULL"
                                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                        tenant, session, resourceId);
            } else if ("unreferenced".equals(fault)) {
                jdbc.update("UPDATE qwen_managed_session_resource SET state = 'UNREFERENCED'"
                                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                        tenant, session, resourceId);
            } else {
                corruptOptions(tenant, session, journal);
            }
            logged.list.clear();
            assertNoInputPreview(tenant, session, journal.id);
            if (List.of("missing", "digest", "corrupt", "unreferenced", "null-bytes").contains(fault)) {
                // Omitting the preview is deliberate; its cause must still be
                // greppable, and must never carry the stored payload.
                assertThat(logged.list).anySatisfy(event ->
                        assertThat(event.getFormattedMessage()).contains(journal.id));
                assertThat(logged.list).allSatisfy(event ->
                        assertThat(event.getFormattedMessage()).doesNotContain("toolName"));
            }
        }
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal plain = action(tenant, session, 100, 1000);
        logged.list.clear();
        inputViews(tenant, session, plain.id);
        // A version 1 Action stops at the eligibility gate and must not warn.
        assertThat(logged.list).isEmpty();
    }

    @Test
    void refusesCrossSessionAndCrossTenantInputReferences() throws Exception {
        for (boolean otherTenant : List.of(false, true)) {
            String tenant = tenant();
            String session = session(tenant);
            String foreignTenant = otherTenant ? tenant() : tenant;
            String foreignSession = session(foreignTenant);
            ActionJournal foreign = new ActionJournal(journals, foreignTenant, foreignSession, 100, 1000)
                    .withInput(inputBytes(session, "{\"toolName\":\"write_file\",\"input\":{\"content\":\"foreign secret\"}}"));
            foreign.change("requested", null);
            ActionJournal local = new ActionJournal(journals, tenant, session, 100, 1000);
            local.options.put("v", 2);
            local.options.set("inputRef", foreign.options.path("inputRef").deepCopy());
            assertThatThrownBy(() -> local.change("requested", null))
                    .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode())
                            .isEqualTo("managed_session_resource_missing"));
            assertThat(actions.find(tenant, session, local.id)).isEmpty();
            ActionJournal committed = new ActionJournal(local, 100, 1000)
                    .withInput(inputBytes(session, "{\"toolName\":\"write_file\",\"input\":{\"content\":\"local input\"}}"));
            committed.change("requested", null);
            committed.options.set("inputRef", foreign.options.path("inputRef").deepCopy());
            corruptOptions(tenant, session, committed);
            assertNoInputPreview(tenant, session, committed.id);
        }
    }

    @Test
    void omitsMalformedPayloadsAndInternalMcpInputs() throws Exception {
        for (String fault : List.of("session", "runtime", "extra", "json", "duplicate", "tool",
                "scalar", "mcp", "utf8", "empty", "surrogate", "payloadField", "blankRuntime")) {
            String tenant = tenant();
            String session = session(tenant);
            ObjectNode wrapper = (ObjectNode) json.readTree(inputBytes(session, "{\"toolName\":\"write_file\",\"input\":{}}"));
            switch (fault) {
                case "session" -> wrapper.put("harnessSessionId", "other-session");
                case "runtime" -> wrapper.put("runtimeSessionId", 1);
                case "extra" -> wrapper.put("extra", "not part of the wrapper");
                case "json" -> wrapper.put("payloadJson", "{broken");
                case "duplicate" -> wrapper.put("payloadJson", "{\"toolName\":\"write_file\",\"toolName\":\"edit\",\"input\":{}}");
                case "tool" -> wrapper.put("payloadJson", "{\"toolName\":\"edit\",\"input\":{}}");
                case "scalar" -> wrapper.put("payloadJson", "{\"toolName\":\"write_file\",\"input\":\"not an object\"}");
                case "mcp" -> wrapper.put("payloadJson", "{\"toolName\":\"managed_mcp_call\",\"input\":{\"grant\":\"internal authorization\"}}");
                // The two guards no other arm reaches: a producer-added payload field, and a
                // blank (not merely non-textual) runtimeSessionId.
                case "payloadField" -> wrapper.put(
                        "payloadJson", "{\"toolName\":\"write_file\",\"input\":{},\"grant\":\"internal authorization\"}");
                case "blankRuntime" -> wrapper.put("runtimeSessionId", "");
                default -> {}
            }
            byte[] bytes = json.writeValueAsBytes(wrapper);
            if ("empty".equals(fault)) {
                bytes = new byte[] {32};
            } else if ("utf8".equals(fault)) {
                int offset = new String(bytes, StandardCharsets.UTF_8).indexOf("runtime-actions");
                bytes[offset] = (byte) 0xff;
            } else if ("surrogate".equals(fault)) {
                // The escape has to sit in the wrapper bytes, so that readJson
                // decodes it into an unpaired surrogate inside payloadJson: the
                // wrapper stays valid UTF-8 while the payload text no longer
                // round-trips through it, which is what the reader must reject.
                bytes = ("{\"harnessSessionId\":\"" + session + "\",\"runtimeSessionId\":\"runtime-actions\","
                                + "\"payloadJson\":\"{\\\"toolName\\\":\\\"write_file\\\","
                                + "\\\"input\\\":{\\\"content\\\":\\\"\\uD800\\\"}}\"}")
                        .getBytes(StandardCharsets.UTF_8);
            }
            ActionJournal journal = new ActionJournal(journals, tenant, session, 100, 1000).withInput(bytes);
            if ("mcp".equals(fault)) {
                journal.options.put("toolName", "managed_mcp_call");
            }
            journal.change("requested", null);
            assertNoInputPreview(tenant, session, journal.id);
        }
    }

    @Test
    void stillRejectsUnknownOptionsVersionsAndFields() throws Exception {
        for (String fault : List.of("oldExtra", "missingRef", "version", "extra", "danglingRef",
                "nullRef", "scalarRef", "missingRefField", "extraRefField", "refKind", "refVersion",
                "refLength", "refDigest")) {
            String tenant = tenant();
            String session = session(tenant);
            ActionJournal journal = new ActionJournal(journals, tenant, session, 100, 1000);
            switch (fault) {
                case "oldExtra" -> journal.options.putNull("inputRef");
                case "missingRef" -> journal.options.put("v", 2);
                case "version" -> journal.options.put("v", 3);
                case "extra" -> {
                    journal.withInput(inputBytes(session, "{\"toolName\":\"write_file\",\"input\":{}}"));
                    journal.options.put("extra", true);
                }
                default -> {
                    journal.withInput(inputBytes(session, "{\"toolName\":\"write_file\",\"input\":{}}"));
                    ObjectNode ref = (ObjectNode) journal.options.path("inputRef");
                    switch (fault) {
                        case "danglingRef" -> ref.put("resourceId", "missing-input");
                        case "nullRef" -> journal.options.putNull("inputRef");
                        case "scalarRef" -> journal.options.put("inputRef", 1);
                        case "missingRefField" -> ref.remove("digest");
                        case "extraRefField" -> ref.put("extra", true);
                        case "refKind" -> ref.put("kind", "managed-action-options");
                        case "refVersion" -> ref.put("schemaVersion", 2);
                        case "refLength" -> ref.put("byteLength", 1);
                        case "refDigest" -> ref.put("digest", "0".repeat(64));
                        default -> throw new AssertionError(fault);
                    }
                }
            }
            assertThatThrownBy(() -> journal.change("requested", null), "invalid inputRef (%s)", fault)
                    .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode())
                            .isEqualTo("danglingRef".equals(fault)
                                    ? "managed_session_resource_missing" : "managed_session_action_rejected"));
            assertThat(actions.find(tenant, session, journal.id)).isEmpty();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"allow", "deny"})
    void answersV2WithTheExistingPolicyAndKeepsTerminalDetail(String option) throws Exception {
        String tenant = tenant();
        String session = session(tenant);
        ActionJournal journal = inputAction(tenant, session, "{\"toolName\":\"write_file\",\"input\":{}}");
        responses.put(journal.id, call -> {
            journal.change("decided", call.getArgument(3));
            return null;
        });
        JsonNode operation = readAccepted(auth(post(path(session, journal.id) + "/responses"), tenant, "owner")
                .header("Idempotency-Key", "v2-answer")
                .contentType(MediaType.APPLICATION_JSON).content(response(option)));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(
                sessions.findOperation(tenant, session, operation.path("id").asText()).orElseThrow().state())
                .isEqualTo("COMPLETED"));
        JsonNode terminal = read(auth(get(path(session, journal.id)), tenant, "owner"));
        assertThat(terminal.path("state").asText()).isEqualTo("decided");
        assertThat(terminal.has("input_preview")).isFalse();
        assertThat(terminal.path("decision_receipt_id").asText()).startsWith("decision_");
        assertThat(OpenApiContract.load().validate("/components/schemas/PublicAction", terminal)).isEmpty();
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
            // The journal itself now owns event-envelope validation, so an
            // envelope that is not a well-formed event is refused before
            // the Action store reads it.
            String expected =
                    "version".equals(field)
                            ? "managed_session_extension_record_rejected"
                            : "managed_session_action_rejected";
            assertThatThrownBy(
                            () ->
                                    journals.commit(
                                            tenant,
                                            session,
                                            "extension-writer-token-0123456789",
                                            invalid))
                    .isInstanceOfSatisfying(
                            ApiException.class,
                            error -> assertThat(error.getCode()).isEqualTo(expected));
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
        assertThat(publicView.has("input_preview")).isFalse();
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
        assertThat(web.has("inputPreview")).isFalse();
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

    private byte[] inputBytes(String session, String payload) throws Exception {
        return json.writeValueAsBytes(Map.of("harnessSessionId", session,
                "runtimeSessionId", "runtime-actions", "payloadJson", payload));
    }

    private ActionJournal inputJournal(String tenant, String session, String payload) throws Exception {
        return new ActionJournal(journals, tenant, session, 100, 9007199254740991L)
                .withInput(inputBytes(session, payload));
    }

    private ActionJournal inputAction(String tenant, String session, String payload) throws Exception {
        ActionJournal journal = inputJournal(tenant, session, payload);
        journal.change("requested", null);
        return journal;
    }

    private void corruptOptions(String tenant, String session, ActionJournal journal) throws Exception {
        assertThat(jdbc.update("UPDATE managed_agent_action SET options_json = ?"
                        + " WHERE tenant_id = ? AND session_id = ? AND action_id = ?",
                json.writeValueAsString(journal.options), tenant, session, journal.id)).isEqualTo(1);
    }

    private List<JsonNode> inputViews(String tenant, String session, String id) throws Exception {
        List<JsonNode> views = List.of(
                read(auth(get(path(session, id)), tenant, "owner")),
                read(auth(post("/api/agent/web-shell/v1/actions/get"), tenant, "owner")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(Map.of("sessionId", session, "actionId", id)))),
                read(auth(get("/v1/agents/sessions/{session}/actions", session), tenant, "owner")).path("data").get(0),
                read(auth(post("/api/agent/web-shell/v1/actions/query"), tenant, "owner")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(Map.of("sessionId", session)))).path("data").get(0));
        for (JsonNode view : views) {
            assertThat(OpenApiContract.load().validate(view.has("actionId")
                    ? "/components/schemas/WebShellAction" : "/components/schemas/PublicAction", view)).isEmpty();
        }
        return views;
    }

    private void assertNoInputPreview(String tenant, String session, String id) throws Exception {
        for (JsonNode view : inputViews(tenant, session, id)) {
            assertThat(view.has("input_preview") || view.has("inputPreview")).isFalse();
            assertThat(view.path("state").asText()).isEqualTo("requested");
        }
    }

    @Test
    void hostedSessionsAnswerThroughTheirRecordedCreator() throws Exception {
        String tenant = tenant();
        String anonymous = hostedSession(tenant, null);
        ActionJournal open = action(tenant, anonymous,
                System.currentTimeMillis(), 9007199254740991L);
        // No recorded creator: the tenant-scoped caller answers, matching
        // the read semantics of a non-Workspace Session.
        readAccepted(auth(post(path(anonymous, open.id) + "/responses"),
                tenant, "anyone")
                        .header("Idempotency-Key", "open-answer")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(response("allow")));

        String owned = hostedSession(tenant, "owner");
        ActionJournal journal = action(tenant, owned,
                System.currentTimeMillis(), 9007199254740991L);
        mvc.perform(auth(post(path(owned, journal.id) + "/responses"),
                tenant, "other")
                        .header("Idempotency-Key", "foreign-answer")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(response("allow")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("action_forbidden"));
        mvc.perform(post(path(owned, journal.id) + "/responses")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "anonymous-answer")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(response("allow")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("action_forbidden"));
        readAccepted(auth(post(path(owned, journal.id) + "/responses"),
                tenant, "owner")
                        .header("Idempotency-Key", "owner-answer")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(response("allow")));
    }

    @Test
    void webShellHostedCreateRecordsTheCreator() throws Exception {
        String tenant = tenant();
        String session = json.readTree(mvc.perform(
                        auth(post("/api/agent/web-shell/v1/sessions/create"),
                                tenant, "owner")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(json.writeValueAsString(Map.of(
                                        "idempotencyKey",
                                        UUID.randomUUID().toString(),
                                        "agentId", "qwen-code", "input",
                                        java.util.List.of()))))
                .andExpect(status().isAccepted()).andReturn().getResponse()
                .getContentAsString()).path("sessionId").asText();
        assertThat(jdbc.queryForObject(
                "SELECT creator_actor_key FROM managed_agent_session WHERE"
                        + " tenant_id = ? AND session_id = ?",
                byte[].class, tenant, session))
                .as("creator recorded for a WebShell hosted create")
                .isEqualTo("owner".getBytes(
                        java.nio.charset.StandardCharsets.UTF_8));
    }

    private String hostedSession(String tenant, String actor)
            throws Exception {
        MockHttpServletRequestBuilder create = post("/v1/agents/sessions")
                .header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"agent_id\":\"qwen-code\",\"input\":[]}");
        if (actor != null) {
            create = auth(create, tenant, actor);
        }
        return readAccepted(create).path("id").asText();
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
