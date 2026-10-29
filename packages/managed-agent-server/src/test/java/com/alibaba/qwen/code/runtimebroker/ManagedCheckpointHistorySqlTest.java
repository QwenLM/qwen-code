package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class ManagedCheckpointHistorySqlTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private JdbcCsiFilesRetirementGuard.Original original;
    private ObjectNode pageRef;

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:checkpoint-history-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setUp() throws Exception {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        var store = new ManagedSessionStore(jdbc);
        String session = UUID.randomUUID().toString();
        original = new JdbcCsiFilesRetirementGuard.Original(CsiFilesRetirementProfile.request(new ContextBinding(
                "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1),
                "/workspace", session), "binding", 1, RuntimeBindingRecord.State.READY, false, 1, 1L);
        String token = "a".repeat(32);
        transaction.execute(status -> store.acquireWriter("tenant", session, token,
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
                .put("contentDigest", CsiNativeActivationProof.sha256(records.getBytes(StandardCharsets.UTF_8)))
                .put("firstSequence", 0).put("lastSequence", 0).put("eventCount", 0).put("activationEpoch", 0)
                .put("recordCount", 2).put("recordDigest", CsiNativeActivationProof.sha256(records.getBytes(StandardCharsets.UTF_8)))
                .put("recordBytesBase64", Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        commit.putArray("resources").add(outcome).add(storedPage);
        var request = JSON.treeToValue(commit, ManagedSessionStoreModels.CommitTransactionRequest.class);
        transaction.execute(status -> store.commit("tenant", session, token, request));
    }

    @Test
    void pageChannelReadsEarlierCommittedOwnershipWhileOrdinaryReadsRemainExact() {
        transaction.execute(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
            var reader = JdbcCsiActivationAdmission.checkpointReader(connection, original, 2,
                    JdbcCsiActivationAdmission.JournalRead.LIVE);
            assertThatThrownBy(() -> reader.apply(pageRef)).isInstanceOf(RuntimeBrokerException.class);
            var page = reader.historicalPage(pageRef, 2);
            assertThat(page.revision()).isEqualTo(1);
            assertThat(ManagedCheckpointHistory.page(page.bytes()).path("toolCount").longValue()).isEqualTo(1);
            ObjectNode corrupt = pageRef.deepCopy().put("digest", "0".repeat(64));
            assertThatThrownBy(() -> reader.historicalPage(corrupt, 2)).isInstanceOf(RuntimeBrokerException.class);
            assertThatThrownBy(() -> reader.historicalPage(pageRef, 0)).isInstanceOf(RuntimeBrokerException.class);
            return null;
        }));
    }

    @Test
    void hydratesACommittedPageFromAnEarlierRevision() throws Exception {
        ObjectNode root = commitCheckpoint();
        transaction.execute(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
            var sql = JdbcCsiActivationAdmission.checkpointReader(connection, original, 2,
                    JdbcCsiActivationAdmission.JournalRead.LIVE);
            assertThat(sql.historicalPage(pageRef, 2).revision()).isEqualTo(1);
            for (var reader : List.of(sql, historicalOnly(sql))) {
                JsonNode state = ManagedCheckpointHistory.hydrate(root, reader);
                assertThat(state.has("storageProfile")).isFalse();
                assertThat(state.has("history")).isFalse();
                assertThat(state.path("tools").path("items").size()).isEqualTo(1);
                assertThat(state.path("tools").path("items").get(0).path("executionCallId").textValue()).isEqualTo("execution");
                JsonNode outcome = state.path("tools").path("items").get(0).path("outcomeRef");
                assertThat(outcome.path("resourceId").textValue()).isEqualTo("outcome");
                assertThatThrownBy(() -> reader.apply(outcome)).isInstanceOf(RuntimeBrokerException.class);
            }
            return null;
        }));
    }

    @Test
    void proofReadsEarlierPagesWhileActiveReferencesStillRequireCurrentOwnership() throws Exception {
        ObjectNode root = commitCheckpoint();
        ObjectNode ref = resource("root", "managed-checkpoint", root.toString());
        ref.remove("bytesBase64");
        transaction.execute(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
            var sql = JdbcCsiActivationAdmission.checkpointReader(connection, original, 2,
                    JdbcCsiActivationAdmission.JournalRead.LIVE);
            for (var reader : List.of(sql, historicalOnly(sql))) {
                JsonNode state = CsiNativeActivationProof.readCheckpoint(ref, reader);
                assertThat(state).isEqualTo(ManagedCheckpointHistory.hydrate(root, reader));
                assertThat(reader.apply(state.path("contextRef"))).isEqualTo("{}".getBytes(StandardCharsets.UTF_8));
            }
            jdbc.update("DELETE FROM ma_resource_ref WHERE resource_id = ?", "active");
            for (var reader : List.of(sql, historicalOnly(sql))) {
                assertThatThrownBy(() -> CsiNativeActivationProof.readCheckpoint(ref, reader))
                        .isInstanceOf(RuntimeBrokerException.class);
            }
            return null;
        }));
    }

    private ObjectNode commitCheckpoint() throws Exception {
        ObjectNode active = resource("active", "managed-context", "{}");
        ObjectNode activeRef = active.deepCopy();
        activeRef.remove("bytesBase64");
        ObjectNode root = JSON.createObjectNode().put("storageProfile", ManagedCheckpointHistory.PROFILE);
        root.putObject("identity").put("turnId", "turn").put("promptId", "prompt")
                .putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace")
                .put("sessionId", original.request().getIsolationKey());
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
                .put("contentDigest", CsiNativeActivationProof.sha256(records.getBytes(StandardCharsets.UTF_8)))
                .put("firstSequence", 1).put("lastSequence", 1).put("eventCount", 1).put("activationEpoch", 0)
                .put("eventsDigest", "e".repeat(64)).put("commitDigest", "c".repeat(64))
                .put("latestCheckpointResourceId", "root")
                .put("recordCount", 2).put("recordDigest", CsiNativeActivationProof.sha256(records.getBytes(StandardCharsets.UTF_8)))
                .put("recordBytesBase64", Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        commit.putArray("resources").add(active).add(resource("root", "managed-checkpoint", root.toString())).add(pageRef);
        var request = JSON.treeToValue(commit, ManagedSessionStoreModels.CommitTransactionRequest.class);
        transaction.execute(status -> new ManagedSessionStore(jdbc).commit("tenant", original.request().getIsolationKey(),
                "a".repeat(32), request));
        return root;
    }

    private static ManagedCheckpointHistory.Reader historicalOnly(ManagedCheckpointHistory.Reader sql) {
        return ManagedCheckpointHistory.reader(ref -> {
            assertThat(ref.path("kind").textValue()).isNotEqualTo(ManagedCheckpointHistory.KIND);
            return sql.apply(ref);
        }, sql::historicalPage, sql.revision());
    }

    @Test
    void ownershipWithoutItsCommittedTransactionCannotBeReused() {
        jdbc.update("DELETE FROM ma_session_journal_tx");
        assertNoHistory();
    }

    @Test
    void committedOwnershipAfterThePinnedRevisionCannotBeReused() {
        jdbc.update("UPDATE ma_session_journal_tx SET journal_revision = 99");
        jdbc.update("UPDATE ma_resource_ref SET owner_revision = 99, journal_revision = 99");
        assertNoHistory();
    }

    private void assertNoHistory() {
        transaction.execute(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
            var reader = JdbcCsiActivationAdmission.checkpointReader(connection, original, 2,
                    JdbcCsiActivationAdmission.JournalRead.LIVE);
            assertThatThrownBy(() -> reader.historicalPage(pageRef, 2)).isInstanceOf(RuntimeBrokerException.class);
            return null;
        }));
    }

    private static ObjectNode resource(String id, String kind, String body) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", CsiNativeActivationProof.sha256(bytes))
                .put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
    }
}
