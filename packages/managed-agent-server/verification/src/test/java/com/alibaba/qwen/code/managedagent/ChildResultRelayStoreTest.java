package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore.PendingChild;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore.RelayRow;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
    private JdbcChildResultRelayStore relayStore;

    @Autowired
    private AgentStateStore state;

    @Autowired
    @Qualifier("managedJdbcTemplate")
    private JdbcTemplate jdbc;

    @org.junit.jupiter.api.BeforeEach
    void clearRelayRecords() {
        jdbc.update("DELETE FROM ma_session_record WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM ma_operation WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM ma_delivery WHERE tenant_id = ?", TENANT);
    }

    private String boundParent() {
        jdbc.update("INSERT IGNORE INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES ('" + TENANT + "', 'workspace', 1,"
                        + " 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT IGNORE INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES ('" + TENANT + "', 'workspace', ?,"
                        + " 'OPERATOR')",
                "owner".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return state.insertWorkspaceSessionCommand(SessionCreationCommand.builder()
                .tenantId(TENANT)
                .actorId("owner")
                .idempotencyKey(UUID.randomUUID().toString())
                .requestDigest("digest")
                .agentId("qwen-code")
                .selection(new WorkspaceSelection("workspace", "."))
                .build()).sessionId();
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
        assertThat(jdbc.query("SELECT session_id FROM ma_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " ORDER BY gmt_create, session_id",
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
                "SELECT COUNT(*) FROM ma_session"
                        + " WHERE tenant_id = ? AND parent_session_id = ?",
                Integer.class, TENANT, parent)).isEqualTo(1);
        assertThatThrownBy(() -> state.insertChildSessionCommand(TENANT,
                parent, creationKey, "other-digest", "audit", input, null,
                lineage))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error -> assertThat(
                        ((ManagedAgentException) error).getCode())
                        .isEqualTo("idempotency_conflict"));
        assertThat(creationKey).matches("^[0-9a-f]{64}$");
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_session"
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
        jdbc.update("UPDATE ma_session SET status = 'CLOSING'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, parent);
        assertThatThrownBy(() -> state.insertChildSessionCommand(TENANT,
                parent, "key-1", "digest", "audit", List.of(), null,
                new StoreModels.SessionLineage(parent, parent, "run-1", 1)))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error -> assertThat(
                        ((ManagedAgentException) error).getCode())
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
        // #13803 (K2): the runtime exists now — the relay's discovery page
        // and the cascade's live-scope query return workflow rows beside
        // child_agent rows; the shell kind still has no delivery to drive.
        insertRecordRow(scopeKey, session, "workflow-live", "workflow",
                "planned", "pending");
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, status, gmt_create,"
                        + " gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1,"
                        + " 1)",
                TENANT, session);
        List<PendingChild> pending = relayStore.findPendingChildren("probe", 10);
        assertThat(pending).extracting(PendingChild::childRunId)
                .containsExactly("run-live", "workflow-live");
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
                .extracting(JdbcChildResultRelayStore.LiveScope::childRunId)
                .containsExactly("run-live", "workflow-live");
        // A live ledger claim leaves its own run discoverable beside the
        // still-unclaimed workflow row; a terminal classification retires
        // the claimed run even though its extension record still sits
        // delivery-pending.
        RelayRow claimed = relayStore.claim(TENANT, session, "run-live",
                "key-live", "owner", 30_000, 100);
        assertThat(claimed).isNotNull();
        assertThat(relayStore.findPendingChildren("probe", 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-live", "workflow-live");
        relayStore.classify(claimed, "owner", "done", null, 200);
        assertThat(relayStore.findPendingChildren("probe", 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("workflow-live");
        // A record the consumer already advanced owes the delivering
        // ledger its owed step: it surfaces, until classify retires it.
        jdbc.update("UPDATE ma_session_record SET"
                        + " delivery_state = 'consumed'"
                        + " WHERE tenant_id = ? AND record_id = X'72756e2d736574746c6564'",
                TENANT);
        RelayRow delivering = relayStore.claim(TENANT, session, "run-settled",
                "key-settled", "owner", 30_000, 400);
        assertThat(delivering).isNotNull();
        relayStore.advance(delivering, "owner", "delivering", null, 0, null,
                30_000, 400);
        assertThat(relayStore.findPendingChildren("probe", 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-settled", "workflow-live");
        relayStore.classify(relayStore.find(TENANT, session, "run-settled"),
                "owner", "done", null, 500);
        assertThat(relayStore.findPendingChildren("probe", 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("workflow-live");
        // A parked backoff row and a lease-ahead row stay out of the
        // bounded window; each resurfaces exactly when owed.
        RelayRow parked = relayStore.claim(TENANT, session, "run-parked",
                "key-parked", "owner", 30_000, 100);
        insertRecordRow("scope-x", session, "run-parked", "child_agent",
                "planned", "pending");
        relayStore.defer(parked, "owner",
                System.currentTimeMillis() + 60_000, "flap", 30_000, 100);
        assertThat(relayStore.findPendingChildren("probe", 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("workflow-live");
        RelayRow leased = relayStore.claim(TENANT, session, "run-leased",
                "key-leased", "owner",
                System.currentTimeMillis() + 60_000, 100);
        insertRecordRow("scope-x", session, "run-leased", "child_agent",
                "planned", "pending");
        assertThat(relayStore.findPendingChildren("probe", 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("workflow-live");
        // ...but the claimant itself always sees its own live claim.
        assertThat(relayStore.findPendingChildren("owner", 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-leased", "workflow-live");
        relayStore.classify(leased, "owner", "done", null, 100);
        // Tidy the fixture row the runtime now discovers: retire it like
        // every other row of this class, so no other probe sees it.
        relayStore.classify(relayStore.claim(TENANT, session,
                "workflow-live", "key-workflow-live", "owner", 30_000, 100),
                "owner", "done", null, 100);
        assertThat(relayStore.findPendingChildren("probe", 10)).isEmpty();
        // And classify respects the claimant: a stale writer mutates nothing.
        RelayRow guarded = relayStore.claim(TENANT, session, "run-guarded",
                "key-guarded", "owner-a", 30_000, 100);
        relayStore.classify(guarded, "owner-b", "orphaned", "fake", 100);
        assertThat(relayStore.find(TENANT, session, "run-guarded").state())
                .isEqualTo("creating");
        assertThat(relayStore.find(TENANT, session, "run-guarded")
                .claimedBy()).isEqualTo("owner-a");
    }

    // FG10b: classification may commit between the acceptance and the
    // parent's consuming revision, writing the mirror `pending`; the
    // consumption commit then corrects that row rather than leaving it
    // claiming the result was never consumed.
    @Test
    void correctsAClassifiedMirrorOnConsumption() {
        long now = 600_000L;
        String session = UUID.randomUUID().toString();
        insertRecordRow("scope-m", session, "run-m", "child_agent",
                "accepted", "pending");
        insertRecordRow("scope-m", session, "run-keep", "child_agent",
                "accepted", "pending");
        for (String run : List.of("run-m", "run-keep")) {
            relayStore.classify(relayStore.claim(TENANT, session, run,
                    "key-" + run, "owner", now + 30_000, now), "owner",
                    "done", null, now);
        }
        assertThat(deliveryRow(session, "run-m"))
                .isEqualTo("delivered/accepted/pending");
        relayStore.markConsumed(TENANT, session, "run-m", now + 1_000);
        assertThat(deliveryRow(session, "run-m"))
                .isEqualTo("delivered/accepted/consumed");
        assertThat(deliveryRow(session, "run-keep"))
                .as("another run's mirror is untouched")
                .isEqualTo("delivered/accepted/pending");
        // A consumption that commits before classification writes no row:
        // the later classification reads the record and mirrors it.
        relayStore.markConsumed(TENANT, session, "run-absent", now + 1_000);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_delivery"
                        + " WHERE tenant_id = ? AND delivery_kind ="
                        + " 'CHILD_RESULT' AND delivery_id = ?", Integer.class,
                TENANT, "run-absent")).isZero();
    }

    private String deliveryRow(String session, String run) {
        return jdbc.queryForObject("SELECT CONCAT(transport_state, '/',"
                        + " reception_state, '/', consumption_state) FROM"
                        + " ma_delivery WHERE tenant_id = ? AND delivery_kind ="
                        + " 'CHILD_RESULT' AND source_scope_key = ? AND"
                        + " delivery_id = ?", String.class, TENANT,
                ManagedSessionStore
                        .sessionScopeKey(TENANT, session), run);
    }

    private void insertRecordRow(String scopeKey, String sessionId,
            String recordId, String kind, String deliveryState,
            String taskState) {
        insertRecordRow(scopeKey, sessionId, recordId, kind, deliveryState,
                taskState, 1);
    }

    private void insertRecordRow(String scopeKey, String sessionId,
            String recordId, String kind, String deliveryState,
            String taskState, long createdAt) {
        jdbc.update("INSERT INTO ma_session_record"
                        + " (record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, gmt_create)"
                        + " VALUES (?, ?, 'workspace', ?, 'child_run', ?,"
                        + " 'h', 1, ?, ?, ?, ?, ?, ?)",
                com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection.recordKey(sessionId, "child_run", recordId),
                TENANT, sessionId, recordId,
                "resource-" + recordId,
                "shell".equals(kind) ? "background_shell" : kind, taskState,
                deliveryState == null ? null : "session",
                deliveryState, createdAt);
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

    // R4-2: the accepted/consumed arm obeys the same due/lease
    // eligibility as the launch arm — a backed-off or foreign-leased
    // watching row must not squat a slot ahead of a newer due launch.
    @Test
    void appliesEligibilityToTheAcceptedArmToo() {
        long now = 200_000L;
        String session = UUID.randomUUID().toString();
        insertRecordRow("scope-z", session, "run-accepted-backed-off",
                "child_agent", "accepted", "pending");
        insertRecordRow("scope-z", session, "run-accepted-leased",
                "child_agent", "accepted", "pending");
        insertRecordRow("scope-z", session, "run-due", "child_agent",
                "planned", "pending");
        RelayRow backedOff = relayStore.claim(TENANT, session,
                "run-accepted-backed-off", "key-b", "owner", now + 30_000,
                now);
        relayStore.advance(backedOff, "owner", "watching", "child-b", 0,
                null, now + 30_000, now);
        relayStore.defer(relayStore.find(TENANT, session,
                "run-accepted-backed-off"), "owner", now + 300_000, "flap",
                now + 30_000, now);
        RelayRow foreign = relayStore.claim(TENANT, session,
                "run-accepted-leased", "key-l", "foreign-owner",
                now + 60_000, now);
        relayStore.advance(foreign, "foreign-owner", "watching", "child-l",
                0, null, now + 60_000, now);
        assertThat(relayStore.findPendingChildren("owner", now + 1_000, 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-due");
        // Retire the fixture rows: the discovery page is fleet-wide, so a
        // leftover would leak into this class's other probes.
        relayStore.classify(relayStore.find(TENANT, session,
                "run-accepted-backed-off"), "owner", "done", null,
                now + 2_000);
        relayStore.classify(relayStore.find(TENANT, session,
                "run-accepted-leased"), "foreign-owner", "done", null,
                now + 2_000);
        relayStore.classify(relayStore.claim(TENANT, session, "run-due",
                "key-due", "owner", now + 30_000, now + 1_000), "owner",
                "done", null, now + 2_000);
    }

    // R4-4: claim() lets the current owner continue immediately, so the
    // page must not hide a due row behind its own live lease — that is
    // what the five-second heartbeat paces against.
    @Test
    void hidesLiveClaimsFromOtherWorkersButNotTheirOwner() {
        long now = 100_000L;
        String session = UUID.randomUUID().toString();
        insertRecordRow("scope-y", session, "run-owned", "child_agent",
                "planned", "pending");
        RelayRow row = relayStore.claim(TENANT, session, "run-owned",
                "key-owned", "owner", now + 30_000, now);
        relayStore.advance(row, "owner", "watching", "child-1",
                now + 5_000, null, now + 30_000, now);
        // Due at +5s: visible to the claimant, hidden from everyone else.
        assertThat(relayStore.findPendingChildren("owner", now + 5_000, 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-owned");
        assertThat(relayStore.findPendingChildren("stranger", now + 5_000,
                10)).isEmpty();
        // Lease expiry admits the rest of the fleet.
        assertThat(relayStore.findPendingChildren("stranger", now + 30_000,
                10)).extracting(PendingChild::childRunId)
                .containsExactly("run-owned");
        relayStore.classify(relayStore.find(TENANT, session, "run-owned"),
                "owner", "done", null, now + 31_000);
    }

    // R4-3: the fail commit of a FAILED/CANCELLED Turn moves delivery to
    // `cancelled`; while the watching ledger still owes the close
    // admission, the row must stay discoverable until classify lands.
    @Test
    void keepsAFailedChildDiscoverableUntilCloseAdmits() {
        long now = 300_000L;
        String session = UUID.randomUUID().toString();
        insertRecordRow("scope-c", session, "run-cancelled", "child_agent",
                "cancelled", "failed");
        RelayRow row = relayStore.claim(TENANT, session, "run-cancelled",
                "key-cancelled", "owner", now + 30_000, now);
        relayStore.advance(row, "owner", "watching", "child-c", 0, null,
                now + 30_000, now);
        assertThat(relayStore.findPendingChildren("owner", now + 1_000, 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-cancelled");
        // A live lease still hides it from the rest of the fleet.
        assertThat(relayStore.findPendingChildren("stranger", now + 1_000,
                10)).isEmpty();
        relayStore.classify(relayStore.find(TENANT, session, "run-cancelled"),
                "owner", "done", null, now + 2_000);
        assertThat(relayStore.findPendingChildren("owner", now + 3_000, 10))
                .isEmpty();
    }

    // The capability-retained close debt rides the same cancelled arm:
    // the record settled (delivery `cancelled`), so the parked ledger
    // row is the only durable holder of the owed close admission, and
    // the discovery page is the only thing that can ever drive it again.
    @Test
    void keepsACloseDebtDiscoverableOnTheCancelledArm() {
        long now = 400_000L;
        String session = UUID.randomUUID().toString();
        insertRecordRow("scope-d", session, "run-debt", "child_agent",
                "cancelled", "failed");
        RelayRow row = relayStore.claim(TENANT, session, "run-debt",
                "key-debt", "owner", now + 30_000, now);
        relayStore.advance(row, "owner", "close_debt", "child-d",
                now + 1_000, "close debt retained", now + 30_000, now);
        assertThat(relayStore.findPendingChildren("owner", now + 1_000, 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-debt");
        // Terminal classifications drop it; the parked debt never is one.
        relayStore.classify(relayStore.find(TENANT, session, "run-debt"),
                "owner", "done", null, now + 2_000);
        assertThat(relayStore.findPendingChildren("owner", now + 3_000, 10))
                .isEmpty();
    }

    // #14165 FG10d: a close debt never rewrites the walk's classification.
    // A run whose outcome no witness survived (a recovery-blocked workflow,
    // a give-up) retires `unknown` on its walk and its delivery row even
    // where the host cannot close the child, exactly as when the close is
    // admitted at once; a proven result retires `done`/`delivered`. Either
    // way the owed close parks, discoverable, on its own row.
    @Test
    void retainsACloseDebtUnderTheWalksOwnClassification() {
        long now = 450_000L;
        String session = UUID.randomUUID().toString();
        for (String classification : List.of("unknown", "done")) {
            String run = "run-debt-" + classification;
            insertRecordRow("scope-g", session, run, "workflow", "planned",
                    "running");
            RelayRow row = relayStore.claim(TENANT, session, run,
                    "key-" + classification, "owner", now + 30_000, now);
            relayStore.retainCloseDebt(row, "owner", classification,
                    "child-g", now + 1_000, "close debt retained",
                    now + 30_000, now);
            assertThat(jdbc.queryForObject("SELECT state FROM ma_operation"
                    + " WHERE tenant_id = ? AND operation_id = ? AND"
                    + " operation_kind = 'CHILD_SESSION_START'", String.class,
                    TENANT, run)).isEqualTo(classification);
            assertThat(jdbc.queryForObject("SELECT CONCAT(transport_state,"
                    + " '/', reception_state, '/', consumption_state) FROM"
                    + " ma_delivery WHERE tenant_id = ? AND delivery_kind ="
                    + " 'CHILD_RESULT' AND delivery_id = ?", String.class,
                    TENANT, run)).isEqualTo(("done".equals(classification)
                            ? "delivered" : classification)
                            + "/pending/pending");
            RelayRow debt = relayStore.find(TENANT, session, run);
            assertThat(debt.operationKind()).isEqualTo("CHILD_SESSION_CLOSE");
            assertThat(debt.state()).isEqualTo("close_debt");
            assertThat(debt.childSessionId()).isEqualTo("child-g");
        }
        assertThat(relayStore.findPendingChildren("owner", now + 1_000, 10))
                .extracting(PendingChild::childRunId)
                .containsExactlyInAnyOrder("run-debt-unknown", "run-debt-done");
        RelayRow other = relayStore.claim(TENANT, session, "run-debt-orphan",
                "key-orphan", "owner", now + 30_000, now);
        assertThatThrownBy(() -> relayStore.retainCloseDebt(other, "owner",
                "orphaned", "child-g", now + 1_000, null, now + 30_000, now))
                .isInstanceOf(IllegalArgumentException.class);
        RelayRow owed = relayStore.find(TENANT, session, "run-debt-done");
        assertThatThrownBy(() -> relayStore.retainCloseDebt(owed, "owner",
                "done", "child-g", now + 1_000, null, now + 30_000, now))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // A give-up whose settle committed and whose close_debt write then
    // failed leaves delivery `cancelled` against a ledger still walking
    // the earliest arms (`binding`): narrower arm-2 state lists made
    // this combination permanently undiscoverable even before a parent
    // close, so no reconciliation could ever find it.
    @Test
    void keepsABindingRowDiscoverableAfterSettlement() {
        long now = 500_000L;
        String session = UUID.randomUUID().toString();
        insertRecordRow("scope-b", session, "run-binding", "child_agent",
                "cancelled", "failed");
        RelayRow row = relayStore.claim(TENANT, session, "run-binding",
                "key-binding", "owner", now + 30_000, now);
        relayStore.advance(row, "owner", "binding", "child-b", 0, null,
                now + 30_000, now);
        assertThat(relayStore.findPendingChildren("owner", now + 1_000, 10))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-binding");
        relayStore.classify(relayStore.find(TENANT, session, "run-binding"),
                "owner", "done", null, now + 2_000);
        assertThat(relayStore.findPendingChildren("owner", now + 3_000, 10))
                .isEmpty();
    }

    // Debts sort after every other due row: one accumulates per finished
    // child where close is unavailable, and ahead of the bounded page they
    // would keep a newer launch from ever being reached.
    @Test
    void sortsCloseDebtsAfterNewerDueWork() {
        long now = 600_000L;
        String session = UUID.randomUUID().toString();
        insertRecordRow("scope-f", session, "run-a-old-debt", "child_agent",
                "consumed", "completed");
        RelayRow row = relayStore.claim(TENANT, session, "run-a-old-debt",
                "key-a-old-debt", "owner", now + 30_000, now);
        relayStore.advance(row, "owner", "close_debt", "child-f",
                now + 1_000, "close debt retained", now + 30_000, now);
        insertRecordRow("scope-f", session, "run-z-new", "child_agent",
                "planned", "pending");
        assertThat(relayStore.findPendingChildren("owner", now + 1_000, 1))
                .extracting(PendingChild::childRunId)
                .containsExactly("run-z-new");
        // Retire the fixture rows: the discovery page is fleet-wide.
        relayStore.classify(relayStore.find(TENANT, session,
                "run-a-old-debt"), "owner", "done", null, now + 2_000);
        relayStore.classify(relayStore.claim(TENANT, session, "run-z-new",
                "key-z-new", "owner", now + 30_000, now + 1_000), "owner",
                "done", null, now + 2_000);
    }

    @ParameterizedTest
    @CsvSource({"7,7", "1,7", "7,1", "0,7", "7,0"})
    void takesTheGlobalTopNFromUnevenBranches(int starts, int debts) {
        String session = UUID.randomUUID().toString();
        List<PendingChild> expected = new ArrayList<>();
        for (int index = 0; index < starts; index++) {
            String run = "start-" + index;
            insertRecordRow("scope-top", session, run, "child_agent",
                    "planned", "pending", 10_000 + index);
            expected.add(new PendingChild(TENANT, session, run, 1,
                    "planned", "resource-" + run));
        }
        for (int index = 0; index < debts; index++) {
            String run = "debt-" + index;
            retainDiscoveryCloseDebt(session, run, "owner", 100 + index, 0);
            expected.add(new PendingChild(TENANT, session, run, 0,
                    "accepted", null));
        }
        assertThat(relayStore.findPendingChildren("owner", 1_000_000, 4))
                .containsExactlyElementsOf(expected.subList(0, 4));
        assertThat(relayStore.findPendingChildren("owner", 1_000_000, 0))
                .isEmpty();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void ordersEachBranchByCreationSessionAndRunAtTheLimit(boolean debt) {
        List<String> sessions = List.of("parent-b", "parent-a", "parent-a", "parent-a", "parent-z");
        List<String> runs = List.of("run-a", "run-c", "run-b", "run-a", "run-old");
        List<PendingChild> inserted = new ArrayList<>();
        for (int index = 0; index < runs.size(); index++) {
            String session = sessions.get(index);
            String run = runs.get(index);
            long createdAt = index == 4 ? 9 : 10;
            // Debt ordering belongs to the operation, not its optional record.
            insertRecordRow("scope-tie", session, run, "workflow",
                    "planned", "pending", debt ? 100 - index : createdAt);
            if (debt) {
                retainDiscoveryCloseDebt(session, run, "owner", createdAt, 0);
            }
            inserted.add(new PendingChild(TENANT, session, run, 1,
                    "planned", "resource-" + run));
        }
        assertThat(relayStore.findPendingChildren("owner", 1_000_000, 3))
                .containsExactly(inserted.get(4), inserted.get(3), inserted.get(2));
        assertThat(relayStore.findPendingChildren("owner", 1_000_000, 5))
                .containsExactly(inserted.get(4), inserted.get(3), inserted.get(2),
                        inserted.get(1), inserted.get(0));
    }

    @ParameterizedTest
    @ValueSource(strings = {"planned", "accepting", "unknown", "accepted", "consumed", "cancelled"})
    void filtersStartCandidatesBeforeTheirBranchLimit(String delivery) {
        long now = 1_000_000L;
        String session = UUID.randomUUID().toString();
        for (String terminal : List.of("done", "orphaned", "unknown")) {
            String run = "terminal-" + terminal;
            insertRecordRow("scope-filter", session, run, "child_agent",
                    delivery, "pending", now - 100);
            RelayRow row = relayStore.claim(TENANT, session, run, "key-" + run,
                    "owner", now + 30_000, now - 100);
            relayStore.classify(row, "owner", terminal, null, now - 90);
        }
        for (String run : List.of("backed-off", "foreign-lease")) {
            insertRecordRow("scope-filter", session, run, "child_agent",
                    delivery, "pending", now - 100);
            String owner = "backed-off".equals(run) ? "owner" : "other";
            RelayRow row = relayStore.claim(TENANT, session, run, "key-" + run,
                    owner, now + 30_000, now - 100);
            relayStore.advance(row, owner, "binding", "child-" + run,
                    "backed-off".equals(run) ? now + 1_000 : 0, null,
                    now + 30_000, now - 100);
        }
        for (String closeState : List.of("close_debt", "done", "orphaned", "unknown")) {
            String run = "closed-" + closeState;
            insertRecordRow("scope-filter", session, run, "child_agent",
                    delivery, "pending", now - 100);
            RelayRow close = retainDiscoveryCloseDebt(session, run, "owner",
                    now - 100, now + 1_000);
            if (!"close_debt".equals(closeState)) {
                relayStore.classify(close, "owner", closeState, null, now - 90);
            }
            // Keep START eligible so only NOT EXISTS can exclude this record.
            jdbc.update("UPDATE ma_operation SET state = 'binding'"
                            + " WHERE scope_key = ? AND operation_id = ?"
                            + " AND operation_kind = 'CHILD_SESSION_START'",
                    ManagedSessionStore.sessionScopeKey(TENANT, session), run);
        }
        insertRecordRow("scope-filter", session, "shell", "shell",
                delivery, "pending", now - 100);
        insertRecordRow("scope-filter", session, "missing-start", "child_agent",
                delivery, "pending", now - 20);
        insertRecordRow("scope-filter", session, "binding", "child_agent",
                delivery, "pending", now - 10);
        RelayRow binding = relayStore.claim(TENANT, session, "binding", "key-binding",
                "owner", now + 30_000, now - 10);
        relayStore.advance(binding, "owner", "binding", "child-binding", now,
                null, now + 30_000, now - 10);
        List<String> expected = new ArrayList<>();
        if (List.of("planned", "accepting", "unknown").contains(delivery)) {
            expected.add("missing-start");
        }
        expected.add("binding");
        assertThat(relayStore.findPendingChildren("owner", now, 1))
                .extracting(PendingChild::childRunId).containsExactly(expected.getFirst());
        assertThat(relayStore.findPendingChildren("owner", now, 2))
                .extracting(PendingChild::childRunId).containsExactlyElementsOf(expected);
    }

    @Test
    void filtersCloseDebtsBeforeTheirBranchLimit() {
        long now = 1_000_000L;
        String session = UUID.randomUUID().toString();
        for (String terminal : List.of("done", "orphaned", "unknown")) {
            RelayRow close = retainDiscoveryCloseDebt(session, "terminal-" + terminal,
                    "owner", now - 300, 0);
            relayStore.classify(close, "owner", terminal, null, now - 299);
        }
        retainDiscoveryCloseDebt(session, "backed-off", "owner", now - 200, now + 1_000);
        retainDiscoveryCloseDebt(session, "foreign-lease", "other", now - 190, 0);
        for (int index = 3; index >= 0; index--) {
            String run = "debt-" + index;
            if (index == 1 || index == 2) {
                insertRecordRow("scope-debt", session, run, "child_agent",
                        index == 1 ? "consumed" : null, "completed", 1);
            }
            retainDiscoveryCloseDebt(session, run, "owner", now - 100 + index, now);
        }
        insertRecordRow("scope-debt", session, "launch", "child_agent",
                "planned", "pending", now - 1);
        assertThat(relayStore.findPendingChildren("owner", now, 4))
                .containsExactly(
                        new PendingChild(TENANT, session, "launch", 1, "planned", "resource-launch"),
                        new PendingChild(TENANT, session, "debt-0", 0, "accepted", null),
                        new PendingChild(TENANT, session, "debt-1", 1, "consumed", "resource-debt-1"),
                        new PendingChild(TENANT, session, "debt-2", 1, "accepted", "resource-debt-2"));
        assertThat(relayStore.findPendingChildren("stranger", now, 4))
                .extracting(PendingChild::childRunId).containsExactly("launch");
        assertThat(relayStore.findPendingChildren("stranger", now + 30_000, 3))
                .extracting(PendingChild::childRunId)
                .containsExactly("launch", "backed-off", "foreign-lease");
    }

    private RelayRow retainDiscoveryCloseDebt(String session, String run, String owner,
            long createdAt, long availableAt) {
        RelayRow row = relayStore.claim(TENANT, session, run, "key-" + run,
                owner, createdAt + 30_000, createdAt);
        relayStore.retainCloseDebt(row, owner, "done", "child-" + run,
                availableAt, null, createdAt + 30_000, createdAt);
        return relayStore.find(TENANT, session, run);
    }

    // The execution proof is the record's own body: the runtime_state
    // column is the Runtime projection (`unbound`, `provisioning`,
    // `ready`) and never carries the execution enum — a column read
    // classifies every row started and wedges the give-up chain behind
    // verdicts the wire keeps refusing.
    @Test
    void readsTheExecutionLineFromTheRecordBody() {
        String session = UUID.randomUUID().toString();
        // `delivered` keeps the fixtures off the fleet-wide discovery
        // page; only the execution read is under test here.
        insertRecordRow("scope-e", session, "run-exec-intent",
                "child_agent", "delivered", "pending");
        jdbc.update("UPDATE ma_session_record SET"
                        + " runtime_state = 'unbound'"
                        + " WHERE tenant_id = ?"
                        + " AND record_id = X'72756e2d657865632d696e74656e74'",
                TENANT);
        insertRecordBody("resource-run-exec-intent", session, "intent");
        assertThat(relayStore.executionState(TENANT, session,
                "run-exec-intent")).isEqualTo("intent");
        insertRecordRow("scope-e", session, "run-exec-dispatch",
                "child_agent", "delivered", "pending");
        jdbc.update("UPDATE ma_session_record SET"
                        + " runtime_state = 'provisioning'"
                        + " WHERE tenant_id = ?"
                        + " AND record_id = X'72756e2d657865632d6469737061746368'",
                TENANT);
        insertRecordBody("resource-run-exec-dispatch", session,
                "dispatch_started");
        assertThat(relayStore.executionState(TENANT, session,
                "run-exec-dispatch")).isEqualTo("dispatch_started");
        // A terminal record projects a null runtime_state; the body
        // still answers its execution line.
        insertRecordRow("scope-e", session, "run-exec-settled",
                "child_agent", "delivered", "completed");
        insertRecordBody("resource-run-exec-settled", session, "settled");
        assertThat(relayStore.executionState(TENANT, session,
                "run-exec-settled")).isEqualTo("settled");
        // No committed record row at all is the never-started answer.
        assertThat(relayStore.executionState(TENANT, session,
                "run-missing")).isNull();
        // A row whose body cannot prove the line owes the caller a
        // bounded retry, never a guessed verdict.
        insertRecordRow("scope-e", session, "run-exec-corrupt",
                "child_agent", "delivered", "pending");
        assertThatThrownBy(() -> relayStore.executionState(TENANT,
                session, "run-exec-corrupt"))
                .isInstanceOf(IllegalStateException.class);
    }

    private void insertRecordBody(String resourceId, String sessionId, String execution) {
        resource(sessionId, resourceId, "managed-child_run", "{\"kind\":\"child_agent\",\"run\":{\"state\":\"admitted\",\"execution\":\"" + execution + "\"}}");
    }

    private void resource(String sessionId, String resourceId, String kind, String body) {
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource (resource_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, 'workspace', ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'command', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(scope, resourceId), TENANT, sessionId,
                resourceId, kind, bytes.length, "a".repeat(64), bytes);
    }

    @Test
    void readsInlineResourcesOnly() {
        resource("session", "res-1", "managed-input", "xy");
        assertThat(relayStore.readResource(TENANT, "session", "res-1")).isEqualTo("xy");
        assertThat(relayStore.readResource(TENANT, "session", "res-2")).isNull();
    }

    // Two workers read the same expired lease; the first renews it. The
    // second, deciding from its stale read, must meet that fresh lease
    // rather than take the run's walk over as well.
    @Test
    void anExpiredLeaseIsWonByOneOfTwoWorkersThatReadIt() {
        String session = UUID.randomUUID().toString();
        relayStore.claim(TENANT, session, "run-race", "key-race", "owner-a",
                31_000, 1_000);
        RelayRow stale = relayStore.find(TENANT, session, "run-race");
        assertThat(relayStore.claim(TENANT, session, "run-race", "key-race",
                "owner-a", 70_000, 40_000)).isNotNull();
        JdbcChildResultRelayStore staleReader = new JdbcChildResultRelayStore(jdbc) {
            @Override
            public RelayRow find(String tenantId, String parentSessionId,
                    String childRunId) {
                return stale;
            }
        };
        assertThat(staleReader.claim(TENANT, session, "run-race", "key-race",
                "owner-b", 70_000, 40_000)).isNull();
        assertThat(relayStore.find(TENANT, session, "run-race").claimedBy())
                .isEqualTo("owner-a");
    }

    @Test
    void readsTheTurnLineAndTerminalResult() throws Exception {
        String session = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, status, gmt_create,"
                        + " gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1,"
                        + " 1)",
                TENANT, session);
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, is_submission_attempted, gmt_create,"
                        + " gmt_modified, completed_at, version)"
                        + " VALUES (?, ?, 'turn-1', 'prompt-1', '[]', 'd',"
                        + " 'COMPLETED', TRUE, 1, 2, 2, 1)", TENANT, session);
        JdbcChildResultRelayStore.TurnLine turn = relayStore.latestTurn(TENANT,
                session);
        assertThat(turn.status()).isEqualTo("COMPLETED");
        assertThat(turn.submissionAttempted()).isTrue();
        assertThat(turn.harnessEventEpoch()).isNull();
        assertThat(turn.dispatched()).isTrue();
        // A Turn whose admission never landed is a pre-admission failure,
        // never dispatch proof (R23's cascade producer).
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, is_submission_attempted, gmt_create,"
                        + " gmt_modified, completed_at, version)"
                        + " VALUES (?, ?, 'turn-pre', 'prompt-2', '[]', 'd',"
                        + " 'FAILED', FALSE, 3, 4, 4, 1)",
                TENANT, session);
        assertThat(relayStore.latestTurn(TENANT, session).dispatched())
                .isFalse();
        // H4d-b: the first Turn stays the task the child was created with.
        assertThat(relayStore.firstTurn(TENANT, session).turnId())
                .isEqualTo("turn-1");
        assertThat(relayStore.firstTurn(TENANT, UUID.randomUUID().toString()))
                .isNull();
        jdbc.update("INSERT INTO ma_message (tenant_id, session_id,"
                        + " item_id, turn_id, item_type, item_role,"
                        + " item_status, attributes_json, first_sequence,"
                        + " last_sequence, gmt_create, gmt_modified, revision, parts_json)"
                        + " VALUES (?, ?, 'item-1', 'turn-1', 'message',"
                        + " 'assistant', 'completed', '{}', 1, 3, 1, 1, 1, '[]')",
                TENANT, session);
        part(session, "item-1", "part-1", "output_text", "审阅通过", 2);
        // R1-90: pin the two decisions the result query makes — the
        // NEWEST assistant message wins over an older assistant and over
        // a newer non-assistant row, and the chosen item's output_text
        // parts join in sequence order.
        jdbc.update("INSERT INTO ma_message (tenant_id, session_id,"
                        + " item_id, turn_id, item_type, item_role,"
                        + " item_status, attributes_json, first_sequence,"
                        + " last_sequence, gmt_create, gmt_modified, revision, parts_json)"
                        + " VALUES (?, ?, 'item-0', 'turn-1', 'message',"
                        + " 'assistant', 'completed', '{}', 1, 1, 1, 1, 1, '[]')",
                TENANT, session);
        part(session, "item-0", "part-0", "output_text", "older answer", 1);
        jdbc.update("INSERT INTO ma_message (tenant_id, session_id,"
                        + " item_id, turn_id, item_type, item_role,"
                        + " item_status, attributes_json, first_sequence,"
                        + " last_sequence, gmt_create, gmt_modified, revision, parts_json)"
                        + " VALUES (?, ?, 'item-2', 'turn-1', 'message', 'user',"
                        + " 'completed', '{}', 4, 4, 1, 1, 1, '[]')",
                TENANT, session);
        part(session, "item-2", "part-2", "output_text", "newer but not the child answer", 4);
        part(session, "item-1", "part-3", "output_text", "第二段", 3);
        part(session, "item-1", "part-4", "reasoning_text", "not the answer", 5);
        assertThat(relayStore.terminalResultText(TENANT, session, "turn-1"))
                .isEqualTo("审阅通过\n第二段");
    }
    private void part(String session, String item, String id, String type, String text, long sequence) throws Exception {
        var json = new com.fasterxml.jackson.databind.ObjectMapper();
        var parts = (com.fasterxml.jackson.databind.node.ArrayNode) json.readTree(jdbc.queryForObject(
                "SELECT parts_json FROM ma_message WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                String.class, TENANT, session, item));
        parts.addObject().put("partId", id).put("type", type).put("text", text).put("firstSequence", sequence)
                .put("lastSequence", sequence).put("createdAt", 1).put("updatedAt", 1).put("revision", 1);
        jdbc.update("UPDATE ma_message SET parts_json = ? WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                parts.toString(), TENANT, session, item);
    }
}
