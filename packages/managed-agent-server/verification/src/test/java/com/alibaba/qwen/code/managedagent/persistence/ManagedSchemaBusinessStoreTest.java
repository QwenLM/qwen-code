package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.InputStream;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Business stores run directly against the canonical schema, with no old-table fixtures. */
public class ManagedSchemaBusinessStoreTest {
    protected JdbcTemplate jdbc;
    protected DataSourceTransactionManager manager;
    private String tenant;
    private String session;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:business-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        return source;
    }

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        tenant = "tenant-" + UUID.randomUUID();
        session = "session-" + UUID.randomUUID();
    }

    @Test
    void definitionAndAutomationReceiptsHaveSeparateNamespacesAndExactReplay() {
        JdbcManagedAgentDefinitionStore definitions = new JdbcManagedAgentDefinitionStore(jdbc, new RequestDigests());
        var admitted = definitions.create(tenant, "same-key", "request-1", "agent", "digest", "{}", 1);
        assertThat(definitions.create(tenant, "same-key", "request-1", "ignored", "other", "{}", 2).replayed()).isTrue();
        assertThat(admitted.revision().agentId()).isEqualTo("agent");
        assertThatThrownBy(() -> definitions.create(tenant, "same-key", "request-2", "ignored", "other", "{}", 2))
                .hasMessageContaining("different request");
        JdbcAutomationLedgerStore automation = new JdbcAutomationLedgerStore(jdbc);
        var command = new JdbcAutomationLedgerStore.CommandRow(tenant, "same-key", "actor", "request-3", "schedule", "{}");
        assertThat(automation.claimCommand(session, command, 3)).isTrue();
        assertThat(automation.claimCommand(session, command, 4)).isFalse();
        assertThat(automation.settleCommand(tenant, "same-key", "request-3", "actor", "{\"accepted\":true}")).isTrue();
        assertThat(automation.settleCommand(tenant, "same-key", "request-3", "actor", "{}")).isFalse();
        assertThat(automation.findCommand(tenant, "same-key").orElseThrow().resultJson()).contains("accepted");
    }

    @Test
    void domainRecordsReadOnlyTheResourceInTheirOriginalSession() {
        String resourceId = "definition-body";
        var references = new java.util.HashMap<String, JsonNode>();
        for (String ownerSession : List.of(session, session + " ")) {
            byte[] bytes = ownerSession.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            String scope = ManagedSessionStore.sessionScopeKey(tenant, ownerSession);
            references.put(ownerSession, new ObjectMapper().createObjectNode()
                    .put("resourceId", resourceId).put("kind", "automation-definition")
                    .put("schemaVersion", 1).put("byteLength", bytes.length)
                    .put("digest", ToolPublicationContract.sha256(bytes)));
            jdbc.update(
                    "INSERT INTO ma_resource (resource_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES (?, ?, ?, ?, 'automation-definition', 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                    ManagedSchemaKeys.key(scope, resourceId), tenant, ownerSession, resourceId,
                    bytes.length, ToolPublicationContract.sha256(bytes), bytes);
        }
        JdbcManagedExtensionRecordStore records = new JdbcManagedExtensionRecordStore(jdbc);
        for (String ownerSession : references.keySet()) {
            assertThat(new String(records.readCommittedResource(tenant, ownerSession,
                    references.get(ownerSession)).bytes(), java.nio.charset.StandardCharsets.UTF_8))
                    .isEqualTo(ownerSession);
        }
        assertThatThrownBy(() -> records.readCommittedResource(tenant, "missing", references.get(session)))
                .hasMessageContaining("Missing committed");
        assertThatThrownBy(() -> records.readCommittedResource(
                tenant.toUpperCase(java.util.Locale.ROOT), session, references.get(session)))
                .hasMessageContaining("Missing committed");
    }

    @Test
    void channelIngressReceiptFixesOriginalRoutingAndSemanticRevision() {
        JdbcChannelRouteRepository routes = new JdbcChannelRouteRepository(jdbc);
        var candidate = route("event", 1, session);
        var staged = routes.findOrCreate(candidate);
        assertThat(staged.stagedAttachmentRefs()).containsExactly("attachment");
        assertThat(routes.findOrCreate(route("event", 1, "another-session")).sessionId()).isEqualTo(session);
        assertThat(routes.admit(tenant, staged.routeKey(), "input").state()).isEqualTo("admitted");
        assertThat(routes.admit(tenant, staged.routeKey(), "other-input")).isNull();
        assertThat(routes.findOrCreate(route("event", 2, session)).routeKey()).isNotEqualTo(staged.routeKey());
        assertThat(routes.listByChannel(tenant, "channel", null, 10).routes()).hasSize(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ?"
                + " AND operation_kind = 'CHANNEL_INGRESS'", Long.class, tenant)).isEqualTo(2);
    }

    private ChannelRouteRepository.ChannelRoute route(String event, long revision, String target) {
        return new ChannelRouteRepository.ChannelRoute(tenant, "unused", "channel", 1, event, revision,
                target, "sender", null, null, "staged", null, List.of("attachment"), 0, 0);
    }

    @Test
    void anotherTenantDeliveryCannotHideAnIdenticallyNamedPendingMessage() {
        String foreignTenant = tenant + "-foreign";
        for (String ownerTenant : List.of(tenant, foreignTenant)) {
            String scope = ManagedSessionStore.sessionScopeKey(ownerTenant, session);
            jdbc.update(
                    "INSERT INTO ma_session_record (record_key, tenant_id, workspace_id, session_id, domain, record_id, revision, record_resource_id, delivery_target, delivery_state, gmt_create) VALUES (?, ?, 'workspace', ?, 'session_message', 'message', 1, 'body', 'session', 'planned', 0)", ManagedExtensionProjection.recordKey(session, "session_message", "message"), ownerTenant, session);
        }
        JdbcSessionMessageRelayStore relay = new JdbcSessionMessageRelayStore(jdbc);
        var foreignClaim = relay.claim(foreignTenant, session, "message", "worker", 1000, 1);
        relay.classify(foreignClaim, "worker", "done", null, 2);
        assertThat(relay.findPendingMessages("worker", 3, 10)).singleElement()
                .extracting(JdbcSessionMessageRelayStore.PendingMessage::tenantId).isEqualTo(tenant);
        assertThat(relay.currentRecord(tenant, session, "session_message", "message").deliveryState()).isEqualTo("planned");
    }

    @Test
    void messageDeliverySettlementRequiresTheCurrentClaimGeneration() {
        JdbcSessionMessageRelayStore relay = new JdbcSessionMessageRelayStore(jdbc);
        var old = relay.claim(tenant, session, "message", "same-owner", 1000, 1);
        var current = relay.claim(tenant, session, "message", "same-owner", 2000, 2);
        assertThat(current.claimGeneration()).isGreaterThan(old.claimGeneration());
        relay.classify(old, "same-owner", "unknown", "stale", 3);
        assertThat(relay.find(tenant, session, "message").state()).isEqualTo("relaying");
        relay.advance(current, "same-owner", "delivered", "target", 4, 2000, 3);
        relay.classify(current, "same-owner", "done", null, 4);
        assertThat(relay.find(tenant, session, "message").state()).isEqualTo("done");
        assertThat(relay.claim(tenant, session, "message", "replacement", 3000, 2001)).isNull();
        assertThat(jdbc.queryForObject("SELECT consumption_state FROM ma_delivery WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo("consumed");
    }

    @Test
    void childResultReadsTheImmutableBodyOfALargeLatestMessage() throws Exception {
        new TransactionTemplate(manager).executeWithoutResult(status -> ToolPublicationRetentionStore.lockSession(jdbc, tenant, session));
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String text = "large-child-result-".repeat(4096);
        var json = new ObjectMapper();
        var parts = json.createArrayNode();
        parts.addObject().put("partId", "answer").put("type", "output_text").put("text", text)
                .put("firstSequence", 1).put("lastSequence", 1);
        byte[] bytes = json.writeValueAsBytes(parts);
        assertThat(bytes.length).isGreaterThan(64 * 1024);
        String resource = ManagedSchemaKeys.key(scope, "message-body");
        jdbc.update(
                "INSERT INTO ma_resource (resource_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES (?, ?, ?, 'message-body', 'managed-message-parts', 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                resource, tenant, session, bytes.length, ToolPublicationContract.sha256(bytes), bytes);
        jdbc.update(
                "INSERT INTO ma_message (tenant_id, session_id, item_id, turn_id, item_type, item_role, item_status, attributes_json, first_sequence, last_sequence, gmt_create, gmt_modified, parts_json, body_resource_key) VALUES (?, ?, 'item', 'turn', 'message', 'assistant', 'completed', '{}', 1, 1, 0, 0, '[]', ?)",
                tenant, session, resource);
        JdbcChildResultRelayStore relay = new JdbcChildResultRelayStore(jdbc);
        assertThat(relay.terminalResultText(tenant, session, "turn")).isEqualTo(text);
        jdbc.update("UPDATE ma_resource SET sha256 = ? WHERE resource_key = ?", "f".repeat(64), resource);
        assertThatThrownBy(() -> relay.terminalResultText(tenant, session, "turn")).hasMessageContaining("unavailable or corrupt");
    }

    @Test
    void childCloseDebtSurvivesResultDeliveryCompletionInItsOwnOperation() {
        JdbcChildResultRelayStore relay = new JdbcChildResultRelayStore(jdbc);
        var start = relay.claim(tenant, session, "run", "creation", "worker", 1000, 1);
        relay.advance(start, "worker", "close_debt", "child", 10, "close unavailable", 1000, 2);
        var debt = relay.find(tenant, session, "run");
        assertThat(debt.operationKind()).isEqualTo("CHILD_SESSION_CLOSE");
        assertThat(debt.state()).isEqualTo("close_debt");
        assertThat(relay.findPendingChildren("worker", 11, 10)).singleElement()
                .extracting(JdbcChildResultRelayStore.PendingChild::childRunId).isEqualTo("run");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ?",
                Long.class, tenant)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT transport_state FROM ma_delivery WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo("delivered");
        jdbc.update(
                "UPDATE ma_delivery SET reception_state = 'accepted', consumption_state ="
                        + " 'consumed' WHERE tenant_id = ?", tenant);
        relay.classify(start, "worker", "done", null, 3);
        assertThat(relay.find(tenant, session, "run").state()).isEqualTo("close_debt");
        var current = relay.claim(tenant, session, "run", "creation", "worker", 2000, 11);
        relay.classify(current, "worker", "done", null, 12);
        assertThat(relay.find(tenant, session, "run").state()).isEqualTo("done");
        assertThat(jdbc.queryForMap(
                                "SELECT transport_state, reception_state, consumption_state FROM"
                                        + " ma_delivery WHERE tenant_id = ?", tenant))
                .containsEntry("transport_state", "delivered").containsEntry("reception_state", "accepted")
                .containsEntry("consumption_state", "consumed");
    }

    @Test
    void longReadRenewsOnlyItsOriginalLiveLeaseAndRetirementFencesIt() {
        ToolPublicationRetentionStore retention = new ToolPublicationRetentionStore(jdbc, manager);
        try (var lease = retention.read(tenant, session)) {
            long now = ToolPublicationRetentionStore.now(jdbc);
            jdbc.update("UPDATE ma_read_lease SET expires_at = ? WHERE tenant_key = ?", now + 10000,
                    ToolPublicationRetentionStore.hash(tenant));
            lease.check();
            assertThat(jdbc.queryForObject("SELECT expires_at FROM ma_read_lease WHERE tenant_key = ?",
                    Long.class, ToolPublicationRetentionStore.hash(tenant))).isGreaterThan(now + 100000);
            new TransactionTemplate(manager).executeWithoutResult(status -> {
                ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
                ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete");
            });
            assertThatThrownBy(lease::check).hasMessageContaining("retired");
            assertThatThrownBy(() -> retention.read(tenant, session)).hasMessageContaining("retired");
        }
    }

    @Test
    void unknownPhysicalPutOccupancyBlocksCollectionAfterPermanentRetirement() {
        ToolPublicationRetentionStore retention = new ToolPublicationRetentionStore(jdbc, manager);
        var key = new ObjectMapper().createObjectNode().put("tenantId", tenant).put("workspaceId", "workspace")
                .put("sessionId", session);
        String scope = ToolPublicationDataStore.scope(key);
        String hash = ManagedSchemaKeys.key("capture");
        jdbc.update(
                "INSERT INTO ma_output_capture (scope_key, tenant_id, workspace_id,"
                    + " session_id, publication_id, execution_key, capture_id, binding_json,"
                    + " binding_digest, token_hash, state, capture_bytes, producer_bytes,"
                    + " admission_bytes, producer_phase, is_write_evidence, is_accepted_complete) VALUES"
                    + " (?, ?, 'workspace', ?, 'capture', ?, 'capture-id', '{}', ?, ?, 'FENCED',"
                    + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE)",
                scope, tenant, session, hash, hash, hash);
        var writes = new java.util.concurrent.atomic.AtomicInteger();
        ToolPublicationObjectStore unknown = new ToolPublicationObjectStore() {
            @Override
            public InputStream openRange(String key, long offset, long length, Runnable guard) {
                guard.run();
                try (InputStream full = open(key)) {
                    byte[] bytes = full.readAllBytes();
                    return new java.io.ByteArrayInputStream(bytes, (int) offset, (int) length);
                } catch (java.io.IOException error) {
                    throw new IllegalStateException(error);
                }
            }
            @Override public void putIfAbsent(String object, byte[] bytes) {
                writes.incrementAndGet();
                throw new IllegalStateException("connection lost");
            }
            @Override public InputStream open(String object) { throw new UnsupportedOperationException(); }
            @Override public void validateConfiguration() { }
        };
        assertThatThrownBy(() -> retention.put(key, scope, "capture", "object", new byte[] {1}, unknown))
                .hasMessageContaining("connection lost");
        assertThatThrownBy(() -> retention.put(key, scope, "capture", "object", new byte[] {1}, unknown))
                .hasMessageContaining("unresolved");
        assertThat(writes).hasValue(1);
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE tenant_id = ? AND"
                                        + " operation_kind = 'OBJECT_PUT'",
                String.class, tenant)).isEqualTo("UNKNOWN");
        new TransactionTemplate(manager).executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
            ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete");
        });
        assertThat(retention.observe(Duration.ZERO)).filteredOn(candidate -> tenant.equals(candidate.tenant())).singleElement()
                .extracting(ToolPublicationRetentionStore.Candidate::blocker).isEqualTo("put_unresolved");
    }
    @Test
    void privateResourceGcUsesAnOperationAndHonorsAnExistingReader() {
        var properties = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
        properties.getToolPublication().setGcEnabled(true);
        properties.getToolPublication().setDeletionGrace(Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(jdbc, manager, properties,
                () -> Duration.ofMinutes(2).toNanos());
        var retention = new ToolPublicationRetentionStore(jdbc, manager);
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        byte[] bytes = "hello".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        String resource = ManagedSchemaKeys.key(scope, "resource");
        jdbc.update(
                "INSERT INTO ma_resource (resource_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES (?, ?, 'workspace', ?, 'resource', 'managed-tool-result-content', 1, ?, ?, 'MYSQL_INLINE', ?, 'PUBLISHED', " + ManagedSchemaTime.SQL_NOW + ")",
                resource, tenant, session, bytes.length, ToolPublicationContract.sha256(bytes), bytes);
        assertThat(collector.runOnce()).isFalse();
        try (var reader = retention.read(tenant, session)) {
            reader.check();
            new TransactionTemplate(manager).executeWithoutResult(status -> {
                ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
                ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete");
            });
            var admitted = new SessionResourceCollectionCollector(jdbc, manager, properties,
                    () -> Duration.ofMinutes(3).toNanos());
            assertThat(admitted.runOnce()).isFalse();
            assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?",
                    byte[].class, resource)).isEqualTo(bytes);
        }
        jdbc.update(
                "UPDATE ma_operation SET available_at = 0 WHERE tenant_id = ? AND operation_kind ="
                        + " 'SESSION_RESOURCE_GC'", tenant);
        assertThat(collector.runOnce()).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?", String.class, resource))
                .isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?", byte[].class, resource)).isNull();
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE tenant_id = ? AND"
                                        + " operation_kind = 'SESSION_RESOURCE_GC'",
                String.class, tenant)).isEqualTo("SUCCEEDED");
    }

    @Test
    void retiredOwnerCleanupReleasesReferencedProjectionBodiesWithoutResettingStreamCounters() {
        var properties = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
        properties.getToolPublication().setGcEnabled(true);
        properties.getToolPublication().setDeletionGrace(Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(jdbc, manager, properties,
                () -> Duration.ofMinutes(2).toNanos());
        new TransactionTemplate(manager).executeWithoutResult(status -> ToolPublicationRetentionStore.lockSession(jdbc, tenant, session));
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        byte[] bytes = "hello".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        String digest = ToolPublicationContract.sha256(bytes);
        String resource = ManagedSchemaKeys.key(scope, "projection-body");
        jdbc.update(
                "INSERT INTO ma_resource (resource_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                resource, tenant, session, "projection-body", "managed-message-body", bytes.length, digest, bytes);
        jdbc.update(
                "INSERT INTO ma_message (tenant_id, session_id, item_id, turn_id, item_type, item_status, attributes_json, first_sequence, last_sequence, gmt_create, gmt_modified, parts_json, body_resource_key) VALUES (?, ?, 'item', 'turn', 'message', 'completed', '{}', 1, 7, 0, 0, '[]', ?)",
                tenant, session, resource);
        jdbc.update(
                "INSERT INTO ma_resource_ref (owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create) VALUES ('MESSAGE', ?, 1, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")", ManagedSchemaKeys.key(scope, "item"), resource, tenant, session, "projection-body");
        jdbc.update(
                "INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, last_sequence, replay_floor_sequence, covered_sequence, gmt_modified) VALUES (?, ?, 'SESSION', ?, 7, 2, 5, 0)",
                tenant, session, "");
        jdbc.update(
                "INSERT INTO ma_public_event (tenant_id, session_id, sequence_id, event_id, event_type, data_json, is_terminal, gmt_create) VALUES (?, ?, 7, ?, 'item.completed', '{}', FALSE, 0)", tenant, session, "event-" + tenant);
        new TransactionTemplate(manager).executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
            ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete");
        });
        assertThat(collector.runOnce()).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?", String.class, resource)).isEqualTo("REFERENCED");
        for (int batch = 0; batch < 8; batch++) {
            collector.runOnce();
        }
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?", String.class, resource)).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session)).isZero();
        assertThat(jdbc.queryForMap(
                                "SELECT last_sequence, replay_floor_sequence, covered_sequence FROM"
                                        + " ma_event_stream WHERE tenant_id = ?", tenant))
                .containsEntry("last_sequence", 7L).containsEntry("replay_floor_sequence", 7L);
        assertThat(jdbc.queryForObject("SELECT covered_sequence FROM ma_event_stream WHERE tenant_id = ?", Long.class, tenant))
                .isGreaterThanOrEqualTo(5L);
    }

    @Test
    void scheduleReadsPreserveBoundedAndAbsentCatchUpLimits() {
        JdbcAutomationLedgerStore automation = new JdbcAutomationLedgerStore(jdbc);
        for (String policy : List.of("bounded", "none")) {
            Long limit = policy.equals("bounded") ? 7L : null;
            jdbc.update(
                    "INSERT INTO ma_schedule (tenant_id, schedule_id, session_id, workspace_id,"
                            + " actor_id, record_revision, definition_revision, definition_digest,"
                            + " goal, cron, timezone, session_mode, overlap, catch_up, catch_up_limit,"
                            + " is_enabled, state, armed_at, gmt_create, gmt_modified) VALUES"
                            + " (?, ?, ?, 'workspace', 'actor', 1, 1, ?, 'goal', '0 * * * *', 'UTC',"
                            + " 'new_session', 'skip', ?, ?, TRUE, 'armed', 0, 0, 0)",
                    tenant, "schedule-" + policy, session, "a".repeat(64), policy, limit);
            var schedule = automation.findSchedule(tenant, "schedule-" + policy).orElseThrow();
            assertThat(schedule.catchUp()).isEqualTo(policy);
            assertThat(schedule.catchUpLimit()).isEqualTo(limit);
        }
    }

    @Test
    void schedulePagesUseCurrentRootPermissionsThroughoutTheChildWorkspaceChain() {
        seedSession(tenant, session, "PUBLIC", "ACTIVE");
        String root = "根!";
        String child = "子".repeat(80) + "Child!";
        String grandchild = "孙".repeat(168) + "Tail!   ";
        List<String> workspaces = List.of(root, child, grandchild, "foreign");
        for (int index = 0; index < workspaces.size(); index++) {
            String workspace = workspaces.get(index);
            seedWorkspace(tenant, workspace, index == 1 || index == 2 ? workspaces.get(index - 1) : null);
            seedSchedule(tenant, session, workspace, "schedule-" + index, index + 1);
        }
        grantWorkspace(tenant, root, "operator");
        grantWorkspace(tenant, grandchild, "operator");
        JdbcAutomationLedgerStore automation = new JdbcAutomationLedgerStore(jdbc);
        var first = automation.listReadableSchedules(tenant, "operator", null, 2);
        assertThat(first.hasMore()).isTrue();
        assertThat(first.rows()).extracting(JdbcAutomationLedgerStore.ScheduleRow::workspaceId).containsExactly(grandchild, child);
        var cursor = new JdbcAutomationLedgerStore.ScheduleCursor(2, "schedule-1");
        var second = automation.listReadableSchedules(tenant, "operator", cursor, 2);
        assertThat(second.rows()).extracting(JdbcAutomationLedgerStore.ScheduleRow::workspaceId).containsExactly(root);
        assertThat(second.hasMore()).isFalse();
        assertThat(automation.listReadableSchedules(tenant, "Operator", null, 2).rows()).isEmpty();
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ?", tenant, root);
        var revoked = automation.listReadableSchedules(tenant, "operator", cursor, 2);
        assertThat(revoked.rows()).isEmpty();
        assertThat(revoked.hasMore()).isFalse();
        assertThat(automation.listReadableSchedules(tenant, "operator", null, 2).rows()).isEmpty();
    }

    @Test
    void schedulePagesMatchExactUnicodeCaseTrailingSpaceAndSentinelIdentities() {
        String scopedTenant = tenant + "-identity";
        List<String> tenants = List.of(scopedTenant, scopedTenant + ":", scopedTenant + "_",
                scopedTenant.toUpperCase(java.util.Locale.ROOT));
        List<String> roots = List.of("工作区", "工作区 ", "工作区!", "Workspace", "workspace");
        JdbcAutomationLedgerStore automation = new JdbcAutomationLedgerStore(jdbc);
        for (int tenantIndex = 0; tenantIndex < tenants.size(); tenantIndex++) {
            String ownerTenant = tenants.get(tenantIndex);
            String ownerSession = session + "-" + tenantIndex;
            seedSession(ownerTenant, ownerSession, "PUBLIC", "ACTIVE");
            for (int index = 0; index < roots.size(); index++) {
                String root = roots.get(index);
                String child = "子-" + root;
                seedWorkspace(ownerTenant, root, null);
                seedWorkspace(ownerTenant, child, root);
                seedSchedule(ownerTenant, ownerSession, root, "root-" + index, 1);
                seedSchedule(ownerTenant, ownerSession, child, "child-" + index, 2);
                grantWorkspace(ownerTenant, root, "reader-" + index);
            }
        }
        for (String ownerTenant : tenants) {
            for (int index = 0; index < roots.size(); index++) {
                var page = automation.listReadableSchedules(ownerTenant, "reader-" + index, null, 10);
                assertThat(page.rows()).extracting(JdbcAutomationLedgerStore.ScheduleRow::tenantId).containsOnly(ownerTenant);
                assertThat(page.rows()).extracting(JdbcAutomationLedgerStore.ScheduleRow::workspaceId)
                        .containsExactly("子-" + roots.get(index), roots.get(index));
                assertThat(page.hasMore()).isFalse();
            }
        }
    }

    @Test
    void schedulePagesFilterOwnerOnlySessionsBeforePagination() {
        seedWorkspace(tenant, "root", null);
        grantWorkspace(tenant, "root", "operator");
        List<String> sessions = List.of(session, session + "-mine", session + "-hidden");
        for (int index = 0; index < sessions.size(); index++) {
            String ownerSession = sessions.get(index);
            seedSession(tenant, ownerSession, "PUBLIC", "ACTIVE");
            seedSchedule(tenant, ownerSession, "root", "schedule-" + index, index + 1);
            if (index > 0) {
                jdbc.update("UPDATE ma_session SET owner_only = 1, owner_actor_key = ?, creator_actor_key = ?"
                                + " WHERE tenant_id = ? AND session_id = ?",
                        ManagedWorkspaceRegistry.actorKey(tenant, index == 1 ? "operator" : "other"),
                        ManagedWorkspaceRegistry.actorKey(tenant, index == 1 ? "other" : "operator"),
                        tenant, ownerSession);
            }
        }
        JdbcAutomationLedgerStore automation = new JdbcAutomationLedgerStore(jdbc);
        var first = automation.listReadableSchedules(tenant, "operator", null, 1);
        assertThat(first.rows()).extracting(JdbcAutomationLedgerStore.ScheduleRow::sessionId).containsExactly(session + "-mine");
        assertThat(first.hasMore()).isTrue();
        var second = automation.listReadableSchedules(tenant, "operator", new JdbcAutomationLedgerStore.ScheduleCursor(2, "schedule-1"), 1);
        assertThat(second.rows()).extracting(JdbcAutomationLedgerStore.ScheduleRow::sessionId).containsExactly(session);
        assertThat(second.hasMore()).isFalse();
    }

    @Test
    void channelPendingSessionsDeduplicateBindingsBeforeGlobalOrdering() {
        String first = session + "-z";
        String second = session + "-a";
        String third = session + "-b";
        for (String ownerSession : List.of(second, third, first)) {
            seedSession(tenant, ownerSession, "PUBLIC", "ACTIVE");
            for (int binding = 0; binding < 6; binding++) {
                seedChannelBinding(tenant, "channel", ownerSession, ownerSession + "-" + binding, 1);
            }
            seedChannelRecord(tenant, ownerSession, "newer", "channel_delivery", "planned", 90);
            seedChannelRecord(tenant, ownerSession, "oldest", "channel_delivery",
                    ownerSession.equals(first) ? "partial" : "planned", ownerSession.equals(first) ? 10 : 20);
        }
        for (int index = 0; index < 8; index++) {
            String idle = session + "-idle-" + index;
            seedSession(tenant, idle, "PUBLIC", "ACTIVE");
            seedChannelBinding(tenant, "channel", idle, "new-binding-" + index, 1000 + index);
            seedChannelRecord(tenant, idle, "done", "channel_delivery", "delivered", 0);
        }
        String unbound = session + "-unbound";
        seedSession(tenant, unbound, "PUBLIC", "ACTIVE");
        for (int index = 0; index < 32; index++) {
            seedChannelRecord(tenant, first, "done-" + index, "channel_delivery", "delivered", 0);
            seedChannelRecord(tenant, unbound, "unbound-" + index, "channel_delivery", "planned", 0);
        }
        String otherOnly = session + "-other-channel";
        seedSession(tenant, otherOnly, "PUBLIC", "ACTIVE");
        seedChannelRecord(tenant, otherOnly, "other", "channel_delivery", "planned", 5);
        seedChannelBinding(tenant, "other-channel", otherOnly, "only-other", 1);
        seedChannelBinding(tenant, "other-channel", first, "shared-1", 1);
        seedChannelBinding(tenant, "other-channel", first, "shared-2", 1);
        JdbcChannelInstanceStore channels = new JdbcChannelInstanceStore(jdbc);
        assertThat(channels.listSessionsWithPendingDeliveries(tenant, "channel", 1)).containsExactly(first);
        assertThat(channels.listSessionsWithPendingDeliveries(tenant, "channel", 2)).containsExactly(first, second);
        assertThat(channels.listSessionsWithPendingDeliveries(tenant, "channel", 10)).containsExactly(first, second, third);
        assertThat(channels.listSessionsWithPendingDeliveries(tenant, "other-channel", 10)).containsExactly(otherOnly, first);
    }

    @Test
    void channelPendingSessionsRequireTheirOwnTenantActivePublicSessionAndDeliveryKind() {
        String earlier = session + "-earlier";
        for (String ownerSession : List.of(session, earlier)) {
            seedSession(tenant, ownerSession, "PUBLIC", "ACTIVE");
            seedChannelBinding(tenant, "channel", ownerSession, ownerSession, 1);
            seedChannelRecord(tenant, ownerSession, "due", "channel_delivery", "planned",
                    ownerSession.equals(earlier) ? 30 : 50);
        }
        for (String excluded : List.of("closed", "control", "delivered", "other-domain", "action", "missing")) {
            String ownerSession = session + "-" + excluded;
            if (!excluded.equals("missing")) {
                seedSession(tenant, ownerSession, excluded.equals("control") ? "CONTROL" : "PUBLIC",
                        excluded.equals("closed") ? "CLOSED" : "ACTIVE");
            }
            seedChannelBinding(tenant, "channel", ownerSession, excluded, 1);
            seedChannelRecord(tenant, ownerSession, "excluded",
                    excluded.equals("other-domain") ? "session_message" : "channel_delivery",
                    excluded.equals("delivered") ? "delivered" : "planned", 0);
            if (excluded.equals("action")) {
                jdbc.update("UPDATE ma_session_record SET record_kind = 'ACTION', action_id = 'action',"
                                + " action_version = 1, options_json = '{}' WHERE tenant_id = ? AND session_id = ?",
                        tenant, ownerSession);
            }
        }
        String foreignTenant = tenant + " ";
        seedSession(foreignTenant, session, "CONTROL", "ACTIVE");
        seedChannelBinding(foreignTenant, "channel", session, "same-session", 1);
        seedChannelRecord(foreignTenant, session, "due", "channel_delivery", "planned", 0);
        String foreignSession = session + "-foreign";
        seedSession(foreignTenant, foreignSession, "PUBLIC", "ACTIVE");
        seedChannelBinding(foreignTenant, "channel", foreignSession, "foreign", 1);
        seedChannelRecord(foreignTenant, foreignSession, "due", "channel_delivery", "planned", 5);
        seedChannelBinding(tenant, "channel", foreignSession, "foreign-session", 1);
        seedChannelBinding(foreignTenant, "channel", earlier, "foreign-binding", 1);
        JdbcChannelInstanceStore channels = new JdbcChannelInstanceStore(jdbc);
        assertThat(channels.listSessionsWithPendingDeliveries(tenant, "channel", 1)).containsExactly(earlier);
        assertThat(channels.listSessionsWithPendingDeliveries(tenant, "channel", 10)).containsExactly(earlier, session);
        assertThat(channels.listSessionsWithPendingDeliveries(foreignTenant, "channel", 10)).containsExactly(foreignSession);
    }

    private void seedChannelBinding(String ownerTenant, String channel, String ownerSession, String route, long time) {
        jdbc.update("INSERT INTO ma_channel_binding (tenant_id, channel_id, route_id, session_id,"
                        + " scope_kind, gmt_create) VALUES (?, ?, ?, ?, 'sender', ?)",
                ownerTenant, channel, route, ownerSession, time);
    }

    private void seedChannelRecord(String ownerTenant, String ownerSession, String id, String domain, String state, long time) {
        jdbc.update("INSERT INTO ma_session_record (record_key, tenant_id, workspace_id,"
                        + " session_id, record_kind, domain, record_id, revision, record_resource_id,"
                        + " delivery_state, gmt_create) VALUES (?, ?, 'workspace', ?, 'DOMAIN', ?, ?, 1, 'body', ?, ?)",
                ManagedExtensionProjection.recordKey(ownerSession, domain, id), ownerTenant, ownerSession, domain, id, state, time);
    }

    private void seedWorkspace(String ownerTenant, String workspace, String parent) {
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state, workspace_kind,"
                        + " parent_workspace_id) VALUES (?, ?, 1, 'storage', 'Workspace', 'config',"
                        + " 'policy', 'ACTIVE', ?, ?)",
                ownerTenant, workspace, parent == null ? "ROOT" : "CHILD_GIT", parent);
    }

    private void grantWorkspace(String ownerTenant, String workspace, String actor) {
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'READER')",
                ownerTenant, workspace, ManagedWorkspaceRegistry.actorKey(ownerTenant, actor));
    }

    private void seedSchedule(String ownerTenant, String ownerSession, String workspace, String id, long time) {
        jdbc.update("INSERT INTO ma_schedule (tenant_id, schedule_id, session_id, workspace_id, actor_id,"
                        + " record_revision, definition_revision, definition_digest, goal, cron, timezone,"
                        + " session_mode, overlap, catch_up, is_enabled, state, armed_at, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, ?, 1, 1, ?, 'goal', '0 * * * *', 'UTC', 'new_session',"
                        + " 'skip', 'none', TRUE, 'armed', 0, ?, ?)",
                ownerTenant, id, ownerSession, workspace, ManagedWorkspaceRegistry.actorKey(ownerTenant, "operator"),
                "a".repeat(64), time, time);
    }

    private void seedSession(String ownerTenant, String ownerSession, String kind, String status) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, session_kind, status,"
                        + " tenant_key, session_key, session_scope_key, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'qwen-code', ?, ?, ?, ?, ?, 1, 1)",
                ownerTenant, ownerSession, kind, status, ManagedSchemaKeys.key(ownerTenant),
                ManagedSchemaKeys.key(ownerSession), ManagedSessionStore.sessionScopeKey(ownerTenant, ownerSession));
    }

    @Test
    void lostPutReplyReconcilesOnlyTheOriginalIdentityAndNeverWritesAgain() {
        var retention = new ToolPublicationRetentionStore(jdbc, manager);
        JsonNode key = seedCapture();
        String scope = ToolPublicationDataStore.scope(key);
        byte[] expected = "original".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var writes = new java.util.concurrent.atomic.AtomicInteger();
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        var body = new java.util.concurrent.atomic.AtomicReference<byte[]>();
        var staleProof = new java.util.concurrent.atomic.AtomicBoolean();
        ToolPublicationObjectStore objects = new ToolPublicationObjectStore() {
            @Override
            public InputStream openRange(String key, long offset, long length, Runnable guard) {
                guard.run();
                try (InputStream full = open(key)) {
                    byte[] bytes = full.readAllBytes();
                    return new java.io.ByteArrayInputStream(bytes, (int) offset, (int) length);
                } catch (java.io.IOException error) {
                    throw new IllegalStateException(error);
                }
            }
            @Override public void putIfAbsent(String object, byte[] bytes) {
                assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                writes.incrementAndGet();
                body.set(bytes.clone());
                throw new IllegalStateException("reply lost");
            }
            @Override public InputStream open(String object) {
                assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                assertThat(object).isEqualTo("original-key");
                reads.incrementAndGet();
                if (staleProof.getAndSet(false)) {
                    jdbc.update(
                                    "UPDATE ma_operation SET claim_generation = claim_generation +"
                                            + " 1 WHERE tenant_id = ? AND operation_kind ="
                                            + " 'OBJECT_PUT'", tenant);
                }
                return new java.io.ByteArrayInputStream(body.get());
            }
            @Override public void validateConfiguration() { }
        };
        assertThatThrownBy(() -> retention.put(key, scope, "capture", "original-key", expected, objects)).hasMessageContaining("reply lost");
        body.set(new byte[] {1});
        assertThatThrownBy(() -> retention.put(key, scope, "capture", "original-key", expected, objects)).hasMessageContaining("unresolved");
        body.set(expected);
        staleProof.set(true);
        assertThatThrownBy(() -> retention.put(key, scope, "capture", "original-key", expected, objects)).hasMessageContaining("unresolved");
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE tenant_id = ? AND"
                                        + " operation_kind = 'OBJECT_PUT'",
                String.class, tenant)).isEqualTo("UNKNOWN");
        retention.put(key, scope, "capture", "original-key", expected, objects);
        retention.put(key, scope, "capture", "original-key", expected, objects);
        assertThat(writes).hasValue(1);
        assertThat(reads).hasValue(3);
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE tenant_id = ? AND"
                                        + " operation_kind = 'OBJECT_PUT'",
                String.class, tenant)).isEqualTo("RETURNED");
        assertThat(jdbc.queryForObject(
                                "SELECT result_json FROM ma_operation WHERE tenant_id = ? AND"
                                        + " operation_kind = 'OBJECT_PUT'",
                String.class, tenant)).contains("original_object");
    }

    private JsonNode seedCapture() {
        var key = new ObjectMapper().createObjectNode().put("tenantId", tenant).put("workspaceId", "workspace").put("sessionId", session);
        String scope = ToolPublicationDataStore.scope(key);
        String hash = ManagedSchemaKeys.key("capture");
        jdbc.update(
                "INSERT INTO ma_output_capture (scope_key, tenant_id, workspace_id,"
                    + " session_id, publication_id, execution_key, capture_id, binding_json,"
                    + " binding_digest, token_hash, state, capture_bytes, producer_bytes,"
                    + " admission_bytes, producer_phase, is_write_evidence, is_accepted_complete) VALUES"
                    + " (?, ?, 'workspace', ?, 'capture', ?, 'capture-id', '{}', ?, ?, 'FENCED',"
                    + " 1000, 1000, 1000, 'REFERENCED', TRUE, TRUE)",
                scope, tenant, session, hash, hash, hash);
        return key;
    }
}
