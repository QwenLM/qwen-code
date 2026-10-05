package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/** Historical decoder fixtures are not proof of a newly acknowledged worker or trusted Pod. */
class WorkspaceCsiWorkerAckStoreTest {
    static final ObjectMapper JSON = new ObjectMapper();
    static final long OBSERVED = 1_791_012_345_678_901L;
    private Fixture fixture;

    @BeforeEach
    void setUp() throws Exception {
        fixture = fixture("jdbc:h2:mem:ack-document-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
    }

    @Test
    void inspectDecodesHistoricalDocumentWithoutWorkerOrObjectIoOrInsert() {
        var first = fixture.store().inspect(fixture.selector());
        var second = fixture.store().inspect(fixture.selector());
        assertThat(first.document()).isEqualTo(fixture.document());
        assertThat(second).isEqualTo(first);
        assertThat(first.digest()).isEqualTo(hash(fixture.document().toString()));
        assertThat(first.recordedAtEpochMicros()).isEqualTo(OBSERVED);
        assertThat(fixture.rows()).isEqualTo(1);
        verifyNoInteractions(fixture.transport(), fixture.objects());
    }

    @Test
    void absentHistoricalAckReturnsNullWithoutRpcOrInsert() {
        fixture.jdbc().update("DELETE FROM managed_workspace_csi_worker_ack");
        assertThat(fixture.store().inspect(fixture.selector())).isNull();
        assertThat(fixture.rows()).isZero();
        verifyNoInteractions(fixture.transport(), fixture.objects());
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "/original", "/original/sessionKey", "/original/terminalRef", "/original/outcomeRef", "/confirmation",
            "/confirmation/context", "/confirmation/storage", "/confirmation/pod", "/confirmation/reference",
            "/confirmation/acknowledgement", "/confirmation/acknowledgement/manifest", "/confirmation/captureIdentity"})
    void everyClosedObjectRejectsMissingAndUnknownFields(String pointer) {
        for (boolean missing : List.of(true, false)) {
            var document = fixture.document().deepCopy();
            ObjectNode object = (ObjectNode) document.at(pointer);
            String field = object.fieldNames().next();
            JsonNode previous = object.remove(field);
            if (!missing) {
                object.set("unknownField", previous);
            }
            fixture.save(document.toString());
            refused();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"4294967297", "9007199254740992", "18446744073709551617", "1.0", "1e0", "0", "-1"})
    void schemaCannotWrapOrAcceptNoncanonicalNumberTokens(String number) {
        fixture.save(fixture.document().toString().replaceFirst("\"schemaVersion\":1", "\"schemaVersion\":" + number));
        refused();
    }

    @ParameterizedTest
    @ValueSource(strings = {"/original/terminalRef", "/original/outcomeRef"})
    void referenceSchemaCannotWrapToOne(String pointer) {
        var document = fixture.document().deepCopy();
        ((ObjectNode) document.at(pointer)).put("schemaVersion", 4_294_967_297L);
        fixture.save(document.toString());
        refused();
    }

    @ParameterizedTest
    @ValueSource(strings = {"bindingGeneration", "authorizedDispatchGeneration", "authorizedBindingVersion", "receiptJournalRevision", "receiptSequence"})
    void stringRevisionsRejectOverflowAndNoncanonicalForms(String field) {
        for (String value : List.of("9223372036854775808", "0", "01", "1.0", "-1")) {
            var document = fixture.document().deepCopy();
            ((ObjectNode) document.path("original")).put(field, value);
            fixture.save(document.toString());
            refused();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"bindingGeneration", "authorizedDispatchGeneration", "authorizedBindingVersion", "receiptJournalRevision", "receiptSequence",
            "bindingId", "finishOperationId", "terminalRef/resourceId", "outcomeRef/resourceId"})
    void numericOneCannotBeCoercedIntoARequiredString(String path) {
        var document = fixture.document().deepCopy();
        int slash = path.indexOf('/');
        ObjectNode parent = (ObjectNode) (slash < 0 ? document.path("original") : document.path("original").path(path.substring(0, slash)));
        String field = slash < 0 ? path : path.substring(slash + 1);
        parent.put(field, "1");
        if ("bindingGeneration".equals(path)) {
            ((ObjectNode) document.path("confirmation").path("captureIdentity")).put("bindingGeneration", "1");
        } else if ("receiptSequence".equals(path)) {
            ((ObjectNode) document.path("confirmation").path("acknowledgement")).put("historyRevision", 1);
        }
        if ("bindingId".equals(path) || "bindingGeneration".equals(path)) {
            ObjectNode publication = fixture.publication();
            publication.put("bindingId".equals(path) ? "runtimeBindingId" : "bindingGeneration", "1");
            fixture.savePublication(publication);
            ((ObjectNode) document.path("original")).put("publicationBindingDigest", ToolPublicationContract.bindingDigest(publication));
        }
        fixture.save(document.toString());
        assertThat(fixture.store().inspect(fixture.selector()).document()).isEqualTo(document);
        parent.put(field, 1);
        fixture.save(document.toString());
        assertThatThrownBy(() -> fixture.store().inspect(fixture.selector()))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("CSI ACK text field is invalid");
        assertThat(fixture.rows()).isEqualTo(1);
        verifyNoInteractions(fixture.transport(), fixture.objects());
    }

