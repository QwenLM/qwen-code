package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore.PendingChild;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore.RelayRow;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:child-result-relay;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ChildResultRelayStoreTest {
    private static final String TENANT = "tenant-relay";

    @Autowired
    private ChildResultRelayStore relayStore;

    @Autowired
    private AgentStateStore state;

    @Autowired
    private JdbcTemplate jdbc;

    private String boundParent() {
        jdbc.update("INSERT IGNORE INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES ('" + TENANT + "', 'workspace', 1,"
                        + " 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT IGNORE INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES ('" + TENANT + "', 'workspace', ?, TRUE,"
                        + " TRUE)",
                "owner".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return state.insertWorkspaceSessionCommand(TENANT, "owner",
                UUID.randomUUID().toString(), "digest", "qwen-code", null,
                null, List.of(), null,
                new WorkspaceSelection("workspace", ".")).sessionId();
    }

    @Test
    void stampsAndReadsChildLineageWithIdempotentCreation() {
        String parent = boundParent();
        // A root Session answers no lineage without an exception.
        assertThat(state.findChildLineage(TENANT, parent)).isNull();
        StoreModels.SessionLineage lineage = new StoreModels.SessionLineage(
                parent, parent, "run-1", 1);
        // This context runs without Hosted Workspace files, so the
        // lineage case passes no launch input; the turn chain is the
        // create pipeline's own, already covered elsewhere.
        List<Map<String, Object>> input = List.of();
        String digest = "child-digest";
        String creationKey = key(parent, "run-1");
        StoreModels.Admission first = state.insertChildSessionCommand(TENANT,
                parent, creationKey, digest, "audit", input, null, lineage);
        assertThat(first.replayed()).isFalse();
        assertThat(state.findChildLineage(TENANT, first.sessionId()))
                .isEqualTo(lineage);
        assertThat(jdbc.query("SELECT session_id FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " ORDER BY created_at, session_id",
                (result, row) -> result.getString("session_id"), TENANT,
                parent)).containsExactly(first.sessionId());
        StoreModels.SessionRecord child = state.requireSession(TENANT,
                first.sessionId());
        StoreModels.SessionRecord parentRow = state.requireSession(TENANT,
                parent);
        assertThat(child.workspace().getWorkspaceId())
                .isEqualTo(parentRow.workspace().getWorkspaceId());
        assertThat(child.toolProfile()).isEqualTo(parentRow.toolProfile());
        // The derived key replays the original admission.
        StoreModels.Admission replayed = state.insertChildSessionCommand(
                TENANT, parent, creationKey, digest, "audit", input, null,
                lineage);
        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.sessionId()).isEqualTo(first.sessionId());
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?",
                Integer.class, TENANT, parent)).isEqualTo(1);
        assertThatThrownBy(() -> state.insertChildSessionCommand(TENANT,
                parent, creationKey, "other-digest", "audit", input, null,
                lineage))
                .isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(
                        ((ApiException) error).getCode())
                        .isEqualTo("idempotency_conflict"));
        assertThat(creationKey).matches("^[0-9a-f]{64}$");
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?",
                Integer.class, TENANT, parent)).isEqualTo(1);
    }

    private static String key(String parent, String childRunId) {
        try {
            var sha = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hashed = sha.digest((parent + '\u0000' + "child_run"
                    + '\u0000' + childRunId)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            var out = new StringBuilder(64);
            for (byte value : hashed) {
                out.append(Character.forDigit((value >> 4) & 0xf, 16));
                out.append(Character.forDigit(value & 0xf, 16));
            }
            return out.toString();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    @Test
    void refusesCreationOnAClosedParent() {
        String parent = boundParent();
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSING'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, parent);
        assertThatThrownBy(() -> state.insertChildSessionCommand(TENANT,
                parent, "key-1", "digest", "audit", List.of(), null,
                new StoreModels.SessionLineage(parent, parent, "run-1", 1)))
                .isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(
                        ((ApiException) error).getCode())
                        .isEqualTo("child_parent_unavailable"));
    }

    @Test
    void selectsOnlyRelayRelevantRowsFromTheDiscoveryIndex() {
        String session = UUID.randomUUID().toString();
        String scopeKey = "scope-x";
        insertRecordRow(scopeKey, session, "run-live", "child_agent",
                "planned", "pending");
        insertRecordRow(scopeKey, session, "run-settled", "child_agent",
                "accepted", "completed");
        insertRecordRow(scopeKey, session, "shell-x", "shell", null,
                "running");
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1,"
                        + " 1)",
                TENANT, session);
        List<PendingChild> pending = relayStore.findPendingChildren(10);
        assertThat(pending).extracting(PendingChild::childRunId)
                .containsExactly("run-live");
        // Every column the relay binds to is selected and mapped (the
        // discovery claim's projected shape).
        assertThat(pending.get(0)).satisfies(row -> {
            assertThat(row.tenantId()).isEqualTo(TENANT);
            assertThat(row.parentSessionId()).isEqualTo(session);
            assertThat(row.childRunId()).isEqualTo("run-live");
            assertThat(row.revision()).isEqualTo(1L);
            assertThat(row.deliveryState()).isEqualTo("planned");
            assertThat(row.recordResourceId()).isEqualTo("resource-run-live");
        });
        assertThat(relayStore.findLiveScopes(TENANT, session))
                .extracting(ChildResultRelayStore.LiveScope::childRunId)
                .containsExactly("run-live");
        // A live ledger claim leaves the run discoverable; a terminal
        // classification retires it even though the extension record
        // still sits delivery-pending.
        RelayRow claimed = relayStore.claim(TENANT, session, "run-live",
                "key-live", "owner", 30_000, 100);
        assertThat(claimed).isNotNull();
        assertThat(relayStore.findPendingChildren(10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-live");
        relayStore.classify(claimed, "owner", "done", null, 200);
        assertThat(relayStore.findPendingChildren(10)).isEmpty();
        // A record the consumer already advanced owes the delivering
        // ledger its owed step: it surfaces, until classify retires it.
        jdbc.update("UPDATE qwen_managed_session_extension_record SET"
                        + " delivery_state = 'consumed'"
                        + " WHERE tenant_id = ? AND record_id = 'run-settled'",
                TENANT);
        RelayRow delivering = relayStore.claim(TENANT, session, "run-settled",
                "key-settled", "owner", 30_000, 400);
        assertThat(delivering).isNotNull();
        relayStore.advance(delivering, "owner", "delivering", null, 0, null,
                30_000, 400);
        assertThat(relayStore.findPendingChildren(10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-settled");
        relayStore.classify(relayStore.find(TENANT, session, "run-settled"),
                "owner", "done", null, 500);
        assertThat(relayStore.findPendingChildren(10)).isEmpty();
        // A parked backoff row and a lease-ahead row stay out of the
        // bounded window; each resurfaces exactly when owed.
        RelayRow parked = relayStore.claim(TENANT, session, "run-parked",
                "key-parked", "owner", 30_000, 100);
        insertRecordRow("scope-x", session, "run-parked", "child_agent",
                "planned", "pending");
        relayStore.defer(parked, "owner",
                System.currentTimeMillis() + 60_000, "flap", 30_000, 100);
        assertThat(relayStore.findPendingChildren(10)).isEmpty();
        RelayRow leased = relayStore.claim(TENANT, session, "run-leased",
                "key-leased", "owner",
                System.currentTimeMillis() + 60_000, 100);
        insertRecordRow("scope-x", session, "run-leased", "child_agent",
                "planned", "pending");
        assertThat(relayStore.findPendingChildren(10)).isEmpty();
        relayStore.classify(leased, "owner", "done", null, 100);
        // And classify respects the claimant: a stale writer mutates nothing.
        RelayRow guarded = relayStore.claim(TENANT, session, "run-guarded",
                "key-guarded", "owner-a", 30_000, 100);
        relayStore.classify(guarded, "owner-b", "orphaned", "fake", 100);
        assertThat(relayStore.find(TENANT, session, "run-guarded").state())
                .isEqualTo("creating");
        assertThat(relayStore.find(TENANT, session, "run-guarded")
                .claimedBy()).isEqualTo("owner-a");
    }

    private void insertRecordRow(String scopeKey, String sessionId,
            String recordId, String kind, String deliveryState,
            String taskState) {
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, created_at)"
                        + " VALUES (?, ?, ?, 'workspace', ?, 'child_run', ?,"
                        + " 'h', 1, ?, ?, ?, ?, ?, 1)",
                scopeKey, recordId + "-key", TENANT, sessionId, recordId,
                "resource-" + recordId,
                "background_shell".equals(taskState) ? "background_shell"
                        : "child_agent", taskState,
                deliveryState == null ? null : "session",
                deliveryState);
    }

    @Test
    void claimsAdvancesDefersAndClassifiesLedgerRows() {
        long now = 1_000L;
        RelayRow claimed = relayStore.claim(TENANT, "parent-x", "run-x",
                "key-x", "owner-a", now + 30_000, now);
        assertThat(claimed).isNotNull();
        assertThat(claimed.state()).isEqualTo("creating");
        // A second claimant under a live lease waits.
        assertThat(relayStore.claim(TENANT, "parent-x", "run-x", "key-x",
                "owner-b", now + 30_000, now)).isNull();
        claimed = relayStore.claim(TENANT, "parent-x", "run-x", "key-x",
                "owner-a", now + 30_000, now);
        relayStore.advance(claimed, "owner-a", "watching", "child-1", 0, null,
                now + 30_000, now);
        claimed = relayStore.find(TENANT, "parent-x", "run-x");
        assertThat(claimed.state()).isEqualTo("watching");
        assertThat(claimed.childSessionId()).isEqualTo("child-1");
        relayStore.defer(claimed, "owner-a", now + 5_000, "flap",
                now + 30_000, now);
        claimed = relayStore.find(TENANT, "parent-x", "run-x");
        assertThat(claimed.attempts()).isEqualTo(1);
        assertThat(claimed.nextRetryAt()).isEqualTo(now + 5_000);
        relayStore.classify(claimed, "owner-a", "orphaned",
                "parent session is CLOSING", now);
        RelayRow orphaned = relayStore.find(TENANT, "parent-x", "run-x");
        assertThat(orphaned.state()).isEqualTo("orphaned");
        assertThat(orphaned.claimedBy()).isNull();
        // An expired lease yields to another worker.
        RelayRow expired = relayStore.claim(TENANT, "parent-x", "run-y",
                "key-y", "owner-a", now + 1_000, now);
        assertThat(expired).isNotNull();
        RelayRow taken = relayStore.claim(TENANT, "parent-x", "run-y",
                "key-y", "owner-b", now + 30_000, now + 2_000);
        assertThat(taken).isNotNull();
        assertThat(taken.claimedBy()).isEqualTo("owner-b");
    }

    @Test
    void readsInlineResourcesOnly() {
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, created_at)"
                        + " VALUES ('scope', ?, 'workspace', 'session',"
                        + " 'res-1', 'managed-input', 1, 2, '" + "a".repeat(64)
                        + "', 'MYSQL_INLINE', ?, 'command', 'REFERENCED',"
                        + " CURRENT_TIMESTAMP)",
                TENANT, "xy".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(relayStore.readResource(TENANT, "res-1")).isEqualTo("xy");
        assertThat(relayStore.readResource(TENANT, "res-2")).isNull();
    }

    @Test
    void readsTheTurnLineAndTerminalResult() {
        String session = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1,"
                        + " 1)",
                TENANT, session);
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, submission_attempted, created_at,"
                        + " updated_at, completed_at, version)"
                        + " VALUES (?, ?, 'turn-1', 'prompt-1', '[]', 'd',"
                        + " 'COMPLETED', TRUE, 1, 2, 2, 1)", TENANT, session);
        ChildResultRelayStore.TurnLine turn = relayStore.latestTurn(TENANT,
                session);
        assertThat(turn.status()).isEqualTo("COMPLETED");
        jdbc.update("INSERT INTO managed_agent_item (tenant_id, session_id,"
                        + " item_id, turn_id, item_type, item_role,"
                        + " item_status, attributes_json, first_sequence,"
                        + " last_sequence, created_at, updated_at, revision)"
                        + " VALUES (?, ?, 'item-1', 'turn-1', 'message',"
                        + " 'assistant', 'completed', '{}', 1, 3, 1, 1, 1)",
                TENANT, session);
        jdbc.update("INSERT INTO managed_agent_item_part (tenant_id,"
                        + " session_id, item_id, part_id, part_type,"
                        + " part_text, first_sequence, last_sequence,"
                        + " created_at, updated_at, revision)"
                        + " VALUES (?, ?, 'item-1', 'part-1', 'output_text',"
                        + " '审阅通过', 2, 2, 1, 1, 1)",
                TENANT, session);
        assertThat(relayStore.terminalResultText(TENANT, session, "turn-1"))
                .isEqualTo("审阅通过");
    }
}
