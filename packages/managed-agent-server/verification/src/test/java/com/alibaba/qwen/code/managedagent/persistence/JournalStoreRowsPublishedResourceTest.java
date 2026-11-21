package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The commit gate must accept a running background capture's published
 * tool-result resources exactly as the reader and the storage verifier
 * already do; admission only promotes them to REFERENCED once the
 * completed capture is VERIFIED, while the child-run journal references
 * the manifest mid-run.
 */
class JournalStoreRowsPublishedResourceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "a".repeat(32);
    private static final String TENANT = "tenant";
    private static final String WORKSPACE = "workspace";

    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private JdbcManagedSessionStore sessionStore;
    private JournalStoreRows storeRows;
    private String session;
    private String scope;

    @BeforeEach
    void setUp() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:journal-published-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        sessionStore = VerificationFixtures.managedSessionStore(jdbc);
        storeRows = new JournalStoreRows(jdbc, null);
        session = "sess-" + UUID.randomUUID();
        scope = ManagedSessionStore.sessionScopeKey(TENANT, session);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                + " gmt_create, gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                TENANT, session);
        long generation = transaction.execute(status -> sessionStore.acquireWriter(
                TENANT, session, TOKEN, new AcquireWriterRequest(WORKSPACE, "writer", 60_000L)))
                .writerGeneration();
        String records = "{\"subtype\":\"session_execution_engine\"}\n"
                + "{\"subtype\":\"managed_session_header_v1\"}\n";
        String digest = DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8));
        ObjectNode node = JSON.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", "writer")
                .put("writerGeneration", generation)
                .put("expectedJournalRevision", 0)
                .put("expectedCommittedSequence", 0)
                .put("transactionId", "genesis")
                .put("operation", "session.create")
                .put("commandId", "genesis")
                .put("contentDigest", digest)
                .put("firstSequence", 0)
                .put("lastSequence", 0)
                .put("eventCount", 0)
                .put("activationEpoch", 0)
                .put("recordCount", 2)
                .put("recordDigest", digest)
                .put("recordBytesBase64", Base64.getEncoder()
                        .encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        node.putArray("resources")
                .add(resource("man-1", "managed-tool-result-manifest", "{\"revision\":1}"))
                .add(resource("page-1", "managed-tool-result-page", "{\"page\":1}"))
                .add(resource("outcome-1", "managed-tool-outcome", "{}"))
                .add(resource("args-1", "managed-tool-args", "{\"command\":\"echo\"}"));
        CommitTransactionRequest request = JSON.treeToValue(node, CommitTransactionRequest.class);
        transaction.execute(status -> sessionStore.commit(TENANT, session, TOKEN, request));
    }

    @Test
    void acceptsPublishedRunningCaptureToolResultLikeTheReaderDoes() {
        publish("man-1");
        publish("page-1");
        ManagedSessionStoreModels.StoredResource manifest = transaction.execute(
                status -> storeRows.storedResource(scope, TENANT, WORKSPACE, session, "man-1"));
        assertThat(manifest.kind()).isEqualTo("managed-tool-result-manifest");
        ManagedSessionStoreModels.StoredResource page = transaction.execute(
                status -> storeRows.storedResource(scope, TENANT, WORKSPACE, session, "page-1"));
        assertThat(page.kind()).isEqualTo("managed-tool-result-page");
        ManagedSessionStoreModels.StoredResource args = transaction.execute(
                status -> storeRows.storedResource(scope, TENANT, WORKSPACE, session, "args-1"));
        assertThat(args.kind()).isEqualTo("managed-tool-args");
    }

    @Test
    void stillRefusesPublishedOutcomeEnvelope() {
        jdbc.update("UPDATE ma_resource SET state = 'PUBLISHED'"
                + " WHERE session_scope_key = ? AND resource_id = ?", scope, "outcome-1");
        assertThatThrownBy(() -> transaction.execute(
                status -> storeRows.storedResource(scope, TENANT, WORKSPACE, session, "outcome-1")))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error -> {
                    assertThat(((ManagedAgentException) error).getStatus()).isEqualTo(409);
                    assertThat(((ManagedAgentException) error).getCode())
                            .isEqualTo(ManagedSessionStoreModels.ERROR_RESOURCE_MISSING);
                });
    }

    @Test
    void publishedToolResultStillPassesStorageIntegrityVerification() {
        publish("man-1");
        jdbc.update("UPDATE ma_resource SET object_key = NULL"
                + " WHERE session_scope_key = ? AND resource_id = ?", scope, "man-1");
        assertThatThrownBy(() -> transaction.execute(
                status -> storeRows.storedResource(scope, TENANT, WORKSPACE, session, "man-1")))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error ->
                        assertThat(((ManagedAgentException) error).getStatus()).isEqualTo(500));
    }

    private void publish(String resourceId) {
        jdbc.update("UPDATE ma_resource SET state = 'PUBLISHED',"
                + " storage_kind = 'OSS_OBJECT', inline_bytes = NULL,"
                + " object_key = X'6b' WHERE session_scope_key = ? AND resource_id = ?",
                scope, resourceId);
    }

    private static ObjectNode resource(String id, String kind, String body) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind)
                .put("schemaVersion", 1).put("byteLength", bytes.length)
                .put("digest", DigestUtils.sha256Hex(bytes))
                .put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
    }
}
