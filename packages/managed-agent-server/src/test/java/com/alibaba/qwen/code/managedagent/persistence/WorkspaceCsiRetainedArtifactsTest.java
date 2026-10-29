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
    void acceptsEmptyMessagesAndActualAgentResourcesIncludingEmptyAndLiteralText() throws Exception {
        materialize();
        assertThat(tx.execute(status -> store.findMessagePage("foreign", session, null, 100, true)).items()).isEmpty();
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
    void acceptsMultipleMessagePagesAndAnOversizedSingleItem() throws Exception {
        for (int index = 0; index < 101; index++) {
            append("item.tool_call.updated", Map.of("callId", "call-" + index, "name", "read_file", "status", "completed"));
        }
        append("item.tool_call.updated", Map.of("callId", "large", "name", "read_file", "status", "completed", "arguments", "x".repeat(150_000)));
        materialize();
        var first = tx.execute(status -> store.findMessagePage("foreign", session, null, 100, true));
        var older = tx.execute(status -> store.findMessagePage("foreign", session, first.nextCursor(), 100, true));
        assertThat(first.items()).hasSize(100);
        assertThat(older.items()).hasSize(2);
        assertThat(older.hasMore()).isFalse();
        assertThat(java.util.stream.Stream.concat(first.items().stream(), older.items().stream())
                .map(StoreModels.ItemRecord::itemId).distinct().count()).isEqualTo(102);
        assertThat(jdbc.queryForObject("SELECT MAX(OCTET_LENGTH(attributes_json)) FROM ma_message WHERE tenant_id=?",
                Long.class, "foreign")).isGreaterThan(128 * 1024);
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
        var items = tx.execute(status -> store.findMessagePage("foreign", session, null, 100, true)).items();
        assertThat(items).extracting(StoreModels.ItemRecord::firstSequence).containsOnly(1L);
        accepted();
    }

    @Test
    void acceptsOlderBodyRevisionAndReleasedBodiesWhileCollectionIsDisabled() throws Exception {
        largeBody(70_000);
        String oldBody = jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id=?", String.class, "foreign");
        append("turn.completed", Map.of());
        materialize();
        assertThat(jdbc.queryForObject("SELECT revision FROM ma_message WHERE tenant_id=?", Long.class, "foreign")).isGreaterThan(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key=?", Integer.class, oldBody)).isEqualTo(1);
        accepted();
        append("item.output_text.delta", Map.of("itemId", "large", "text", "later"));
        materialize();
        assertThat(jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id=?", String.class, "foreign")).isNotEqualTo(oldBody);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key=?", Integer.class, oldBody)).isZero();
        assertThat(jdbc.queryForMap("SELECT state, retention_until FROM ma_resource WHERE resource_key=?", oldBody))
                .containsEntry("state", "REFERENCED").doesNotContainValue(null);
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
    @ValueSource(strings = {"missing-ref", "extra-ref", "wrong-ref-revision", "wrong-ref-scope", "body-owner",
            "body-extra", "body-order", "body-original-reference", "body-inline-content", "body-utf8"})
    void refusesIncompleteOrSubstitutedMessageBodies(String fault) throws Exception {
        largeBody(70_000);
        append("item.tool_call.updated", Map.of("callId", "second", "name", "read_file", "status", "completed"));
        materialize();
        accepted();
        switch (fault) {
            case "missing-ref" -> jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind='MESSAGE'");
            case "extra-ref" -> jdbc.update("UPDATE ma_resource_ref SET owner_kind='ARTIFACT' WHERE owner_kind='MESSAGE'");
            case "wrong-ref-revision" -> jdbc.update("UPDATE ma_resource_ref SET owner_revision=owner_revision+10 WHERE owner_kind='MESSAGE'");
            case "wrong-ref-scope" -> jdbc.update("UPDATE ma_resource_ref SET workspace_id='borrowed' WHERE owner_kind='MESSAGE'");
            case "body-owner" -> jdbc.update("UPDATE ma_resource SET tenant_id='borrowed' WHERE kind=?", "managed-message-parts");
            case "body-extra" -> editBody(value -> ((ObjectNode) value.get(0)).put("extra", true));
            case "body-order" -> editBody(value -> ((ObjectNode) value.get(0))
                    .put("firstSequence", 9999).put("lastSequence", 9999));
            case "body-original-reference" -> jdbc.update("UPDATE ma_message SET attributes_json=? WHERE tenant_id=?",
                    JSON.writeValueAsString(Map.of("bindingId", expected.table("ma_runtime_binding").rows().getFirst().text("binding_id"))), "foreign");
            case "body-inline-content" -> jdbc.update("UPDATE ma_message SET parts_json='[{}]' WHERE body_resource_key IS NOT NULL");
            case "body-utf8" -> {
                byte[] bytes = jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE kind=?",
                        byte[].class, "managed-message-parts");
                String json = new String(bytes, StandardCharsets.UTF_8);
                String prefix = "\"text\":\"";
                int start = json.indexOf(prefix);
                assertThat(start).isGreaterThanOrEqualTo(0);
                int offset = json.substring(0, start + prefix.length()).getBytes(StandardCharsets.UTF_8).length;
                bytes[offset] = (byte) 0xc3;
                bytes[offset + 1] = 0x28;
                replaceBody(bytes);
            }
            default -> throw new AssertionError(fault);
        }
        assertThat(fixture.readReferences(expected).blockers()).as(fault).isNotEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-marker", "extra-owner", "wrong-id"})
    void refusesUnprovenOrReferencedReleasedBodies(String fault) throws Exception {
        largeBody(70_000);
        String oldBody = jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id=?", String.class, "foreign");
        append("item.output_text.delta", Map.of("itemId", "large", "text", "later"));
        materialize();
        accepted();
        switch (fault) {
            case "missing-marker" -> jdbc.update("UPDATE ma_resource SET retention_until=NULL WHERE resource_key=?", oldBody);
            case "extra-owner" -> jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create)"
                    + " SELECT session_scope_key,'ARTIFACT',?,1,resource_key,tenant_id,session_id,resource_id,0 FROM ma_resource WHERE resource_key=?",
                    "a".repeat(64), oldBody);
            case "wrong-id" -> jdbc.update("UPDATE ma_resource SET resource_id='unproven' WHERE resource_key=?", oldBody);
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
        String key = jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id=? AND session_id=?",
                String.class, "foreign", session);
        byte[] bytes = jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key=?", byte[].class, key);
        try {
            assertThat(JSON.readTree(bytes).get(0).path("text").textValue()).hasSize(length);
        } catch (java.io.IOException malformed) {
            throw new AssertionError(malformed);
        }
    }

    private void editBody(Consumer<JsonNode> change) throws Exception {
        byte[] bytes = jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE kind=?",
                byte[].class, "managed-message-parts");
        JsonNode value = JSON.readTree(bytes);
        change.accept(value);
        replaceBody(JSON.writeValueAsBytes(value));
    }

    private void replaceBody(byte[] bytes) {
        tx.executeWithoutResult(status -> {
            var original = jdbc.queryForMap("SELECT resource_key,session_scope_key,resource_id FROM ma_resource WHERE kind=?",
                    "managed-message-parts");
            String oldKey = (String) original.get("resource_key");
            String oldId = (String) original.get("resource_id");
            String digest = WorkspaceEvidenceResources.digest(bytes);
            String id = oldId.substring(0, oldId.lastIndexOf(':') + 1) + digest;
            String key = ManagedSessionStore.resourceKey((String) original.get("session_scope_key"), id);
            assertThat(jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,session_id,resource_id,kind,"
                    + "schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create,last_verified_at,retention_until)"
                    + " SELECT ?,session_scope_key,tenant_id,workspace_id,session_id,?,kind,schema_version,?,?,storage_kind,?,state,"
                    + "gmt_create,last_verified_at,retention_until FROM ma_resource WHERE resource_key=?",
                    key, id, bytes.length, digest, bytes, oldKey)).isEqualTo(1);
            assertThat(jdbc.update("UPDATE ma_message SET body_resource_key=? WHERE body_resource_key=?", key, oldKey)).isEqualTo(1);
            assertThat(jdbc.update("UPDATE ma_resource_ref SET resource_key=?,resource_id=? WHERE resource_key=?", key, id, oldKey)).isEqualTo(1);
            assertThat(jdbc.update("DELETE FROM ma_resource WHERE resource_key=?", oldKey)).isEqualTo(1);
        });
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
