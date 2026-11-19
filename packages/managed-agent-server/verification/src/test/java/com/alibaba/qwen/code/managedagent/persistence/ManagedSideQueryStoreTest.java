package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.*;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedSideQueryStoreTest {
    protected JdbcTemplate jdbc;
    protected ManagedSideQueryStore queries;
    protected TransactionTemplate transactions;
    private DataSourceTransactionManager manager;
    protected String tenant;
    protected final String session = "session";
    protected final String actor = "actor";

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        transactions = new TransactionTemplate(manager);
        tenant = "tenant-" + UUID.randomUUID();
        initialize();
    }

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:side-query-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        return source;
    }

    private void initialize() {
        String scope = SideQueryConversation.scope(tenant, session);
        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified,tenant_key,session_key,session_scope_key)"
                        + " VALUES (?,?,'qwen-code',1,1,?,?,?)", tenant, session, ManagedSchemaKeys.key(tenant), ManagedSchemaKeys.key(session), scope);
        jdbc.update("INSERT INTO ma_event_stream (tenant_id,session_id,stream_kind,stream_id,gmt_modified) VALUES (?,?,'SESSION','',1)", tenant, session);
        jdbc.update("INSERT INTO ma_session_head (tenant_id,workspace_id,session_id,storage_version,state,writer_generation,"
                        + "journal_revision,committed_sequence,activation_epoch,gmt_create,gmt_modified,tenant_key,harness_key,harness_session_id,head_kind)"
                        + " VALUES (?,'ws',?,1,'ACTIVE',0,0,0,0,1,1,?,?,?,'MANAGED_SESSION')",
                tenant, session, ManagedSchemaKeys.key(tenant), ManagedSchemaKeys.key(session), session);
        var registry = mock(ManagedWorkspaceRegistry.class);
        when(registry.isSessionOwner(tenant, actor, session)).thenReturn(true);
        var models = mock(ManagedSessionModelConfigs.class);
        when(models.digest(tenant, session)).thenReturn("sha256:" + "a".repeat(64));
        queries = new ManagedSideQueryStore(jdbc, new ObjectMapper(), mock(HarnessRules.class), registry, models, manager);
    }

    @Test
    void frozenInputUsesTheJournalWorkspaceForAnUnboundSession() {
        String id = tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true)).query().queryId();
        Claim claim = tx(() -> queries.claim(tenant, session, id, "instance", "boot"));
        assertThat(tx(() -> queries.frozen(tenant, session, id, claim)).workspaceId()).isEqualTo("ws");
    }

    @Test
    void unsupportedStorageRefusesGenerationWithoutAdmittingAQuery() {
        jdbc.update("UPDATE ma_session_head SET storage_version=999 WHERE tenant_id=? AND session_id=?", tenant, session);
        assertThat(tx(() -> queries.context(tenant, actor, session)).generationAvailable()).isFalse();
        assertThatThrownBy(() -> tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true)))
                .hasFieldOrPropertyWithValue("code", "side_query_history_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_side_query WHERE tenant_id=?", Integer.class, tenant)).isZero();
    }

    @Test
    void actorPrivateReceiptReplaysAcrossDisableAndRejectsPayloadChanges() {
        Admission first = tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true));
        assertThat(first.dispatch()).isTrue();
        assertThat(tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), false)).query().queryId())
                .isEqualTo(first.query().queryId());
        assertThatThrownBy(() -> tx(() -> queries.admit(tenant, actor, session, btw("key", "changed"), true)))
                .hasFieldOrPropertyWithValue("code", "idempotency_conflict");
        assertThatThrownBy(() -> tx(() -> queries.get(tenant, "stranger", session, first.query().queryId())))
                .hasFieldOrPropertyWithValue("status", 404);
        assertThatThrownBy(() -> tx(() -> queries.admit(tenant, actor, session, btw("other", "other"), true)))
                .hasFieldOrPropertyWithValue("code", "side_query_active");
        assertThat(tx(() -> queries.admit(tenant, actor, session, new Create("recap", "manual", null, "recap", null, null), true)).dispatch())
                .isTrue();
    }

    @Test
    void cancellationWinsBeforeRunningAndReleasedStagingIsCollectedOnLiveSession() {
        String id = tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true)).query().queryId();
        Claim claim = tx(() -> queries.claim(tenant, session, id, "instance", "boot"));
        var manifest = resource("input", "{}");
        tx(() -> {
            queries.stage(tenant, session, id, claim, manifest);
            return null;
        });
        tx(() -> queries.cancel(tenant, actor, session, id));
        assertThat(tx(() -> queries.active(tenant, session, id, claim))).isFalse();
        assertThatThrownBy(() -> tx(() -> queries.publishInput(tenant, session, id, claim,
                new InputPublication("input", manifest.digest(), List.of("input")))))
                .hasFieldOrPropertyWithValue("code", "side_query_terminal");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind='SIDE_QUERY'", Integer.class)).isZero();
        assertThat(new ManagedProjectionResourceCollector(jdbc, manager).runOnce()).isTrue();
        assertThat(jdbc.queryForMap("SELECT state,inline_bytes FROM ma_resource WHERE resource_id=?", "input"))
                .containsEntry("state", "COLLECTED").containsEntry("inline_bytes", null);
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id=? AND session_id=?", String.class, tenant, session))
                .isEqualTo("ACTIVE");
    }

    @Test
    void completeInputHasOneRunningCasAndLateResultsCannotReviveCancellation() {
        String id = tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true)).query().queryId();
        Claim claim = tx(() -> queries.claim(tenant, session, id, "instance", "boot"));
        var manifest = resource("input", "{}");
        tx(() -> {
            queries.stage(tenant, session, id, claim, manifest);
            return null;
        });
        tx(() -> queries.publishInput(tenant, session, id, claim, new InputPublication("input", manifest.digest(), List.of("input"))));
        assertThat(tx(() -> queries.start(tenant, session, id, claim))).isTrue();
        assertThat(tx(() -> queries.start(tenant, session, id, claim))).isFalse();
        assertThatThrownBy(() -> tx(() -> queries.resource(tenant, session, id, claim, "input")))
                .hasFieldOrPropertyWithValue("code", "side_query_state_conflict");
        tx(() -> queries.cancel(tenant, actor, session, id));
        assertThatThrownBy(() -> tx(() -> queries.snapshot(tenant, session, id, claim,
                new ResultUpdate("completed", "success", "late", null, null))))
                .hasFieldOrPropertyWithValue("code", "side_query_terminal");
        assertThat(tx(() -> queries.get(tenant, actor, session, id)).status()).isEqualTo("cancelled");
    }

    @Test
    void successfulTextAndQuestionSurviveInputCleanupAndFeedOnlySameActorHistory() {
        String id = tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true)).query().queryId();
        Claim claim = tx(() -> queries.claim(tenant, session, id, "instance", "boot"));
        var input = resource("input", "{}");
        tx(() -> {
            queries.stage(tenant, session, id, claim, input);
            return null;
        });
        tx(() -> queries.publishInput(tenant, session, id, claim, new InputPublication("input", input.digest(), List.of("input"))));
        tx(() -> queries.start(tenant, session, id, claim));
        tx(() -> queries.snapshot(tenant, session, id, claim, new ResultUpdate("completed", "success", "answer", null, null)));
        Query saved = tx(() -> queries.get(tenant, actor, session, id));
        assertThat(saved.question()).isEqualTo("question");
        assertThat(saved.text()).isEqualTo("answer");
        String next = tx(() -> queries.admit(tenant, actor, session, btw("next", "followup"), true)).query().queryId();
        Claim nextClaim = tx(() -> queries.claim(tenant, session, next, "instance", "boot"));
        assertThat(tx(() -> queries.frozen(tenant, session, next, nextClaim)).privateHistory())
                .containsExactly(new Pair("question", "answer"));
        assertThatThrownBy(() -> tx(() -> queries.frozen(tenant, session, next,
                new Claim("instance", "other-boot", nextClaim.generation(), nextClaim.token()))))
                .hasFieldOrPropertyWithValue("code", "side_query_claim_conflict");
    }

    @Test
    void mainInputBoundaryAdvancesOnAdmissionButNotProjectionNoise() {
        Context initial = tx(() -> queries.context(tenant, actor, session));
        tx(() -> {
            SideQueryConversation.mainInputAccepted(jdbc, tenant, session);
            return null;
        });
        Context next = tx(() -> queries.context(tenant, actor, session));
        assertThat(next.mainInputBoundary()).isEqualTo(initial.mainInputBoundary() + 1);
        assertThat(next.contentVersion()).isEqualTo(initial.contentVersion());
        assertThat(next.completedUserTurnCount()).isZero();
    }

    @Test
    void automaticRecapRejectsStaleInputAndNeverReadmitsAnAttemptAfterFailure() throws Exception {
        Context initial = tx(() -> queries.context(tenant, actor, session));
        var state = new ObjectMapper().createObjectNode().put("mainInputBoundary", initial.mainInputBoundary())
                .put("completedUserTurnCount", 3).put("contentVersion", initial.contentVersion());
        jdbc.update("UPDATE ma_session_record SET options_json=? WHERE tenant_id=? AND session_id=? AND record_kind='CONVERSATION'",
                state.toString(), tenant, session);
        var stale = new Create("recap", "automatic", null, "stale", initial.contentVersion(), initial.mainInputBoundary() + 1);
        assertThatThrownBy(() -> tx(() -> queries.admit(tenant, actor, session, stale, true)))
                .hasFieldOrPropertyWithValue("code", "side_query_context_changed");
        var automatic = new Create("recap", "automatic", null, "auto", initial.contentVersion(), initial.mainInputBoundary());
        Admission first = tx(() -> queries.admit(tenant, actor, session, automatic, true));
        assertThat(first.dispatch()).isTrue();
        Admission manual = tx(() -> queries.admit(tenant, actor, session, new Create("recap", "manual", null, "manual", null, null), true));
        assertThat(manual.query().queryId()).isEqualTo(first.query().queryId());
        assertThat(manual.dispatch()).isFalse();
        tx(() -> queries.interrupt(tenant, session, first.query().queryId(), "model_error"));
        var again = new Create("recap", "automatic", null, "auto-again", initial.contentVersion(), initial.mainInputBoundary());
        Admission replay = tx(() -> queries.admit(tenant, actor, session, again, true));
        assertThat(replay.query().queryId()).isEqualTo(first.query().queryId());
        assertThat(replay.dispatch()).isFalse();
        Admission retry = tx(() -> queries.admit(tenant, actor, session, new Create("recap", "manual", null, "retry", null, null), true));
        assertThat(retry.dispatch()).isTrue();
        assertThat(retry.query().queryId()).isNotEqualTo(first.query().queryId());
    }

    @Test
    void preparationReadLeaseNeverRenewsAndPublicationAllowsLaterJournalAppends() {
        String id = tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true)).query().queryId();
        Claim claim = tx(() -> queries.claim(tenant, session, id, "instance", "boot"));
        Long expiry = jdbc.queryForObject("SELECT expires_at FROM ma_read_lease", Long.class);
        tx(() -> queries.frozen(tenant, session, id, claim));
        assertThat(jdbc.queryForObject("SELECT expires_at FROM ma_read_lease", Long.class)).isEqualTo(expiry);
        var manifest = resource("input", "{}");
        tx(() -> {
            queries.stage(tenant, session, id, claim, manifest);
            return null;
        });
        jdbc.update("UPDATE ma_session_head SET journal_revision=1,committed_sequence=1,last_commit_digest=?", "b".repeat(64));
        Query ready = tx(() -> queries.publishInput(tenant, session, id, claim,
                new InputPublication("input", manifest.digest(), List.of("input"))));
        assertThat(ready.source().journalRevision()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_read_lease", Integer.class)).isZero();
    }

    @Test
    void completedConversationCountsOnlyAcceptedSuccessfulRealUserTurnsFromJournalEnvelopes() throws Exception {
        var json = new ObjectMapper();
        var events = List.of(
                Map.of("kind", "input.accepted", "sequence", 1, "payload", Map.of("turnId", "user", "source", "web_shell")),
                Map.of("kind", "turn.settled", "sequence", 2, "payload", Map.of("turnId", "user", "outcome", "completed")),
                Map.of("kind", "input.accepted", "sequence", 3, "payload", Map.of("turnId", "background", "source", "schedule")),
                Map.of("kind", "turn.settled", "sequence", 4, "payload", Map.of("turnId", "background", "outcome", "completed")),
                Map.of("kind", "input.accepted", "sequence", 5, "payload", Map.of("turnId", "failed", "source", "web_shell")),
                Map.of("kind", "turn.settled", "sequence", 6, "payload", Map.of("turnId", "failed", "outcome", "error")),
                Map.of("kind", "input.accepted", "sequence", 7, "payload", Map.of("turnId", "running", "source", "web_shell")));
        var body = new StringBuilder();
        for (var event : events) {
            body.append(json.writeValueAsString(Map.of("subtype", "managed_session_event_v1", "managedSession", event))).append('\n');
        }
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String commit = "a".repeat(64);
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id,workspace_id,session_id,journal_revision,command_key_hash,"
                        + "transaction_id,operation,command_id,content_digest,first_sequence,last_sequence,event_count,commit_digest,"
                        + "writer_generation,writer_id,writer_token_hash,activation_epoch,record_encoding,record_bytes,byte_length,record_digest,gmt_create)"
                        + " VALUES (?,'ws',?,1,?,'tx','test','command',?,1,7,7,?,1,'writer',?,1,'identity',?,?,?,1)",
                tenant, session, "b".repeat(64), "c".repeat(64), commit, "d".repeat(64), bytes, bytes.length, JournalStoreRows.sha256(bytes));
        jdbc.update("UPDATE ma_session_head SET journal_revision=1,committed_sequence=7,last_commit_digest=?", commit);
        Context context = tx(() -> queries.context(tenant, actor, session));
        assertThat(context.completedUserTurnCount()).isEqualTo(1);
        appendDelta(2, 8, "turn.settled", Map.of("turnId", "running", "outcome", "completed"), commit, "e".repeat(64));
        Context settled = tx(() -> queries.context(tenant, actor, session));
        assertThat(settled.completedUserTurnCount()).isEqualTo(2);
        assertThat(settled.contentVersion()).isNotEqualTo(context.contentVersion());
        appendDelta(3, 9, "usage.updated", Map.of(), "e".repeat(64), "f".repeat(64));
        Context noise = tx(() -> queries.context(tenant, actor, session));
        assertThat(noise.completedUserTurnCount()).isEqualTo(2);
        assertThat(noise.contentVersion()).isEqualTo(settled.contentVersion());
        String id = tx(() -> queries.admit(tenant, actor, session, btw("key", "question"), true)).query().queryId();
        Query query = tx(() -> queries.get(tenant, actor, session, id));
        assertThat(query.source().completedTurnSequence()).isEqualTo(8);
        assertThat(query.source().committedSequence()).isEqualTo(9);
    }

    private void appendDelta(long revision, long sequence, String kind, Map<String, String> payload,
            String previous, String commit) throws Exception {
        var event = Map.of("subtype", "managed_session_event_v1", "managedSession",
                Map.of("kind", kind, "sequence", sequence, "payload", payload));
        byte[] bytes = (new ObjectMapper().writeValueAsString(event) + "\n").getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id,workspace_id,session_id,journal_revision,command_key_hash,"
                        + "transaction_id,operation,command_id,content_digest,first_sequence,last_sequence,event_count,previous_commit_digest,commit_digest,"
                        + "writer_generation,writer_id,writer_token_hash,activation_epoch,record_encoding,record_bytes,byte_length,record_digest,gmt_create)"
                        + " VALUES (?,'ws',?,?,?,?,'test',?,?,?, ?,1,?,?,1,'writer',?,1,'identity',?,?,?,1)",
                tenant, session, revision, ManagedSchemaKeys.key("tx", Long.toString(revision)), "tx-" + revision,
                "command-" + revision, "c".repeat(64), sequence, sequence, previous, commit, "d".repeat(64),
                bytes, bytes.length, JournalStoreRows.sha256(bytes));
        jdbc.update("UPDATE ma_session_head SET journal_revision=?,committed_sequence=?,last_commit_digest=?", revision, sequence, commit);
    }

    private static Create btw(String key, String question) {
        return new Create("btw", "manual", question, key, null, null);
    }

    private static CommitResource resource(String id, String content) {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        return new CommitResource(id, "managed-side-query-input", 1, bytes.length,
                JournalStoreRows.sha256(bytes), Base64.getEncoder().encodeToString(bytes));
    }

    protected <T> T tx(Supplier<T> action) {
        return transactions.execute(status -> action.get());
    }
}
