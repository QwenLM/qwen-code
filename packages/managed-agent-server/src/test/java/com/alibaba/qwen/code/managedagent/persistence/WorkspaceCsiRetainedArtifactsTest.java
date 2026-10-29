package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceCsiRetainedArtifactsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ManagedSchemaSessionStoreTest.MutableClock clock = new ManagedSchemaSessionStoreTest.MutableClock();
    private final WorkspaceCsiApplicationInventoryTest fixture = new WorkspaceCsiApplicationInventoryTest();
    private WorkspaceCsiApplicationInventory.Snapshot expected;
    private JdbcTemplate jdbc;
    private TransactionTemplate tx;
    private ManagedAgentStore store;
    private DataSource source;
    private String session;

    protected DataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:retained-artifacts-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
    }

    @BeforeEach
    void setup() throws Exception {
        source = dataSource();
        fixture.initialize(source);
        jdbc = fixture.jdbc;
        expected = fixture.historicalKeys();
        tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        clock.advance(Duration.between(clock.instant(), Instant.now()));
        store = new ManagedAgentStore(jdbc, JSON, clock, ignored -> {}, new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        accepted();
        jdbc.update("INSERT INTO ma_workspace (tenant_id,workspace_id,workspace_generation,storage_id,display_name,config_ref,policy_ref,state)"
                + " VALUES ('foreign','workspace',1,'ordinary-storage','Fixture',?,?,'ACTIVE')", WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,workspace_id,actor_id,role) VALUES ('foreign','workspace',?,'OPERATOR')",
                ManagedWorkspaceRegistry.actorKey("foreign", "actor"));
        session = tx.execute(status -> store.insertWorkspaceSessionCommand("foreign", "actor", "create", "a".repeat(64), "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("workspace", ".")).sessionId());
    }

    @AfterEach
    void closeH2() {
        if (jdbc != null && source instanceof DriverManagerDataSource driver && driver.getUrl() != null
                && driver.getUrl().startsWith("jdbc:h2:")) {
            jdbc.execute("SHUTDOWN");
        }
    }

    @Test
    void acceptsEmptySnapshotAndActualAgentResourcesIncludingEmptyAndLiteralText() throws Exception {
        materialize();
        assertThat(store.findSnapshot("foreign", session).orElseThrow().items()).isEmpty();
        var resources = new ManagedSessionStore(jdbc);
        String literal = "Unicode 指令 {\"sessionId\":\"" + expected.table("ma_session").rows().getFirst().text("session_id") + "\"}";
        for (String text : List.of("", literal)) {
            tx.execute(status -> resources.publishAgentInstructions("foreign", "workspace", session, text));
        }
        for (var skills : List.of(List.<Map<String, Object>>of(), AgentDefinitionExtensions.skills(
                List.of(Map.of("name", "review", "description", "合法技能", "body", literal, "base_directory", ".")), true))) {
            tx.execute(status -> resources.publishAgentSkills("foreign", "workspace", session, skills));
        }
        var before = artifactBytes();
        accepted();
        assertThat(artifactBytes()).containsExactlyElementsOf(before);
    }

    @Test
    void acceptsRealMultiplePagesAndAnOversizedSingleItem() throws Exception {
        for (int index = 0; index < 101; index++) {
            append("item.tool_call.updated", Map.of("callId", "call-" + index, "name", "read_file", "status", "completed"));
        }
        append("item.tool_call.updated", Map.of("callId", "large", "name", "read_file", "status", "completed", "arguments", "x".repeat(150_000)));
        materialize();
        assertThat(store.findSnapshot("foreign", session).orElseThrow().items()).hasSize(102);
        assertThat(jdbc.queryForObject("SELECT MAX(byte_length) FROM ma_resource WHERE kind=?", Long.class, "managed-snapshot-page")).isGreaterThan(128 * 1024);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE kind=?", Integer.class, "managed-snapshot-page")).isGreaterThan(1);
        accepted();
    }

    @Test
    void acceptsEqualFirstSequencesInTheProducersBinaryItemOrder() throws Exception {
        for (String id : List.of("Z", "a", "é", "中")) {
            append("item.tool_call.updated", Map.of("callId", id, "name", "read_file", "status", "completed"));
        }
        materialize();
        jdbc.update("UPDATE ma_message SET first_sequence=1 WHERE tenant_id=?", "foreign");
        append("session.metadata.updated", Map.of("title", "ties"));
        materialize();
        var items = store.findSnapshot("foreign", session).orElseThrow().items();
        assertThat(items).extracting(StoreModels.ItemRecord::firstSequence).containsOnly(1L);
        accepted();
    }

    @Test
    void acceptsOlderBodyRevisionAndSeveralSnapshotsAfterTheCurrentBodyChanges() throws Exception {
        largeBody(70_000);
        String oldBody = jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id=?", String.class, "foreign");
        append("turn.completed", Map.of());
        materialize();
        assertThat(jdbc.queryForObject("SELECT revision FROM ma_message WHERE tenant_id=?", Long.class, "foreign")).isGreaterThan(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key=?", Integer.class, oldBody)).isEqualTo(3);
        accepted();
        append("item.output_text.delta", Map.of("itemId", "large", "text", "later"));
        materialize();
        assertThat(jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id=?", String.class, "foreign")).isNotEqualTo(oldBody);
        assertThat(jdbc.queryForList("SELECT owner_kind FROM ma_resource_ref WHERE resource_key=?", String.class, oldBody)).containsOnly("SNAPSHOT");
        jdbc.update("UPDATE ma_snapshot SET retain_until=1 WHERE tenant_id=?", "foreign");
        var before = artifactBytes();
        accepted();
        assertThat(artifactBytes()).containsExactlyElementsOf(before);
    }

    @Test
    void acceptsPublicBodiesLargerThanTheUnrelatedNativeEightMiBLimit() throws Exception {
        largeBody(8 * 1024 * 1024 + 1);
        assertThat(jdbc.queryForObject("SELECT byte_length FROM ma_resource WHERE kind=?", Long.class, "managed-message-parts")).isGreaterThan(8 * 1024 * 1024);
        accepted();
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-root", "missing-page", "missing-ref", "extra-ref", "wrong-ref-revision",
            "wrong-ref-scope", "wrong-root-count", "wrong-root-version", "manifest-sequence", "manifest-type", "manifest-secret", "manifest-extra",
            "page-ordinal", "page-last", "page-owner", "page-extra", "page-order", "page-original-reference", "body-inline-content", "page-utf8"})
    void refusesIncompleteOrSubstitutedSnapshotGraphs(String fault) throws Exception {
        largeBody(70_000);
        append("item.tool_call.updated", Map.of("callId", "second", "name", "read_file", "status", "completed"));
        materialize();
        accepted();
        switch (fault) {
            case "missing-root" -> {
                jdbc.update("UPDATE ma_event_stream SET current_snapshot_id=NULL WHERE tenant_id=?", "foreign");
                jdbc.update("DELETE FROM ma_snapshot WHERE tenant_id=?", "foreign");
            }
            case "missing-page" -> removeResources("managed-snapshot-page");
            case "missing-ref" -> jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind='SNAPSHOT'");
            case "extra-ref" -> jdbc.update("UPDATE ma_resource_ref SET owner_kind='ARTIFACT' WHERE owner_kind='MESSAGE'");
            case "wrong-ref-revision" -> jdbc.update("UPDATE ma_resource_ref SET owner_revision=owner_revision+10 WHERE owner_kind='SNAPSHOT'");
            case "wrong-ref-scope" -> jdbc.update("UPDATE ma_resource_ref SET workspace_id='borrowed' WHERE owner_kind='SNAPSHOT'");
            case "wrong-root-count" -> jdbc.update("UPDATE ma_snapshot SET item_count=item_count+1 WHERE tenant_id=?", "foreign");
            case "wrong-root-version" -> jdbc.update("UPDATE ma_snapshot SET snapshot_version=snapshot_version+10 WHERE tenant_id=?", "foreign");
            case "manifest-sequence" -> edit("managed-snapshot-manifest", value -> ((ObjectNode) value).put("sequence", 9999));
            case "manifest-type" -> edit("managed-snapshot-manifest", value -> ((ObjectNode) value).put("version", "1"));
            case "manifest-secret" -> edit("managed-snapshot-manifest", value -> ((ObjectNode) value).put("cursorSecret", "AA=="));
            case "manifest-extra" -> edit("managed-snapshot-manifest", value -> ((ObjectNode) value).put("extra", true));
            case "page-ordinal" -> jdbc.update("UPDATE ma_resource SET snapshot_page_ordinal=9 WHERE kind=?", "managed-snapshot-page");
            case "page-last" -> jdbc.update("UPDATE ma_resource SET snapshot_page_last_sequence=9999 WHERE kind=?", "managed-snapshot-page");
            case "page-owner" -> edit("managed-snapshot-page", value -> ((ObjectNode) value.get(0).get("item")).put("tenantId", "borrowed"));
            case "page-extra" -> edit("managed-snapshot-page", value -> ((ObjectNode) value.get(0)).put("extra", true));
            case "page-order" -> edit("managed-snapshot-page", value -> ((ObjectNode) value.get(0).get("item")).put("firstSequence", 9999));
            case "page-original-reference" -> edit("managed-snapshot-page", value -> ((ObjectNode) value.get(0).get("item").get("attributes"))
                    .put("bindingId", expected.table("ma_runtime_binding").rows().getFirst().text("binding_id")));
            case "body-inline-content" -> edit("managed-snapshot-page", value -> ((ObjectNode) value.get(0).get("item")).set("content", JSON.valueToTree(
                    List.of(new StoreModels.ItemPartRecord("borrowed", "text", "hidden", 1, 1, 0, 0, 1)))));
            case "page-utf8" -> replace("managed-snapshot-page", new byte[] {(byte) 0xc3, 0x28});
            default -> throw new AssertionError(fault);
        }
        assertThat(fixture.readReferences(expected).blockers()).as(fault).isNotEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"instructions-utf8", "skills-shape", "skills-path", "skills-field", "publish-command", "agent-scope"})
    void refusesMalformedAgentArtifactsWithOtherwiseCorrectDigests(String fault) throws Exception {
        var resources = new ManagedSessionStore(jdbc);
        tx.execute(status -> resources.publishAgentInstructions("foreign", "workspace", session, "valid"));
        tx.execute(status -> resources.publishAgentSkills("foreign", "workspace", session, List.of(Map.of("name", "review", "description", "description", "body", "body"))));
        accepted();
        switch (fault) {
            case "instructions-utf8" -> replaceAgent("managed-agent-instructions", new byte[] {(byte) 0xc3, 0x28});
            case "skills-shape" -> replaceAgent("managed-agent-skills", "{}".getBytes(StandardCharsets.UTF_8));
            case "skills-path" -> replaceAgent("managed-agent-skills", JSON.writeValueAsBytes(List.of(Map.of("name", "review", "description", "description", "body", "body", "base_directory", "../borrowed"))));
            case "skills-field" -> replaceAgent("managed-agent-skills", JSON.writeValueAsBytes(List.of(Map.of("name", "review", "description", "description", "body", "body", "extra", true))));
            case "publish-command" -> jdbc.update("UPDATE ma_resource SET publish_command_id=? WHERE kind=?", "borrowed", "managed-agent-instructions");
            case "agent-scope" -> jdbc.update("UPDATE ma_resource SET session_scope_key=? WHERE kind=?", "a".repeat(64), "managed-agent-skills");
            default -> throw new AssertionError(fault);
        }
        assertThat(fixture.readReferences(expected).blockers()).as(fault).isNotEmpty();
    }

    private void accepted() throws Exception {
        var found = fixture.readReferences(expected);
        assertThat(found.blockers()).isEmpty();
        assertThat(WorkspaceCsiApplicationInventory.expectedImage(found.tables()).bytes()).isEqualTo(expected.bytes());
    }

    private void append(String type, Map<String, Object> data) {
        tx.executeWithoutResult(status -> store.appendPublicEventIfAbsent("foreign", session, "turn", type, data, false, UUID.randomUUID().toString()));
    }

    private void materialize() {
        clock.advance(Duration.ofSeconds(6));
        tx.execute(status -> store.materializeNextBatch("foreign", session, 200));
    }

    private void largeBody(int length) {
        append("item.output_text.delta", Map.of("itemId", "large", "text", "a".repeat(length)));
        materialize();
        assertThat(store.findSnapshot("foreign", session).orElseThrow().items().getFirst().content().getFirst().text()).hasSize(length);
    }

    private void edit(String kind, Consumer<JsonNode> change) throws Exception {
        var rows = jdbc.queryForList("SELECT inline_bytes FROM ma_resource WHERE kind=?", byte[].class, kind);
        for (byte[] bytes : rows) {
            JsonNode value = JSON.readTree(bytes);
            change.accept(value);
            byte[] updated = JSON.writeValueAsBytes(value);
            String digest = WorkspaceEvidenceResources.digest(updated);
            jdbc.update("UPDATE ma_resource SET inline_bytes=?,byte_length=?,sha256=? WHERE kind=? AND sha256=?", updated, updated.length, digest, kind, WorkspaceEvidenceResources.digest(bytes));
            if (kind.equals("managed-snapshot-manifest")) {
                jdbc.update("UPDATE ma_snapshot SET manifest_sha256=? WHERE manifest_sha256=?", digest, WorkspaceEvidenceResources.digest(bytes));
            }
        }
    }

    private void replace(String kind, byte[] bytes) {
        jdbc.update("UPDATE ma_resource SET inline_bytes=?,byte_length=?,sha256=? WHERE kind=?", bytes, bytes.length, WorkspaceEvidenceResources.digest(bytes), kind);
    }

    private void removeResources(String kind) {
        for (String key : jdbc.queryForList("SELECT resource_key FROM ma_resource WHERE kind=?", String.class, kind)) {
            jdbc.update("DELETE FROM ma_resource_ref WHERE resource_key=?", key);
            jdbc.update("DELETE FROM ma_resource WHERE resource_key=?", key);
        }
    }

    private void replaceAgent(String kind, byte[] bytes) {
        String digest = WorkspaceEvidenceResources.digest(bytes);
        String id = (kind.equals("managed-agent-instructions") ? "agent-instructions-" : "agent-skills-") + digest;
        String scope = ManagedSessionStore.sessionScopeKey("foreign", session);
        jdbc.update("UPDATE ma_resource SET resource_key=?,resource_id=?,publish_command_id=?,inline_bytes=?,byte_length=?,sha256=? WHERE kind=?",
                ManagedSessionStore.resourceKey(scope, id), id, id, bytes, bytes.length, digest, kind);
    }

    private List<String> artifactBytes() {
        return jdbc.query("SELECT inline_bytes FROM ma_resource ORDER BY resource_key", (row, index) -> java.util.Base64.getEncoder().encodeToString(row.getBytes(1)));
    }
}