    @ParameterizedTest
    @ValueSource(strings = {"retirement", "tenant", "workspace", "session", "execution", "generation", "sequence", "publication"})
    void historicalIdentityCannotEscapeSelectedRow(String field) {
        var document = fixture.document().deepCopy();
        ObjectNode confirmation = (ObjectNode) document.path("confirmation");
        switch (field) {
            case "retirement" -> confirmation.put("retirementId", UUID.randomUUID().toString());
            case "tenant" -> ((ObjectNode) confirmation.path("context")).put("tenantId", "foreign");
            case "workspace" -> ((ObjectNode) confirmation.path("context")).put("workspaceId", "foreign");
            case "session" -> ((ObjectNode) confirmation.path("captureIdentity")).put("sessionId", "foreign");
            case "execution" -> ((ObjectNode) confirmation.path("captureIdentity")).put("executionCallId", "foreign");
            case "generation" -> ((ObjectNode) document.path("original")).put("bindingGeneration", "99");
            case "sequence" -> ((ObjectNode) document.path("original")).put("receiptSequence", "99");
            default -> ((ObjectNode) document.path("original")).put("publicationId", "foreign");
        }
        fixture.save(document.toString());
        refused();
    }

    @ParameterizedTest
    @ValueSource(strings = {"publicationBindingDigest", "bindingId", "bindingGeneration", "sessionKey", "reference", "turnId", "captureId"})
    void historicalDocumentMustMatchTheSavedPublicationBinding(String field) {
        var document = fixture.document().deepCopy();
        ObjectNode original = (ObjectNode) document.path("original");
        ObjectNode confirmation = (ObjectNode) document.path("confirmation");
        switch (field) {
            case "publicationBindingDigest" -> original.put(field, "f".repeat(64));
            case "bindingId" -> original.put(field, "foreign-binding");
            case "bindingGeneration" -> {
                original.put(field, "99");
                ((ObjectNode) confirmation.path("captureIdentity")).put(field, "99");
            }
            case "sessionKey" -> ((ObjectNode) original.path("sessionKey")).put("workspaceId", "foreign-workspace");
            case "reference" -> ((ObjectNode) confirmation.path("reference")).put("promptId", "foreign-prompt");
            default -> ((ObjectNode) confirmation.path("captureIdentity")).put(field, "foreign-capture");
        }
        fixture.save(document.toString());
        assertThatThrownBy(() -> fixture.store().inspect(fixture.selector())).isInstanceOf(IllegalArgumentException.class)
                .hasMessage("sessionKey".equals(field) ? "Historical CSI ACK scope conflicts" : "Historical CSI ACK publication conflicts");
        assertThat(fixture.rows()).isEqualTo(1);
        verifyNoInteractions(fixture.transport(), fixture.objects());
    }

