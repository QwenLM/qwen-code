package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The two Agent-configuration kinds are published once at Session creation and stay PUBLISHED for
 * the Session's whole life: {@code JournalResourceWrites.publishAgentResource} writes that state
 * and no writer ever promotes them to REFERENCED. The transaction reader already treats PUBLISHED
 * as their committed terminal state ({@code JournalStoreRows.storedResource} and
 * {@code verifyStoredResource}), but the record reader used by the package child-launch path
 * ({@code JdbcManagedSessionSkills.fromLaunchReference} via {@code readCommittedResource}) required
 * REFERENCED alone. Every content-only suite launch therefore died in ChildResultRelay with
 * "Missing committed MCP resource." and the parent Turn waited forever for a child that could
 * never be created.
 *
 * <p>The exemption these cases pin is bounded by kind, schema version and the transaction reader's
 * own byte ceilings. Every other kind, storage mode and integrity predicate stays exactly as
 * strict, which the negative arms below prove rather than assert. The REFERENCED path and the
 * capture guards are pinned as well: admitting a captured receipt leaves capture_state='VERIFIED'
 * on a REFERENCED row and that reader accepts it, so this one has to accept it too.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:published-agent-configuration;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedPublishedAgentConfigurationTest {
    private static final String TENANT = "tenant-published-config";
    private static final String WORKSPACE = "workspace-published-config";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private JdbcManagedSessionStore sessionStore;

    @Autowired
    private JdbcManagedExtensionRecordStore records;

    @Autowired
    private JdbcManagedSessionSkills sessionSkills;

    @Autowired
    private ManagedAgentService agents;

    @Autowired
    @Qualifier("managedJdbcTemplate")
    private JdbcTemplate jdbc;

    @Test
    void readsThePublishedAgentConfigurationKindsAndStillRefusesEveryOtherPublishedRow() throws Exception {
        String sessionId = session();
        List<Map<String, Object>> skills = List.of(Map.of("name", "review", "description", "Review",
                "body", "Read the diff. 读取差异。", "base_directory", ".qwen/skills/review"));
        var publishedSkills = sessionStore.publishAgentSkills(TENANT, WORKSPACE, sessionId, skills);
        var publishedInstructions = sessionStore.publishAgentInstructions(TENANT, WORKSPACE, sessionId, "");
        for (var ref : List.of(publishedSkills, publishedInstructions)) {
            assertThat(state(sessionId, ref.resourceId())).isEqualTo("PUBLISHED");
        }
        assertThat(JSON.readTree(records.readCommittedResource(TENANT, sessionId, ref(publishedSkills)).bytes()))
                .isEqualTo(JSON.valueToTree(skills));
        assertThat(records.readCommittedResource(TENANT, sessionId, ref(publishedInstructions)).bytes())
                .isEqualTo(new byte[0]);
        // The exact call the package child launch makes for the parent's pinned catalog.
        assertThat(sessionSkills.fromLaunchReference(TENANT, sessionId, ref(publishedSkills)))
                .isEqualTo(AgentDefinitionExtensions.sessionSkills(skills));
        assertThatThrownBy(() -> records.readCommittedResource("other-tenant", sessionId, ref(publishedSkills)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo(JdbcManagedExtensionRecordStore.ERROR_REJECTED));
        assertThatThrownBy(() -> records.readCommittedResource(TENANT, "absent-session", ref(publishedSkills)))
                .hasMessageContaining("Missing committed MCP resource");
        ObjectNode wrongDigest = ref(publishedSkills);
        wrongDigest.put("digest", "d".repeat(64));
        assertThatThrownBy(() -> records.readCommittedResource(TENANT, sessionId, wrongDigest))
                .hasMessageContaining("does not match its committed resource");
        jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE tenant_id = ? AND session_id = ?"
                        + " AND resource_id = ?", "[]".getBytes(StandardCharsets.UTF_8),
                TENANT, sessionId, publishedSkills.resourceId());
        assertThatThrownBy(() -> records.readCommittedResource(TENANT, sessionId, ref(publishedSkills)))
                .hasMessageContaining("committed MCP resource is corrupt");
        restore(sessionId, publishedSkills, skills);
        assertThat(records.readCommittedResource(TENANT, sessionId, ref(publishedSkills)).digest())
                .isEqualTo(publishedSkills.digest());
    }

    @Test
    void stillRefusesEveryOtherKindAndEveryStateOrStorageOutsideTheTwoPublishedConfigurationKinds()
            throws Exception {
        String sessionId = session();
        List<Map<String, Object>> skills = List.of(Map.of("name", "review", "description", "Review",
                "body", "Read the diff.", "base_directory", ".qwen/skills/review"));
        var publishedSkills = sessionStore.publishAgentSkills(TENANT, WORKSPACE, sessionId, skills);
        // A PUBLISHED row of any other kind stays unreadable even inside its own byte ceiling.
        byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
        for (String kind : List.of("managed-tool-result-content", "managed-tool-result-page",
                "managed-tool-result-manifest", "managed-extension-config-bundle", "managed-child_run")) {
            String resourceId = "published-" + UUID.randomUUID();
            insertPublished(sessionId, resourceId, kind, 1, body);
            assertThatThrownBy(() -> records.readCommittedResource(TENANT, sessionId,
                    ref(new ToolResultResourceRef(resourceId, kind, 1, body.length,
                            ExtensionRecordJournal.sha256(body)))))
                    .as(kind).hasMessageContaining("Missing committed MCP resource");
        }
        // The same two kinds leave the exemption as soon as any other predicate stops holding.
        for (String update : List.of(
                "storage_kind = 'OSS_OBJECT', inline_bytes = NULL, object_key = X'6b'",
                "byte_length = " + (ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES + 1L),
                "byte_length = 0",
                "schema_version = 2",
                "deletion_operation_key = '" + "e".repeat(64) + "'",
                "state = 'COLLECTED'")) {
            jdbc.update("UPDATE ma_resource SET " + update + " WHERE tenant_id = ? AND session_id = ?"
                    + " AND resource_id = ?", TENANT, sessionId, publishedSkills.resourceId());
            assertThatThrownBy(() -> records.readCommittedResource(TENANT, sessionId, ref(publishedSkills)))
                    .as(update).hasMessageContaining("Missing committed MCP resource");
            restore(sessionId, publishedSkills, skills);
            assertThat(records.readCommittedResource(TENANT, sessionId, ref(publishedSkills)).digest())
                    .as(update).isEqualTo(publishedSkills.digest());
        }
        // The instructions ceiling is its own, not the Skills one.
        var instructions = sessionStore.publishAgentInstructions(TENANT, WORKSPACE, sessionId, "keep");
        jdbc.update("UPDATE ma_resource SET byte_length = ? WHERE tenant_id = ? AND session_id = ?"
                        + " AND resource_id = ?", ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES + 1L,
                TENANT, sessionId, instructions.resourceId());
        assertThatThrownBy(() -> records.readCommittedResource(TENANT, sessionId, ref(instructions)))
                .hasMessageContaining("Missing committed MCP resource");
    }

    @Test
    void aReferencedAgentConfigurationRowStaysReadable() {
        String sessionId = session();
        byte[] bytes = "{\"rules\":\"Referenced.\"}".getBytes(StandardCharsets.UTF_8);
        insertPublished(sessionId, "resource-referenced", "managed-agent-skills", 1, bytes);
        ObjectNode ref = ref(new ToolResultResourceRef("resource-referenced", "managed-agent-skills",
                1, bytes.length, ExtensionRecordJournal.sha256(bytes)));
        assertThat(records.readCommittedResource(TENANT, sessionId, ref).bytes()).isEqualTo(bytes);
        // The state every other kind still has to reach keeps resolving for these two as well.
        jdbc.update("UPDATE ma_resource SET state = 'REFERENCED' WHERE tenant_id = ? AND session_id = ?"
                + " AND resource_id = ?", TENANT, sessionId, "resource-referenced");
        assertThat(state(sessionId, "resource-referenced")).isEqualTo("REFERENCED");
        var referenced = records.readCommittedResource(TENANT, sessionId, ref);
        assertThat(referenced.bytes()).isEqualTo(bytes);
        assertThat(referenced.digest()).isEqualTo(ExtensionRecordJournal.sha256(bytes));
    }

    @Test
    void anAdmittedCapturedReceiptStaysReadableAndAQuarantinedOneDoesNot() {
        // ToolPublicationAdmissionStore.referenceCapturedResource promotes a VERIFIED capture row to
        // REFERENCED + MYSQL_INLINE and leaves capture_state set, so this reader has to accept that
        // shape exactly as JournalStoreRows.verifyStoredResource does. It is also a REFERENCED row of
        // a kind outside the PUBLISHED exemption, which pins that the REFERENCED branch carries no
        // kind whitelist. Quarantine later flips the same row without touching state, and both
        // readers refuse every capture_state that is not VERIFIED.
        String sessionId = session();
        byte[] bytes = "{\"outcome\":\"delivered\"}".getBytes(StandardCharsets.UTF_8);
        insertCapturedReceipt(sessionId, "resource-outcome", bytes);
        ObjectNode ref = ref(new ToolResultResourceRef("resource-outcome", "managed-tool-outcome",
                1, bytes.length, ExtensionRecordJournal.sha256(bytes)));
        var admitted = records.readCommittedResource(TENANT, sessionId, ref);
        assertThat(admitted.bytes()).isEqualTo(bytes);
        assertThat(admitted.digest()).isEqualTo(ExtensionRecordJournal.sha256(bytes));
        for (String captureState : List.of("QUARANTINED", "CANDIDATE", "COLLECTED")) {
            jdbc.update("UPDATE ma_resource SET capture_state = ? WHERE tenant_id = ? AND session_id = ?"
                    + " AND resource_id = ?", captureState, TENANT, sessionId, "resource-outcome");
            assertThatThrownBy(() -> records.readCommittedResource(TENANT, sessionId, ref))
                    .as(captureState).hasMessageContaining("Missing committed MCP resource");
        }
    }

    /** A public Session with the writer lease the production publishers require. */
    private String session() {
        String sessionId = agents.createSession(TENANT, TENANT, "published-config-" + UUID.randomUUID(),
                "qwen-code", null, "published-config", Map.of(), List.of()).sessionId();
        new ExtensionRecordJournal(sessionStore, TENANT, WORKSPACE, sessionId).open();
        return sessionId;
    }

    private String state(String sessionId, String resourceId) {
        return jdbc.queryForObject("SELECT state FROM ma_resource WHERE tenant_id = ?"
                        + " AND session_id = ? AND resource_id = ?", String.class,
                TENANT, sessionId, resourceId);
    }

    /** The closed durable reference shape the production publisher's receipt travels in. */
    private static ObjectNode ref(ToolResultResourceRef resource) {
        return JSON.createObjectNode().put("resourceId", resource.resourceId()).put("kind", resource.kind())
                .put("schemaVersion", resource.schemaVersion()).put("byteLength", resource.byteLength())
                .put("digest", resource.digest());
    }

    /** Restores a published Skills row byte for byte, whatever an earlier arm mutated. */
    private void restore(String sessionId, ToolResultResourceRef ref, List<Map<String, Object>> skills) {
        jdbc.update("DELETE FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                TENANT, sessionId, ref.resourceId());
        insertPublished(sessionId, ref.resourceId(), ref.kind(), ref.schemaVersion(),
                AgentDefinitionExtensions.skillsBytes(skills));
    }

    /** One inline PUBLISHED row exactly as JournalResourceWrites.publishAgentResource writes it. */
    private void insertPublished(String sessionId, String resourceId, String kind,
            int schemaVersion, byte[] bytes) {
        String scopeKey = ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                        + " inline_bytes, publish_command_id, state, gmt_create, last_verified_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MYSQL_INLINE', ?, ?, 'PUBLISHED', ?, ?)",
                ManagedSessionStore.resourceKey(scopeKey, resourceId), scopeKey, TENANT, WORKSPACE, sessionId,
                resourceId, kind, schemaVersion, bytes.length, ExtensionRecordJournal.sha256(bytes), bytes,
                resourceId, 1_000L, 1_000L);
    }

    /** One admitted receipt row as ToolPublicationAdmissionStore.referenceCapturedResource leaves it. */
    private void insertCapturedReceipt(String sessionId, String resourceId, byte[] bytes) {
        String scopeKey = ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        // ck_ma_resource_capture ties capture_state to the capture identity tuple: those four columns
        // are NULL together or NOT NULL together, and uk_ma_capture_slot keeps the tuple unique.
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                        + " inline_bytes, publish_command_id, state, scope_key, publication_id, slot_key,"
                        + " capture_state, gmt_create, last_verified_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 'managed-tool-outcome', 1, ?, ?, 'MYSQL_INLINE', ?, ?,"
                        + " 'REFERENCED', ?, ?, X'61646d697373696f6e', 'VERIFIED', ?, ?)",
                ManagedSessionStore.resourceKey(scopeKey, resourceId), scopeKey, TENANT, WORKSPACE, sessionId,
                resourceId, bytes.length, ExtensionRecordJournal.sha256(bytes), bytes, resourceId,
                ManagedSchemaKeys.key("capture", resourceId), "publication-" + resourceId, 1_000L, 1_000L);
    }
}
