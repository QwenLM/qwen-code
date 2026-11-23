package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
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
 * #17261: a content-only suite child never produced a byte of output and the parent Turn died at
 * its deadline with {@code hosted_turn_deadline_exceeded}.
 *
 * <p>The launch itself succeeded. {@code QwenHostedHarnessConnector.publicChildExtensionAgent}
 * copies the parent's active extension configuration into the child Session —
 * {@code JournalResourceWrites.publishInheritedExtensionResource} for the bundle, every
 * contributions manifest and every part — and that publisher writes {@code state='PUBLISHED'},
 * reusing the parent's resource ids. No writer ever promotes those kinds to REFERENCED. But every
 * reader of a committed resource only admitted PUBLISHED for the two Agent-definition kinds
 * (#17207), and {@code JournalStoreRows.toolResultLimit} returns 0 for the extension kinds, so the
 * child's very first read of its own inherited bundle
 * ({@code managed.resources.read(effectiveConfigRef)} in hosted-harness-session.ts) was answered
 * 500 {@code managed_session_resource_corrupt} by
 * {@code ManagedSessionStoreController.resource} → {@code readOwnerResource} →
 * {@code JournalStoreRows.verifyStoredResource}.
 *
 * <p>That read runs BEFORE the child acquires a Runtime, so the child never binds, and
 * ChildResultRelay's {@code binding} arm — the only thing standing between it and the
 * {@code watching} arm that reads the child's Turn — threw {@code RelayRetry} forever. These cases
 * pin the read side of the repair on all three readers the launch actually uses; the relay's own
 * visibility repair is pinned by {@code ChildResultRelayTest}.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:inherited-extension-configuration;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedInheritedExtensionConfigurationTest {
    private static final String TENANT = "tenant-inherited-extension";
    private static final String WORKSPACE = "workspace-inherited-extension";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private JdbcManagedSessionStore sessionStore;

    @Autowired
    private JdbcManagedExtensionRecordStore records;

    @Autowired
    private ManagedAgentService agents;

    @Autowired
    @Qualifier("managedJdbcTemplate")
    private JdbcTemplate jdbc;

    /**
     * The cases below iterate this set, and the publisher gates on it, so an emptied set would make
     * them pass vacuously while every inherited copy is refused again. Pin its members.
     */
    @Test
    void theInheritedKindSetNamesExactlyTheThreeKindsTheConnectorCopies() {
        assertThat(ManagedSessionStoreModels.INHERITED_EXTENSION_KINDS)
                .containsExactlyInAnyOrder("managed-extension-config-bundle",
                        "managed-extension-contributions",
                        "managed-extension-contributions-part");
    }

    /**
     * The whole inherited chain, read back through every reader the child launch uses. The owner
     * read is the exact call the child's {@code managed.resources.read} lands on, so it is the one
     * that has to answer bytes rather than 500.
     */
    @Test
    void everyInheritedExtensionKindIsReadableThroughEveryCommittedResourceReader() {
        String parent = session();
        String child = session();
        for (String kind : ManagedSessionStoreModels.INHERITED_EXTENSION_KINDS) {
            byte[] bytes = body(kind);
            String resourceId = "inherited-" + UUID.randomUUID();
            insertReferenced(parent, resourceId, kind, bytes);
            StoredResource source = records.readCommittedResource(TENANT, parent,
                    ref(resourceId, kind, bytes));

            // The connector's own publication call, into the child's scope.
            ToolResultResourceRef copied = sessionStore.publishInheritedExtensionResource(
                    TENANT, WORKSPACE, child, source);
            assertThat(copied.resourceId()).isEqualTo(resourceId);
            assertThat(state(child, resourceId)).isEqualTo("PUBLISHED");

            // 1. The record reader: readCommittedResource / readRecordResource.
            assertThat(records.readCommittedResource(TENANT, child,
                    ref(resourceId, kind, bytes)).bytes()).isEqualTo(bytes);
            // 2. The owner read: GET /resources/{id}, the child Harness's actual call.
            assertThat(sessionStore.readOwnerResource(TENANT, WORKSPACE, child, resourceId,
                    ExtensionRecordJournal.TOKEN).bytes()).isEqualTo(bytes);
            // 3. The transaction reader, which the child's own commit path uses.
            assertThat(sessionStore.readResource(TENANT, WORKSPACE, child, resourceId,
                    ExtensionRecordJournal.TOKEN).bytes()).isEqualTo(bytes);
        }
    }

    /**
     * The retry self-inflicted wound: the inheritance reuses the parent's resource id, so a second
     * child create/load finds the row already there and publishAgentResource verifies the EXISTING
     * row before comparing it. While PUBLISHED extension rows were refused, that verification threw
     * 500 too — the child could not be re-created either, so no retry could ever self-heal.
     */
    @Test
    void inheritingTheSameResourceAgainIsIdempotentRatherThanCorrupt() {
        String parent = session();
        String child = session();
        for (String kind : ManagedSessionStoreModels.INHERITED_EXTENSION_KINDS) {
            byte[] bytes = body(kind);
            String resourceId = "repeat-" + UUID.randomUUID();
            insertReferenced(parent, resourceId, kind, bytes);
            StoredResource source = records.readCommittedResource(TENANT, parent,
                    ref(resourceId, kind, bytes));
            ToolResultResourceRef first = sessionStore.publishInheritedExtensionResource(
                    TENANT, WORKSPACE, child, source);
            ToolResultResourceRef again = sessionStore.publishInheritedExtensionResource(
                    TENANT, WORKSPACE, child, source);
            assertThat(again).isEqualTo(first);
            assertThat(state(child, resourceId)).isEqualTo("PUBLISHED");
            assertThat(sessionStore.readOwnerResource(TENANT, WORKSPACE, child, resourceId,
                    ExtensionRecordJournal.TOKEN).bytes()).isEqualTo(bytes);
        }
    }

    /**
     * The exemption stays bounded. Each arm mutates exactly one predicate away from a readable
     * inherited row and proves every reader refuses it again — the repair widens a whitelist, it
     * does not weaken verification.
     */
    @Test
    void theInheritedExemptionStaysBoundedByKindSchemaBytesAndIntegrity() {
        String parent = session();
        String child = session();
        String kind = "managed-extension-config-bundle";
        byte[] bytes = body(kind);
        String resourceId = "bounded-" + UUID.randomUUID();
        insertReferenced(parent, resourceId, kind, bytes);
        sessionStore.publishInheritedExtensionResource(TENANT, WORKSPACE, child,
                records.readCommittedResource(TENANT, parent, ref(resourceId, kind, bytes)));

        for (String update : List.of(
                "schema_version = 2",
                "byte_length = " + (ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES + 1L),
                // An inherited extension resource is never legitimately empty.
                "byte_length = 0",
                "state = 'COLLECTED'",
                "deletion_operation_key = '" + "e".repeat(64) + "'")) {
            jdbc.update("UPDATE ma_resource SET " + update + " WHERE tenant_id = ?"
                    + " AND session_id = ? AND resource_id = ?", TENANT, child, resourceId);
            assertThatThrownBy(() -> records.readCommittedResource(TENANT, child,
                    ref(resourceId, kind, bytes)))
                    .as(update).hasMessageContaining("Missing committed MCP resource");
            // The owner read refuses the very same rows with its own coded
            // verdict. Asserting merely "it threw" would let any unrelated
            // failure — an unwired bean, a typo in the scope — pass this arm.
            assertThatThrownBy(() -> sessionStore.readOwnerResource(TENANT, WORKSPACE, child,
                    resourceId, ExtensionRecordJournal.TOKEN))
                    .as(update).isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode())
                                    .isEqualTo("managed_session_resource_corrupt"));
            restoreInherited(child, resourceId, kind, bytes);
        }

        // The storage-mode arm is separate, and only the record reader is
        // asserted: its SQL admits MYSQL_INLINE alone, so an external row is
        // refused here. The owner reader legitimately accepts OSS_OBJECT for
        // any kind — that arm never consulted the kind whitelist, before this
        // repair or after — and would go on to an object store this profile
        // leaves unwired. Asserting that unwired failure would pin the test
        // environment, not the exemption.
        jdbc.update("UPDATE ma_resource SET storage_kind = 'OSS_OBJECT',"
                        + " inline_bytes = NULL, object_key = X'6b' WHERE tenant_id = ?"
                        + " AND session_id = ? AND resource_id = ?",
                TENANT, child, resourceId);
        assertThatThrownBy(() -> records.readCommittedResource(TENANT, child,
                ref(resourceId, kind, bytes)))
                .hasMessageContaining("Missing committed MCP resource");
        restoreInherited(child, resourceId, kind, bytes);

        // A kind outside every PUBLISHED exemption gains nothing, even as a valid
        // inline row. Not a tool-result kind: those carry their own PUBLISHED
        // allowance under toolResultLimit, which is a separate contract.
        String otherId = "outside-" + UUID.randomUUID();
        insertPublished(child, otherId, "managed-child_run", bytes);
        assertThatThrownBy(() -> records.readCommittedResource(TENANT, child,
                ref(otherId, "managed-child_run", bytes)))
                .hasMessageContaining("Missing committed MCP resource");
        assertThatThrownBy(() -> sessionStore.readOwnerResource(TENANT, WORKSPACE, child,
                otherId, ExtensionRecordJournal.TOKEN))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("managed_session_resource_corrupt"));

        // The publisher's own kind gate is unchanged: it still refuses to inherit anything else.
        String foreignId = "foreign-" + UUID.randomUUID();
        insertReferenced(parent, foreignId, "managed-child_run", bytes);
        StoredResource foreign = records.readCommittedResource(TENANT, parent,
                ref(foreignId, "managed-child_run", bytes));
        assertThatThrownBy(() -> sessionStore.publishInheritedExtensionResource(
                TENANT, WORKSPACE, child, foreign))
                .hasMessageContaining("Invalid inherited extension resource");

        // Scope is still enforced: the child's copy is not readable as another Session's.
        assertThatThrownBy(() -> records.readCommittedResource(TENANT, session(),
                ref(resourceId, kind, bytes)))
                .hasMessageContaining("Missing committed MCP resource");
    }

    private static byte[] body(String kind) {
        return ("{\"kind\":\"" + kind + "\",\"formatVersion\":1,\"packages\":[]}")
                .getBytes(StandardCharsets.UTF_8);
    }

    /** A public Session with the writer lease every production publisher and reader requires. */
    private String session() {
        String sessionId = agents.createSession(TENANT, TENANT,
                "inherited-extension-" + UUID.randomUUID(), "qwen-code", null,
                "inherited-extension", Map.of(), List.of()).sessionId();
        new ExtensionRecordJournal(sessionStore, TENANT, WORKSPACE, sessionId).open();
        return sessionId;
    }

    private String state(String sessionId, String resourceId) {
        return jdbc.queryForObject("SELECT state FROM ma_resource WHERE tenant_id = ?"
                        + " AND session_id = ? AND resource_id = ?", String.class,
                TENANT, sessionId, resourceId);
    }

    private static ObjectNode ref(String resourceId, String kind, byte[] bytes) {
        return JSON.createObjectNode().put("resourceId", resourceId).put("kind", kind)
                .put("schemaVersion", 1).put("byteLength", bytes.length)
                .put("digest", ExtensionRecordJournal.sha256(bytes));
    }

    private void restoreInherited(String sessionId, String resourceId, String kind,
            byte[] bytes) {
        jdbc.update("DELETE FROM ma_resource WHERE tenant_id = ? AND session_id = ?"
                + " AND resource_id = ?", TENANT, sessionId, resourceId);
        insertPublished(sessionId, resourceId, kind, bytes);
    }

    /** The parent's committed row, as JournalResourceWrites.insertResource leaves it. */
    private void insertReferenced(String sessionId, String resourceId, String kind,
            byte[] bytes) {
        insert(sessionId, resourceId, kind, bytes, "REFERENCED");
    }

    /** One inline PUBLISHED row exactly as publishAgentResource writes it. */
    private void insertPublished(String sessionId, String resourceId, String kind,
            byte[] bytes) {
        insert(sessionId, resourceId, kind, bytes, "PUBLISHED");
    }

    private void insert(String sessionId, String resourceId, String kind, byte[] bytes,
            String state) {
        String scopeKey = ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        jdbc.update("INSERT INTO ma_resource (resource_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                        + " state, gmt_create, last_verified_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, ?, ?, ?, ?)",
                ManagedSessionStore.resourceKey(scopeKey, resourceId), TENANT,
                WORKSPACE, sessionId, resourceId, kind, bytes.length,
                ExtensionRecordJournal.sha256(bytes), bytes, resourceId, state, 1_000L, 1_000L);
    }
}