    @ParameterizedTest
    @ValueSource(strings = {"digest", "hash-alias", "timestamp-zero", "timestamp-negative", "publication-digest", "publication-row-alias"})
    void persistedColumnPinsAreVerifiedIndependently(String damage) {
        switch (damage) {
            case "digest" -> fixture.jdbc().update("UPDATE managed_workspace_csi_worker_ack SET evidence_digest = ?", "f".repeat(64));
            case "hash-alias" -> fixture.jdbc().update("UPDATE managed_workspace_csi_worker_ack SET execution_call_id = 'foreign'");
            case "timestamp-zero" -> fixture.jdbc().update("UPDATE managed_workspace_csi_worker_ack SET recorded_at_epoch_micros = 0");
            case "timestamp-negative" -> fixture.jdbc().update("UPDATE managed_workspace_csi_worker_ack SET recorded_at_epoch_micros = -1");
            case "publication-digest" -> fixture.jdbc().update("UPDATE qwen_tool_publication SET binding_digest = ?", "f".repeat(64));
            default -> fixture.jdbc().update("UPDATE qwen_tool_publication SET tenant_id = 'foreign'");
        }
        refused();
    }

    @Test
    void invalidJsonAndWireBoundsFailEvenWithAnUpdatedDigest() {
        String valid = fixture.document().toString();
        for (String invalid : List.of(valid + "{}", valid.replaceFirst("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1"),
                "[" + valid + "]", valid + " ".repeat(32 * 1024))) {
            fixture.save(invalid);
            refused();
        }
    }

