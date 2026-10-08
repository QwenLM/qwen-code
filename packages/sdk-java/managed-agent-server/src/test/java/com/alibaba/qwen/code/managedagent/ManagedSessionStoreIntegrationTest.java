package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskRow;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-session-store;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true"
})
// No print-on-failure: the byte-budget commits carry ~1.3 MB bodies, and
// one such line in the Actions log stalled the runner's log pipeline long
// enough to time out every Maven step that ran this class.
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class ManagedSessionStoreIntegrationTest {
    private static final String TENANT = "tenant-store";
    private static final String WORKSPACE = "workspace-store";
    private static final String SESSION = "session-store";
    private static final String WRITER_A = "writer-a";
    private static final String WRITER_B = "writer-b";
    private static final String TOKEN_A =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String TOKEN_B =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static final String BASE =
            "/internal/managed-session-store/v1/sessions/" + SESSION;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ManagedExtensionRecordStore records;

    @Test
    void reportsAMigrationFenceAsADefiniteConflictWithoutChangingTheWriter() throws Exception {
        String session = "migration-" + UUID.randomUUID();
        String storage = "storage-" + UUID.randomUUID();
        String base = "/internal/managed-session-store/v1/sessions/" + session;
        jdbc.update("INSERT INTO managed_agent_session (tenant_id, session_id, agent_id, status,"
                + " created_at, updated_at, workspace_storage_id, workspace_id, workspace_generation, cwd_relative,"
                + " context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref)"
                + " VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1, ?, 'workspace', 1, '.', ?, 1, ?, ?)",
                TENANT, session, storage, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        mvc.perform(post(base + "/writers:acquire").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(writerRequest(WRITER_A).toString()))
                .andExpect(status().isOk());
        var original = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head WHERE session_id = ?", session);
        new JdbcRuntimeBindingRepository(jdbc.getDataSource(), new AesGcmSecretProtector("test", new byte[32]))
                .requestStorageFence(TENANT, storage, UUID.randomUUID().toString());
        mvc.perform(post(base + "/writers:acquire").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                .contentType(MediaType.APPLICATION_JSON).content(writerRequest(WRITER_A).toString()))
                .andExpect(status().isConflict())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("workspace_unavailable"))
                .andExpect(jsonPath("$.error.retryable").value(false));
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head WHERE session_id = ?", session))
                .isEqualTo(original);
        jdbc.update("DELETE FROM qwen_runtime_storage_fence WHERE tenant_id = ? AND storage_id = ?", TENANT, storage);
        mvc.perform(post(base + "/writers:acquire").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(writerRequest(WRITER_A).toString()))
                .andExpect(status().isOk());
    }

    @Test
    void acceptsTheStageHTransactionsTheAuthorityWrote() throws Exception {
        // The requests the TypeScript authority sent through its HTTP store,
        // pinned by http-managed-session-store.test.ts.
        JsonNode written = ManagedExtensionProjectionContractTest.contract(
                "managed-extension-journal-v1.fixtures.json");
        assertThat(written.required("contractVersion").intValue())
                .isEqualTo(1);
        JsonNode key = written.required("sessionKey");
        String tenant = key.required("tenantId").textValue();
        String session = key.required("sessionId").textValue();
        String base = "/internal/managed-session-store/v1/sessions/"
                + session;
        String token = "c".repeat(32);
        List<JsonNode> requests = new ArrayList<>();
        requests.add(objectMapper.createObjectNode()
                .put("workspaceId", key.required("workspaceId").textValue())
                .put("writerId", written.required("writerId").textValue())
                .put("leaseMillis", 60_000));
        written.required("commits").forEach(requests::add);
        for (int index = 0; index < requests.size(); index++) {
            MvcResult result = mvc.perform(post(base + (index == 0
                            ? "/writers:acquire" : "/transactions:commit"))
                            .header(TenantContextFilter.HEADER, tenant)
                            .header(ManagedSessionStoreModels
                                    .WRITER_TOKEN_HEADER, token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(requests.get(index).toString()))
                    .andReturn();
            assertThat(result.getResponse().getStatus())
                    .as(result.getResponse().getContentAsString())
                    .isEqualTo(200);
        }
        JsonNode tasks = written.required("tasks");
        assertThat(tasks).isNotEmpty();
        List<String> taskFields = new ArrayList<>(
                ManagedExtensionProjectionContractTest.PROJECTION_FIELDS);
        // The journal task node carries the projection plus the identity
        // fields read here, and exactly those, so a new projected column
        // cannot reach this contract without the replay comparing it.
        taskFields.addAll(List.of("kind", "sessionId", "taskId"));
        taskFields.sort(null);
        for (JsonNode task : tasks) {
            TaskRow row = records.findTask(tenant, session,
                    task.required("taskId").textValue()).orElseThrow();
            assertThat(row.kind()).isEqualTo(task.required("kind")
                    .textValue());
            List<String> names = new ArrayList<>();
            task.fieldNames().forEachRemaining(names::add);
            names.sort(null);
            assertThat(names).isEqualTo(taskFields);
            ObjectNode projectionOnly = ((ObjectNode) task).deepCopy()
                    .retain(ManagedExtensionProjectionContractTest
                            .PROJECTION_FIELDS);
            assertThat(row.projection()).isEqualTo(
                    ManagedExtensionProjectionContractTest.view(
                            projectionOnly));
        }
        assertThat(records.listTasks(tenant, session, null, null, 100)
                .tasks()).hasSize(tasks.size());
    }

    @Test
    void requiresTrustedTenantAndWriterToken() throws Exception {
        mvc.perform(post(BASE + "/writers:acquire")
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(writerRequest(WRITER_A).toString()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_tenant"));

        mvc.perform(post(BASE + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(writerRequest(WRITER_A).toString()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_request"));
    }

    @Test
    void toolResultsAreDurableBeforeJournalCommitAndRemainWriterFenced() throws Exception {
        String session = "output-" + UUID.randomUUID();
        String base = "/internal/managed-session-store/v1/sessions/" + session;
        mvc.perform(post(base + "/writers:acquire").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(writerRequest(WRITER_A).toString()))
                .andExpect(status().isOk());
        byte[] bytes = new byte[1024 * 1024];
        Arrays.fill(bytes, (byte) 0xff);
        ObjectNode body = objectMapper.createObjectNode().put("workspaceId", WORKSPACE).put("writerId", WRITER_A)
                .put("writerGeneration", 1).put("resourceId", "captured-segment")
                .put("kind", "managed-tool-result-content").put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", sha256(bytes))
                .put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
        for (int attempt = 0; attempt < 2; attempt++) {
            mvc.perform(post(base + "/tool-results:publish").header(TenantContextFilter.HEADER, TENANT)
                    .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                    .contentType(MediaType.APPLICATION_JSON).content(body.toString()))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.resourceId").value("captured-segment"))
                    .andExpect(jsonPath("$.byteLength").value(bytes.length))
                    .andExpect(jsonPath("$.digest").value(sha256(bytes))).andExpect(jsonPath("$.bytesBase64").doesNotExist());
        }
        assertThat(jdbc.queryForObject("SELECT journal_revision FROM qwen_managed_session_journal_head WHERE session_id = ?",
                Long.class, session)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource WHERE session_id = ?",
                Long.class, session)).isEqualTo(1);
        mvc.perform(get(base + "/resources/captured-segment").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A).param("workspaceId", WORKSPACE))
                .andExpect(status().isOk()).andExpect(content().bytes(bytes));
        ObjectNode changed = body.deepCopy().put("bytesBase64", Base64.getEncoder().encodeToString(new byte[bytes.length]))
                .put("digest", sha256(new byte[bytes.length]));
        mvc.perform(post(base + "/tool-results:publish").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(changed.toString()))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("managed_session_resource_conflict"));
        mvc.perform(post(base + "/tool-results:publish").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(body.deepCopy().put("kind", "managed-tool-result-page").toString()))
                .andExpect(status().isPayloadTooLarge());
        mvc.perform(post(base + "/tool-results:publish").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(body.deepCopy().put("digest", "0".repeat(64)).toString()))
                .andExpect(status().isBadRequest());
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00' WHERE session_id = ?", session);
        mvc.perform(post(base + "/tool-results:publish").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString())).andExpect(status().isConflict());
        mvc.perform(post(base + "/writers:acquire").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_B)
                .contentType(MediaType.APPLICATION_JSON).content(writerRequest(WRITER_B).toString())).andExpect(status().isOk());
        mvc.perform(post(base + "/tool-results:publish").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(body.toString())).andExpect(status().isConflict());
        mvc.perform(get(base + "/resources/captured-segment").header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_B).param("workspaceId", WORKSPACE))
                .andExpect(status().isOk()).andExpect(content().bytes(bytes));
    }

    @Test
    void commitsChunkedMessagesAtomicallyAndKeepsTheAggregateBudget() throws Exception {
        String session = SESSION + "-chunked";
        String base = "/internal/managed-session-store/v1/sessions/" + session;
        mvc.perform(post(base + "/writers:acquire")
                .header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON)
                .content(writerRequest(WRITER_A).toString())).andExpect(status().isOk());
        ObjectNode request = genesisRequest("{\"subtype\":\"session_execution_engine\"}\n"
                + "{\"subtype\":\"managed_session_header_v1\"}\n", new byte[0]);
        ArrayNode resources = request.withArray("resources");
        ObjectNode manifest = objectMapper.createObjectNode();
        ArrayNode parts = manifest.putArray("parts");
        byte[] body = ("{\"text\":\"" + "长😀".repeat(32_000) + "\"}").getBytes(StandardCharsets.UTF_8);
        for (int offset = 0; offset < body.length; offset += 60 * 1024) {
            byte[] bytes = Arrays.copyOfRange(body, offset, Math.min(body.length, offset + 60 * 1024));
            ObjectNode part = resources.addObject().put("resourceId", "part-" + offset)
                    .put("kind", "managed-message-part").put("schemaVersion", 1)
                    .put("byteLength", bytes.length).put("digest", sha256(bytes))
                    .put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
            ObjectNode ref = part.deepCopy();
            ref.remove("bytesBase64");
            parts.add(ref);
        }
        byte[] manifestBytes = objectMapper.writeValueAsBytes(manifest);
        resources.addObject().put("resourceId", "message-manifest")
                .put("kind", "managed-message-chunks").put("schemaVersion", 1)
                .put("byteLength", manifestBytes.length).put("digest", sha256(manifestBytes))
                .put("bytesBase64", Base64.getEncoder().encodeToString(manifestBytes));
        int resourceCount = resources.size();
        resources.addObject().put("resourceId", "missing-part")
                .put("kind", "managed-message-part").put("schemaVersion", 1)
                .put("byteLength", 1).put("digest", sha256(new byte[1]));
        mvc.perform(post(base + "/transactions:commit")
                .header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(request.toString()))
                .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource WHERE session_id=?",
                Integer.class, session)).isZero();
        resources.remove(resourceCount);
        for (int attempt = 0; attempt < 2; attempt++) {
            mvc.perform(post(base + "/transactions:commit")
                    .header(TenantContextFilter.HEADER, TENANT)
                    .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                    .contentType(MediaType.APPLICATION_JSON).content(request.toString()))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.journalRevision").value(1))
                    .andExpect(jsonPath("$.replayed").value(attempt == 1));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource WHERE session_id=?",
                Integer.class, session)).isEqualTo(resourceCount);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource WHERE session_id=? AND resource_id='resource-context'",
                Integer.class, session)).isEqualTo(1);
        ObjectNode oversized = request.deepCopy();
        ArrayNode oversizedResources = oversized.withArray("resources");
        int inlineBytes = 0;
        for (JsonNode resource : oversizedResources) {
            inlineBytes += resource.get("byteLength").asInt();
        }
        for (int index = 0; inlineBytes < ManagedSessionStoreModels.MAX_TRANSACTION_BYTES; index++) {
            byte[] bytes = new byte[Math.min(ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES,
                    ManagedSessionStoreModels.MAX_TRANSACTION_BYTES - inlineBytes)];
            oversizedResources.addObject().put("resourceId", "budget-part-" + index)
                    .put("kind", "managed-message-part").put("schemaVersion", 1)
                    .put("byteLength", bytes.length).put("digest", sha256(bytes))
                    .put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
            inlineBytes += bytes.length;
        }
        assertThat(inlineBytes).isEqualTo(8 * 1024 * 1024);
        mvc.perform(post(base + "/transactions:commit")
                .header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(oversized.toString()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.replayed").value(true));
        byte[] excess = new byte[1];
        oversizedResources.addObject().put("resourceId", "budget-overflow")
                .put("kind", "managed-message-part").put("schemaVersion", 1)
                .put("byteLength", excess.length).put("digest", sha256(excess))
                .put("bytesBase64", Base64.getEncoder().encodeToString(excess));
        mvc.perform(post(base + "/transactions:commit")
                .header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, TOKEN_A)
                .contentType(MediaType.APPLICATION_JSON).content(oversized.toString()))
                .andExpect(status().isPayloadTooLarge());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource WHERE session_id=?",
                Integer.class, session)).isEqualTo(resourceCount);
    }

    @Test
    void fencesWritersAndReplaysExactTransactions() throws Exception {
        JsonNode grantA = json(postWithToken("/writers:acquire", TOKEN_A,
                writerRequest(WRITER_A)).getResponse()
                .getContentAsString());
        assertThat(grantA.get("writerGeneration").asLong()).isEqualTo(1);
        assertThat(grantA.get("journalRevision").asLong()).isZero();

        mvc.perform(get(BASE + "/restore")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_writer_conflict"));

        mvc.perform(post(BASE + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(writerRequest(WRITER_B).toString()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_writer_conflict"));

        byte[] resourceBytes = new byte[
                ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES];
        Arrays.fill(resourceBytes, (byte) 'x');
        String genesisBytes = "{\"subtype\":\"session_execution_engine\"}\n"
                + "{\"subtype\":\"managed_session_header_v1\"}\n";
        ObjectNode genesis = genesisRequest(genesisBytes, resourceBytes);
        MvcResult committed = postWithToken("/transactions:commit", TOKEN_A,
                genesis);
        JsonNode firstReceipt = json(
                committed.getResponse().getContentAsString());
        assertThat(firstReceipt.get("journalRevision").asLong()).isEqualTo(1);
        assertThat(firstReceipt.get("replayed").asBoolean()).isFalse();

        MvcResult replayed = postWithToken("/transactions:commit", TOKEN_A,
                genesis);
        JsonNode replayReceipt = json(
                replayed.getResponse().getContentAsString());
        assertThat(replayReceipt.get("journalRevision").asLong()).isEqualTo(1);
        assertThat(replayReceipt.get("transactionId").asText())
                .isEqualTo(firstReceipt.get("transactionId").asText());
        assertThat(replayReceipt.get("replayed").asBoolean()).isTrue();

        ObjectNode conflictingTransaction = genesis.deepCopy();
        conflictingTransaction.put("transactionId", "other-transaction");
        mvc.perform(post(BASE + "/transactions:commit")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(conflictingTransaction.toString()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_idempotency_conflict"));

        ObjectNode conflictingGenesis = genesis.deepCopy();
        String changedBytes = genesisBytes.replace("header_v1", "changed_v1");
        conflictingGenesis.put("recordBytesBase64", base64(changedBytes));
        conflictingGenesis.put("recordDigest", sha256(changedBytes));
        conflictingGenesis.put("contentDigest", sha256("changed"));
        mvc.perform(post(BASE + "/transactions:commit")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(conflictingGenesis.toString()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_idempotency_conflict"));

        mvc.perform(get(BASE + "/transactions")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL,
                        "no-store"))
                .andExpect(jsonPath("$.transactions.length()").value(1))
                .andExpect(jsonPath("$.transactions[0].recordBytesBase64")
                        .value(base64(genesisBytes)))
                .andExpect(jsonPath("$.nextRevision").value(1));

        mvc.perform(get(BASE + "/transactions")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .param("workspaceId", WORKSPACE)
                        .param("afterRevision", "9007199254740991"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("invalid_managed_session_store_request"));

        mvc.perform(get(BASE + "/resources/resource-context")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Resource-Digest",
                        sha256(resourceBytes)))
                .andExpect(content().bytes(resourceBytes));

        ObjectNode renew = objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", WRITER_A)
                .put("writerGeneration", 1)
                .put("leaseMillis", 60_000);
        JsonNode renewed = json(postWithToken("/writers:renew", TOKEN_A,
                renew).getResponse().getContentAsString());
        assertThat(renewed.get("writerGeneration").asLong()).isEqualTo(1);

        ObjectNode seal = objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", WRITER_A)
                .put("writerGeneration", 1);
        postWithToken("/writers:seal", TOKEN_A, seal);
        JsonNode sealReplay = json(postWithToken("/writers:seal", TOKEN_A,
                seal).getResponse().getContentAsString());
        assertThat(sealReplay.get("replayed").asBoolean()).isTrue();
        JsonNode grantB = json(postWithToken("/writers:acquire", TOKEN_B,
                writerRequest(WRITER_B)).getResponse()
                .getContentAsString());
        assertThat(grantB.get("writerGeneration").asLong()).isEqualTo(2);
        mvc.perform(get(BASE + "/restore")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_writer_conflict"));

        // The event and its bytes live in TurnEventLines, which the reader
        // replay replays too, so this happy path stays authority-valid.
        String turnBytes = TurnEventLines.turnBytes(TENANT, WORKSPACE,
                SESSION);
        ObjectNode turn = transactionRequest(turnBytes, WRITER_A, 1);
        byte[] checkpointBytes = "checkpoint-state"
                .getBytes(StandardCharsets.UTF_8);
        turn.put("latestCheckpointResourceId", "resource-checkpoint");
        turn.putArray("resources").addObject()
                .put("resourceId", "resource-checkpoint")
                .put("kind", "managed-checkpoint")
                .put("schemaVersion", 1)
                .put("byteLength", checkpointBytes.length)
                .put("digest", sha256(checkpointBytes))
                .put("bytesBase64", Base64.getEncoder()
                        .encodeToString(checkpointBytes));
        mvc.perform(post(BASE + "/transactions:commit")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(turn.toString()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_writer_conflict"));

        turn.put("writerId", WRITER_B).put("writerGeneration", 2);
        JsonNode secondReceipt = json(postWithToken(
                "/transactions:commit", TOKEN_B, turn)
                .getResponse().getContentAsString());
        assertThat(secondReceipt.get("journalRevision").asLong())
                .isEqualTo(2);
        assertThat(secondReceipt.get("committedSequence").asLong())
                .isEqualTo(1);

        mvc.perform(get(BASE + "/transactions")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", WORKSPACE)
                        .param("limit", "1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.transactions.length()")
                        .value(1))
                .andExpect(jsonPath("$.nextRevision").value(1))
                .andExpect(jsonPath("$.hasMore").value(true));
        mvc.perform(get(BASE + "/transactions")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", WORKSPACE)
                        .param("afterRevision", "1")
                        .param("limit", "1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.transactions[0]"
                        + ".latestCheckpointResourceId")
                        .value("resource-checkpoint"))
                .andExpect(jsonPath("$.nextRevision").value(2))
                .andExpect(jsonPath("$.hasMore").value(false));

        JsonNode fencedReplay = json(postWithToken(
                "/transactions:commit", TOKEN_A, genesis)
                .getResponse().getContentAsString());
        assertThat(fencedReplay.get("replayed").asBoolean()).isTrue();
        mvc.perform(post(BASE + "/transactions:commit")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(turn.toString()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_idempotency_conflict"));

        mvc.perform(get(BASE + "/restore")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.journalRevision").value(2))
                .andExpect(jsonPath("$.committedSequence").value(1))
                .andExpect(jsonPath("$.lastCommitDigest")
                        .value("c".repeat(64)))
                .andExpect(jsonPath("$.latestCheckpointResourceId")
                        .value("resource-checkpoint"))
                .andExpect(jsonPath("$.recoveryStatus").value("READY"));

        mvc.perform(get(BASE + "/restore")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", "other-workspace"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_not_found"));

        // Its own bytes hold the event at sequence 2, so only the oversized
        // resource can refuse this commit.
        String oversizedBytes = turnBytes.replace("\"sequence\":1,",
                "\"sequence\":2,").replace("turn-1:accepted",
                        "turn-2:accepted");
        ObjectNode oversized = transactionRequest(oversizedBytes, WRITER_B, 2)
                .put("transactionId", "transaction-oversized")
                .put("commandId", "command-oversized")
                .put("expectedJournalRevision", 2)
                .put("expectedCommittedSequence", 1)
                .put("firstSequence", 2)
                .put("lastSequence", 2)
                .put("previousCommitDigest", "c".repeat(64));
        oversized.withArray("resources").addObject()
                .put("resourceId", "resource-oversized")
                .put("kind", "managed-context")
                .put("schemaVersion", 1)
                .put("byteLength",
                        ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES + 1)
                .put("digest", "d".repeat(64));
        mvc.perform(post(BASE + "/transactions:commit")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(oversized.toString()))
                .andExpect(status().isNotImplemented())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_oss_disabled"));

        ObjectNode recoveryBlock = objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", WRITER_B)
                .put("writerGeneration", 2)
                .put("recoveryStatus", "BLOCKED_EXECUTION")
                .put("recoveryDetailCode",
                        "runtime_execution_outcome_unknown");
        mvc.perform(post(BASE + "/recovery:block")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_A)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(recoveryBlock.toString()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_writer_conflict"));
        postWithToken("/recovery:block", TOKEN_B, recoveryBlock)
                .getResponse();
        mvc.perform(post(BASE + "/recovery:block")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(recoveryBlock.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.recoveryStatus")
                        .value("BLOCKED_EXECUTION"))
                .andExpect(jsonPath("$.recoveryDetailCode")
                        .value("runtime_execution_outcome_unknown"))
                .andExpect(jsonPath("$.replayed").value(true));
        ObjectNode conflictingBlock = recoveryBlock.deepCopy()
                .put("recoveryStatus", "BLOCKED_WORKSPACE")
                .put("recoveryDetailCode", "workspace_snapshot_missing");
        mvc.perform(post(BASE + "/recovery:block")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(conflictingBlock.toString()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_recovery_conflict"));
        mvc.perform(get(BASE + "/restore")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.recoveryStatus")
                        .value("BLOCKED_EXECUTION"))
                .andExpect(jsonPath("$.recoveryDetailCode")
                        .value("runtime_execution_outcome_unknown"));
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " recovery_status = 'READY',"
                        + " recovery_detail_code = NULL WHERE tenant_id = ?"
                        + " AND session_id = ?",
                TENANT, SESSION);

        jdbc.update("UPDATE qwen_managed_session_journal_head"
                        + " SET recovery_status = 'UNKNOWN'"
                        + " WHERE tenant_id = ? AND session_id = ?",
                TENANT, SESSION);
        mvc.perform(get(BASE + "/restore")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_head_corrupt"));
        jdbc.update("UPDATE qwen_managed_session_journal_head"
                        + " SET recovery_status = 'READY'"
                        + " WHERE tenant_id = ? AND session_id = ?",
                TENANT, SESSION);
        jdbc.update("DELETE FROM qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND journal_revision = 1",
                TENANT, SESSION);
        mvc.perform(get(BASE + "/transactions")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN_B)
                        .param("workspaceId", WORKSPACE))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code")
                        .value("managed_session_journal_corrupt"));
    }

    @Test
    void holdsRestorePagesInsideThePerPageByteBudget() throws Exception {
        String session = "budget-" + UUID.randomUUID();
        String base = "/internal/managed-session-store/v1/sessions/"
                + session;
        String token = "d".repeat(32);
        mvc.perform(post(base + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(writerRequest(WRITER_A).toString()))
                .andExpect(status().isOk());

        // One tiny genesis plus eleven dense transactions of ~1 MB each:
        // the budget must cut the page before bytes show past 8 MiB,
        // whatever the count limit allows. The commit gate holds every line
        // in the event range to the authority's event envelope, and the
        // reader caps a delta's text at 4096 bytes, so the density comes
        // from the event count (210 deltas, under MAX_TRANSACTION_EVENTS),
        // not from one padded line.
        int deltas = 210;
        List<Integer> sizes = new ArrayList<>();
        java.util.function.BiConsumer<String, Integer> commit =
                (padChar, revision) -> {
                    try {
                        String records;
                        ObjectNode request;
                        if (revision == 1) {
                            // Genesis stays canonical: exactly two small
                            // records (session.create requires recordCount 2).
                            records =
                                    "{\"subtype\":\"session_execution_engine\"}\n"
                                            + "{\"subtype\":\"managed_session_header_v1\"}\n";
                            request = genesisRequest(records, new byte[1024]);
                        } else {
                            long first = (revision - 2L) * deltas + 1;
                            records = TurnEventLines.deltaBytes(TENANT,
                                    WORKSPACE, session, first, deltas,
                                    padChar.repeat(TurnEventLines
                                            .MAX_DELTA_TEXT_BYTES));
                            request = transactionRequest(records, WRITER_A, 1)
                                    .put("expectedJournalRevision",
                                            revision - 1)
                                    .put("expectedCommittedSequence",
                                            first - 1)
                                    .put("firstSequence", first)
                                    .put("lastSequence", first + deltas - 1)
                                    .put("eventCount", deltas)
                                    .put("recordCount", deltas + 1)
                                    .put("transactionId",
                                            "transaction-blob-" + revision)
                                    .put("commandId",
                                            "command-blob-" + revision);
                            if (revision >= 3) {
                                request.put("previousCommitDigest",
                                        "c".repeat(64));
                            }
                        }
                        sizes.add(records.getBytes(StandardCharsets.UTF_8)
                                .length);
                        var result = mvc.perform(post(base + "/transactions:commit")
                                        .header(TenantContextFilter.HEADER,
                                                TENANT)
                                        .header(ManagedSessionStoreModels
                                                        .WRITER_TOKEN_HEADER,
                                                token)
                                        .contentType(MediaType.APPLICATION_JSON)
                                        .content(request.toString()))
                                .andReturn();
                        if (result.getResponse().getStatus() != 200) {
                            String body = result.getResponse()
                                    .getContentAsString();
                            throw new IllegalStateException(
                                    "commit at revision " + revision + " -> "
                                            + result.getResponse().getStatus()
                                            + " " + body.substring(0,
                                                    Math.min(240,
                                                            body.length())));
                        }
                    } catch (IllegalStateException error) {
                        throw error;
                    } catch (Exception error) {
                        throw new IllegalStateException(
                                "commit at revision " + revision, error);
                    }
                };
        // The genesis is tiny; eleven dense transactions carry the
        // cumulative bytes past 8 MiB.
        for (int revision = 1; revision <= 12; revision++) {
            commit.accept(String.valueOf((char) ('a' + revision - 1)), revision);
        }
        // The split below holds only while revisions 1..9 fit the budget
        // and a tenth does not.
        long firstPage = sizes.subList(0, 9).stream()
                .mapToLong(Integer::longValue).sum();
        assertThat(firstPage).isLessThanOrEqualTo(
                ManagedSessionStoreModels.MAX_TRANSACTION_BYTES);
        assertThat(firstPage + sizes.get(9)).isGreaterThan(
                ManagedSessionStoreModels.MAX_TRANSACTION_BYTES);

        // The byte budget cuts the page even under a generous count limit;
        // the follow-up page reaches the remaining rows.
        mvc.perform(get(base + "/transactions")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .param("workspaceId", WORKSPACE)
                        .param("limit", "10"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.transactions.length()").value(9))
                .andExpect(jsonPath("$.transactions[0].journalRevision")
                        .value(1))
                .andExpect(jsonPath("$.transactions[8].journalRevision")
                        .value(9))
                .andExpect(jsonPath("$.hasMore").value(true));
        mvc.perform(get(base + "/transactions")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .param("workspaceId", WORKSPACE)
                        .param("afterRevision", "9")
                        .param("limit", "10"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.transactions.length()").value(3))
                .andExpect(jsonPath("$.transactions[0].journalRevision")
                        .value(10))
                .andExpect(jsonPath("$.transactions[2].journalRevision")
                        .value(12))
                .andExpect(jsonPath("$.hasMore").value(false));
    }

    private ObjectNode writerRequest(String writerId) {
        return objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", writerId)
                .put("leaseMillis", 60_000);
    }

    private ObjectNode genesisRequest(String records, byte[] resourceBytes) {
        ObjectNode request = objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", WRITER_A)
                .put("writerGeneration", 1)
                .put("expectedJournalRevision", 0)
                .put("expectedCommittedSequence", 0)
                .put("transactionId", "transaction-genesis")
                .put("operation", "session.create")
                .put("commandId", "command-genesis")
                .put("contentDigest", sha256(records))
                .put("firstSequence", 0)
                .put("lastSequence", 0)
                .put("eventCount", 0)
                .put("activationEpoch", 0)
                .put("recordCount", 2)
                .put("recordBytesBase64", base64(records))
                .put("recordDigest", sha256(records));
        ArrayNode resources = request.putArray("resources");
        resources.addObject()
                .put("resourceId", "resource-context")
                .put("kind", "managed-context")
                .put("schemaVersion", 1)
                .put("byteLength", resourceBytes.length)
                .put("digest", sha256(resourceBytes))
                .put("bytesBase64", Base64.getEncoder()
                        .encodeToString(resourceBytes));
        return request;
    }

    private ObjectNode transactionRequest(String records, String writerId,
            long generation) {
        return objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", writerId)
                .put("writerGeneration", generation)
                .put("expectedJournalRevision", 1)
                .put("expectedCommittedSequence", 0)
                .put("transactionId", "transaction-turn")
                .put("operation", "turn.submit")
                .put("commandId", "command-turn")
                .put("contentDigest", sha256("turn-content"))
                .put("firstSequence", 1)
                .put("lastSequence", 1)
                .put("eventCount", 1)
                .put("eventsDigest", "e".repeat(64))
                .put("commitDigest", "c".repeat(64))
                .put("activationEpoch", 0)
                .put("recordCount", 2)
                .put("recordBytesBase64", base64(records))
                .put("recordDigest", sha256(records));
    }

    private MvcResult postWithToken(String path, String token,
            JsonNode body) throws Exception {
        return mvc.perform(post(BASE + path)
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body.toString()))
                .andExpect(status().isOk()).andReturn();
    }

    private JsonNode json(String value) throws Exception {
        return objectMapper.readTree(value);
    }

    private static String base64(String value) {
        return Base64.getEncoder().encodeToString(
                value.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(String value) {
        return sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
