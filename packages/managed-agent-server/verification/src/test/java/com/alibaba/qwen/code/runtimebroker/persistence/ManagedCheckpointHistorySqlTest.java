package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.ManagedCheckpointHistory;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

public class ManagedCheckpointHistorySqlTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "a".repeat(32);
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private String session;
    private ObjectNode pageRef;

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:checkpoint-history-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    public void setUp() throws Exception {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        var store = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc);
        session = UUID.randomUUID().toString();
        transaction.execute(status -> store.acquireWriter("tenant", session, TOKEN,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 60_000L)));
        ObjectNode page = JSON.createObjectNode().put("storageProfile", ManagedCheckpointHistory.KIND + "/1")
                .put("turnId", "turn").put("promptId", "prompt").put("toolCount", 1).put("bindingCount", 0);
        page.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", session);
        page.putNull("previous");
        page.putArray("bindings");
        ObjectNode outcome = resource("outcome", "managed-tool-outcome", "{}");
        ObjectNode outcomeRef = outcome.deepCopy();
        outcomeRef.remove("bytesBase64");
        page.putArray("items").addObject().put("state", "settled").put("consumed", true)
                .put("executionCallId", "execution").put("functionCallId", "call").put("ordinal", 0)
                .set("outcomeRef", outcomeRef);
        ObjectNode storedPage = resource("page", ManagedCheckpointHistory.KIND, page.toString());
        pageRef = storedPage.deepCopy();
        pageRef.remove("bytesBase64");
        String records = "{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n";
        ObjectNode commit = JSON.createObjectNode().put("workspaceId", "workspace").put("writerId", "writer")
                .put("writerGeneration", 1).put("expectedJournalRevision", 0).put("expectedCommittedSequence", 0)
                .put("transactionId", "genesis").put("operation", "session.create").put("commandId", "genesis")
                .put("contentDigest", DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8)))
                .put("firstSequence", 0).put("lastSequence", 0).put("eventCount", 0).put("activationEpoch", 0)
                .put("recordCount", 2).put("recordDigest", DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8)))
                .put("recordBytesBase64", Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        commit.putArray("resources").add(outcome).add(storedPage);
        var request = JSON.treeToValue(commit, ManagedSessionStoreModels.CommitTransactionRequest.class);
        transaction.execute(status -> store.commit("tenant", session, TOKEN, request));
    }

    @Test
    public void committedCheckpointHydratesItsCommittedPage() throws Exception {
        ObjectNode root = commitCheckpoint();
        ObjectNode ref = resource("root", "managed-checkpoint", root.toString());
        ref.remove("bytesBase64");
        assertThat(ManagedCheckpointHistory.page(committedResource(pageRef)).path("toolCount").longValue()).isEqualTo(1);
        JsonNode state = ManagedCheckpointHistory.readCheckpoint(ref, this::committedResource);
        assertThat(state).isEqualTo(ManagedCheckpointHistory.hydrate(root, this::committedResource));
        assertThat(state.has("storageProfile")).isFalse();
        assertThat(state.has("history")).isFalse();
        assertThat(state.path("tools").path("items").size()).isEqualTo(1);
        assertThat(state.path("tools").path("items").get(0).path("executionCallId").textValue()).isEqualTo("execution");
        assertThat(state.path("tools").path("items").get(0).path("outcomeRef").path("resourceId").textValue())
                .isEqualTo("outcome");
        assertThat(committedResource(state.path("contextRef"))).isEqualTo("{}".getBytes(StandardCharsets.UTF_8));
    }

    private byte[] committedResource(JsonNode ref) {
        return com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc)
                .readResource("tenant", "workspace", session, ref.path("resourceId").asText(), TOKEN).bytes();
    }

    private ObjectNode commitCheckpoint() throws Exception {
        ObjectNode active = resource("active", "managed-context", "{}");
        ObjectNode activeRef = active.deepCopy();
        activeRef.remove("bytesBase64");
        ObjectNode root = JSON.createObjectNode().put("storageProfile", ManagedCheckpointHistory.PROFILE);
        root.putObject("identity").put("turnId", "turn").put("promptId", "prompt")
                .putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace")
                .put("sessionId", session);
        root.putObject("tools").putArray("items");
        root.putNull("runtime");
        root.set("contextRef", activeRef);
        root.putObject("history").put("toolCount", 1).put("bindingCount", 0).set("ref", pageRef);
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", 1).put("eventId", "delta")
                .put("kind", "message.delta").put("occurredAt", 1000);
        event.set("sessionKey", root.path("identity").path("sessionKey"));
        event.putObject("payload").put("messageId", "message").put("turnId", "turn")
                .put("role", "assistant").put("text", "test");
        ObjectNode line = JSON.createObjectNode().put("subtype", "managed_session_event_v1");
        line.set("managedSession", event);
        String records = line + "\n{\"subtype\":\"managed_session_commit_v1\"}\n";
        ObjectNode commit = JSON.createObjectNode().put("workspaceId", "workspace").put("writerId", "writer")
                .put("writerGeneration", 1).put("expectedJournalRevision", 1).put("expectedCommittedSequence", 0)
                .put("transactionId", "checkpoint").put("operation", "commitCheckpoint").put("commandId", "checkpoint")
                .put("contentDigest", DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8)))
                .put("firstSequence", 1).put("lastSequence", 1).put("eventCount", 1).put("activationEpoch", 0)
                .put("eventsDigest", "e".repeat(64)).put("commitDigest", "c".repeat(64))
                .put("latestCheckpointResourceId", "root")
                .put("recordCount", 2).put("recordDigest", DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8)))
                .put("recordBytesBase64", Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        commit.putArray("resources").add(active).add(resource("root", "managed-checkpoint", root.toString())).add(pageRef);
        var request = JSON.treeToValue(commit, ManagedSessionStoreModels.CommitTransactionRequest.class);
        transaction.execute(status -> com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc)
                .commit("tenant", session, TOKEN, request));
        return root;
    }

    private static ObjectNode resource(String id, String kind, String body) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", DigestUtils.sha256Hex(bytes))
                .put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
    }
}