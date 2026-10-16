package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import javax.sql.DataSource;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Exercises actual writer/Broker/publication stores over the fresh schema. */
public class ManagedSchemaPublicationStoreTest {
    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:publication32-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        return source;
    }

    @Test
    void asyncVerificationSealsAndAdmissionReuseTheSameImmutableResourceRow() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        var fixture = PublicationJournalFixture.create(source, true);
        fixture.reserve();
        var bucket = new Bucket();
        fixture.sessions.setPublicationObjects(bucket);
        var data = new ToolPublicationDataStore(fixture.jdbc, fixture.manager, fixture.store, fixture.sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        JsonNode key = fixture.binding.path("sessionKey");
        byte[] output = "hello".getBytes(StandardCharsets.UTF_8);
        String digest = ToolPublicationContract.sha256(output);
        assertThat(data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "upload", "stdout", 0,
                output, digest, true).path("state").asText()).isEqualTo("PENDING");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "upload").path("state").asText())
                .isEqualTo("SUCCEEDED");
        assertThatThrownBy(() -> data.prefix(key, "pub-1", PUBLICATION_TOKEN, "upload", "stdout"))
                .hasMessageContaining("conflict");
        data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-out", "stdout", 1, output.length, digest);
        data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-err", "stderr", 0, 0,
                ToolPublicationContract.sha256(new byte[0]));
        assertThat(data.prefix(key, "pub-1", PUBLICATION_TOKEN, "prefix", "stdout").path("sealed").asBoolean()).isTrue();
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "late", "stdout", 1,
                output, digest)).hasMessageContaining("sealed");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE kind = X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'",
                Long.class)).isEqualTo(2);
        byte[] manifest = fixture.jdbc.queryForObject("SELECT r.inline_bytes FROM ma_output_capture c JOIN ma_resource r"
                + " ON r.resource_key = c.seal_manifest_resource_key WHERE c.publication_id = ?", byte[].class, "pub-1");
        assertThat(ManagedToolResultStore.parse(new String(manifest, StandardCharsets.UTF_8)).path("seals")).hasSize(2);
        ObjectMapper json = new ObjectMapper();
        var terminal = json.createObjectNode().put("executionStatus", "error");
        terminal.putArray("responseParts").add("capture unavailable");
        terminal.set("capture", json.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest"));
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish", terminal.toString().getBytes(StandardCharsets.UTF_8));
        var outcome = json.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
        outcome.set("envelope", terminal);
        var history = json.createObjectNode().put("messageId", "11111111-1111-4111-8111-111111111111")
                .put("timestamp", "2026-10-13T00:00:00Z").put("model", "fixture");
        history.putArray("parts").addObject().put("text", "capture unavailable");
        outcome.set("history", history);
        JsonNode admission = data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);
        String resourceId = admission.path("resourceId").asText();
        String resourceKey = ManagedSchemaKeys.key(ManagedSessionStore.sessionScopeKey("tenant-1", "session-1"), resourceId);
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?",
                String.class, resourceKey)).isEqualTo("PUBLISHED");
        var payload = json.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", fixture.sequence + 1).putNull("resultRef");
        payload.set("toolOutcomeRef", admission);
        payload.putArray("resources");
        String records = fixture.event(fixture.sequence + 1, "tool.receipt", payload) + PublicationJournalFixture.COMMIT_MARKER;
        String recordDigest = PublicationJournalFixture.digest(records);
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                fixture.revision, fixture.sequence, "transaction-receipt", "recordToolResult", "execution-1",
                admission.path("digest").asText(), fixture.sequence + 1, fixture.sequence + 1, 1,
                recordDigest, fixture.commitDigest, recordDigest, 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)), recordDigest,
                List.of(new ManagedSessionStoreModels.CommitResource(resourceId, "managed-tool-outcome", 1,
                        admission.path("byteLength").asLong(), admission.path("digest").asText(), null)));
        var admissions = new ToolPublicationAdmissionStore(fixture.jdbc, fixture.manager, fixture.sessions, data);
        JsonNode accepted = admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit);
        assertThat(admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit)).isEqualTo(accepted);
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE resource_id = ?",
                Long.class, resourceId)).isEqualTo(1);
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?",
                String.class, resourceKey)).isEqualTo("REFERENCED");
        assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE resource_key = ?",
                String.class, resourceKey)).isEqualTo("VERIFIED");
    }

    private static final class Bucket implements ToolPublicationObjectStore {
        private final Map<String, byte[]> objects = new HashMap<>();
        @Override public void putIfAbsent(String key, byte[] bytes) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            byte[] old = objects.putIfAbsent(key, bytes.clone());
            if (old != null) {
                assertThat(old).isEqualTo(bytes);
            }
        }
        @Override public InputStream open(String key) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            return new ByteArrayInputStream(objects.get(key));
        }
        @Override public void validateConfiguration() { }
    }
}