    @Test
    void selectorsRejectInvalidUtf16NonNfcControlAndUtf8ByteOverflow() {
        var original = fixture.selector();
        for (String value : List.of("", "\ud800", "e\u0301", "bad\nvalue", "界".repeat(171))) {
            assertThatThrownBy(() -> new WorkspaceCsiWorkerAckStore.Selector(original.retirementId(), "tenant", value, "session", "pub"))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new WorkspaceCsiWorkerAckStore.Selector("1-1-1-1-1", "tenant", "workspace", "session", "pub"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorkspaceCsiWorkerAckStore.Selector(original.retirementId(), "界".repeat(43), "workspace", "session", "pub"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorkspaceCsiWorkerAckStore.Selector(original.retirementId(), "tenant", "workspace", "session", "界".repeat(43)))
                .isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(fixture.transport(), fixture.objects());
    }

    private void refused() {
        assertThatThrownBy(() -> fixture.store().inspect(fixture.selector())).isInstanceOf(RuntimeException.class);
        assertThat(fixture.rows()).isEqualTo(1);
        verifyNoInteractions(fixture.transport(), fixture.objects());
    }

    static Fixture fixture(String url) throws Exception {
        var source = new JdbcDataSource();
        source.setURL(url);
        source.setUser("sa");
        source.setPassword("fixture-password");
        Flyway.configure().dataSource(source).load().migrate();
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("fixture", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var managed = new ManagedSessionStore(jdbc);
        var grants = new ToolPublicationStore(jdbc, manager, managed, executions, bindings,
                new ToolPublicationStore.Capacity(1024, 16 * 1024 * 1024, 16 * 1024 * 1024, 10));
        var objects = mock(ToolPublicationObjectStore.class);
        var data = new ToolPublicationDataStore(jdbc, manager, grants, managed, objects, Duration.ofSeconds(30), Duration.ofSeconds(10),
                new ToolPublicationDataStore.VerificationBudget(1024 * 1024, Duration.ofMinutes(25)));
        var admission = new ToolPublicationAdmissionStore(jdbc, manager, managed, data);
        var transport = mock(RuntimeTransport.class);
        var store = new WorkspaceCsiWorkerAckStore(source, manager, bindings, sessions, executions, admission, transport, Duration.ofSeconds(1));
        JsonNode wire = JSON.readTree(root().resolve("packages/cli/src/serve/contracts/managed-csi-worker-ack-v1.fixtures.json").toFile());
        ObjectNode publication = (ObjectNode) JSON.readTree(root().resolve("packages/core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json")
                .toFile()).path("cases").get(0).path("value").deepCopy();
        ObjectNode response = (ObjectNode) wire.path("response").deepCopy();
        String invocation = "sha256:" + response.path("reference").path("argsDigest").asText();
        ((ObjectNode) response.path("reference")).put("argsDigest", invocation);
        ((ObjectNode) response.path("captureIdentity")).put("invocationDigest", invocation);
        JsonNode capture = response.path("captureIdentity");
        var key = JSON.createObjectNode().put("tenantId", response.path("context").path("tenantId").asText())
                .put("workspaceId", response.path("context").path("workspaceId").asText()).put("sessionId", capture.path("sessionId").asText());
        publication.set("sessionKey", key);
        publication.set("reference", response.path("reference"));
        publication.put("executionCallId", capture.path("executionCallId").asText()).put("bindingGeneration", capture.path("bindingGeneration").asText())
                .put("turnId", capture.path("turnId").asText()).put("captureId", capture.path("captureId").asText());
        var selector = new WorkspaceCsiWorkerAckStore.Selector(response.path("retirementId").asText(), key.path("tenantId").asText(),
                key.path("workspaceId").asText(), key.path("sessionId").asText(), publication.path("publicationId").asText());
        ObjectNode original = JSON.createObjectNode().put("retirementIdentityDigest", "a".repeat(64))
                .put("bindingId", publication.path("runtimeBindingId").asText()).put("bindingGeneration", capture.path("bindingGeneration").asText())
                .put("publicationId", selector.publicationId()).put("publicationBindingDigest", ToolPublicationContract.bindingDigest(publication))
                .put("authorizedDispatchGeneration", "1").put("authorizedBindingVersion", "2").put("finishOperationId", "finish-original")
                .put("receiptJournalRevision", "3").put("receiptSequence", response.path("acknowledgement").path("historyRevision").asText());
        original.set("sessionKey", key);
        original.set("terminalRef", ref("terminal", "managed-tool-terminal"));
        original.set("outcomeRef", ref("outcome", "managed-tool-outcome"));
        var document = JSON.createObjectNode().put("schemaVersion", 1);
        document.set("original", original);
        document.set("confirmation", response);
        // Only historical read fixtures: no binding, execution, retirement or successful acknowledge is manufactured.
        jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id, session_id, publication_id,"
                        + " execution_key, capture_id, binding_json, binding_digest, token_hash, state, capture_bytes, producer_bytes, admission_bytes)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADMITTED', 1, 1, 1)",
                ToolPublicationDataStore.scope(key), hash(selector.tenantId()), selector.tenantId(), selector.workspaceId(), selector.sessionId(),
                selector.publicationId(), hash(capture.path("executionCallId").asText()), publication.path("captureId").asText(),
                publication.toString(), ToolPublicationContract.bindingDigest(publication), "a".repeat(64));
        jdbc.update("INSERT INTO managed_workspace_csi_worker_ack VALUES (?, ?, ?, ?, ?, ?)", selector.retirementId(),
                hash(capture.path("executionCallId").asText()), capture.path("executionCallId").asText(), document.toString(), hash(document.toString()), OBSERVED);
        return new Fixture(jdbc, store, selector, document, transport, objects);
    }

    private static JsonNode ref(String id, String kind) {
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1).put("byteLength", 2).put("digest", "a".repeat(64));
    }

    private static String hash(String value) {
        return ToolPublicationContract.sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Path root() {
        for (Path path = Path.of("").toAbsolutePath(); path != null; path = path.getParent()) {
            if (Files.exists(path.resolve("packages/cli/src/serve/contracts/managed-csi-worker-ack-v1.fixtures.json"))) {
                return path;
            }
        }
        throw new IllegalStateException("Shared ACK fixtures are missing");
    }

    record Fixture(JdbcTemplate jdbc, WorkspaceCsiWorkerAckStore store, WorkspaceCsiWorkerAckStore.Selector selector,
            ObjectNode document, RuntimeTransport transport, ToolPublicationObjectStore objects) {
        void save(String encoded) {
            jdbc.update("UPDATE managed_workspace_csi_worker_ack SET evidence_json = ?, evidence_digest = ?", encoded, hash(encoded));
        }

        ObjectNode publication() {
            return (ObjectNode) ToolPublicationContract.parseBytes("binding", jdbc.queryForObject("SELECT binding_json FROM qwen_tool_publication", String.class)
                    .getBytes(StandardCharsets.UTF_8));
        }

        void savePublication(ObjectNode publication) {
            jdbc.update("UPDATE qwen_tool_publication SET binding_json = ?, binding_digest = ?",
                    publication.toString(), ToolPublicationContract.bindingDigest(publication));
        }

        long rows() {
            return jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_worker_ack", Long.class);
        }
    }
}
