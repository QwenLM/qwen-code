package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:publication-point;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true"
})
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class JournalEventPublicationPointTest {
    private static final String TENANT = "tenant-pubpoint";
    private static final String WORKSPACE = "workspace-pubpoint";
    private static final String WRITER = "writer-pubpoint";
    private static final String TOKEN =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String RECORDS =
            "{\"subtype\":\"session_execution_engine\"}\n"
                    + "{\"subtype\":\"managed_session_header_v1\"}\n";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    // The store-side handoff is pinned here with a stand-in; the LiteTopic
    // mapping of the published record is covered by LiteTopicEventTransportTest.
    @MockitoBean
    private JournalEventTransport journalEventTransport;

    @Test
    void publishesTheCommittedJournalAfterCommitButNotOnReplay()
            throws Exception {
        String session = "pubpoint-" + UUID.randomUUID();
        String storage = "storage-" + UUID.randomUUID();
        String base = "/internal/managed-session-store/v1/sessions/" + session;
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, tenant_key, session_key,"
                + " agent_id, status, gmt_create, gmt_modified,"
                + " workspace_storage_id, workspace_id, workspace_generation,"
                + " cwd_relative, context_config_ref, context_revision,"
                + " workspace_config_ref, workspace_policy_ref) VALUES (?, ?, ?, ?,"
                + " 'qwen-code', 'ACTIVE', 1, 1, ?, ?, 1, '.', ?, 1,"
                + " ?, ?)",
                TENANT, session, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(TENANT),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(session), storage, WORKSPACE,
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        mvc.perform(post(base + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(writerRequest().toString()))
                .andExpect(status().isOk());

        mvc.perform(post(base + "/transactions:commit")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(genesisRequest().toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.replayed").value(false));

        ArgumentCaptor<byte[]> published =
                ArgumentCaptor.forClass(byte[].class);
        verify(journalEventTransport).publishCommitted(published.capture());
        assertThat(new String(published.getValue(), StandardCharsets.UTF_8))
                .isEqualTo(RECORDS);

        // A replayed commit returns the original receipt before the
        // publication point, so the transport is not invoked a second time.
        mvc.perform(post(base + "/transactions:commit")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(genesisRequest().toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.replayed").value(true));
        verify(journalEventTransport, times(1))
                .publishCommitted(any(byte[].class));
    }

    private ObjectNode writerRequest() {
        return objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", WRITER)
                .put("leaseMillis", 60_000);
    }

    private ObjectNode genesisRequest() {
        byte[] resourceBytes = "pubpoint-context"
                .getBytes(StandardCharsets.UTF_8);
        ObjectNode request = objectMapper.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", WRITER)
                .put("writerGeneration", 1)
                .put("expectedJournalRevision", 0)
                .put("expectedCommittedSequence", 0)
                .put("transactionId", "transaction-genesis")
                .put("operation", "session.create")
                .put("commandId", "command-genesis")
                .put("contentDigest", sha256(RECORDS))
                .put("firstSequence", 0)
                .put("lastSequence", 0)
                .put("eventCount", 0)
                .put("activationEpoch", 0)
                .put("recordCount", 2)
                .put("recordBytesBase64", base64(RECORDS))
                .put("recordDigest", sha256(RECORDS));
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
