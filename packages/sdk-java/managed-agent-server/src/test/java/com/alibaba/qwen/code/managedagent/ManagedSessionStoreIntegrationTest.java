package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
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
@AutoConfigureMockMvc
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

        String turnBytes = "{\"subtype\":\"managed_session_event_v1\"}\n"
                + "{\"subtype\":\"managed_session_commit_v1\"}\n";
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

        ObjectNode oversized = transactionRequest(turnBytes, WRITER_B, 2)
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
