package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;

/** Called by the fenced retirement collector after its reader/recovery/effect checks. */
final class ManagedSessionRetirementStore {
    private ManagedSessionRetirementStore() {}

    static boolean deleteOwnerBatch(JdbcTemplate jdbc, String tenant, String session, int limit) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()
                || limit < 1
                || limit > 128) {
            throw new IllegalStateException("Retired owner cleanup requires a bounded transaction");
        }
        var roots =
                jdbc.queryForList(
                        "SELECT retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                                + " FOR UPDATE",
                        tenant,
                        session);
        if (roots.size() != 1 || roots.getFirst().get("retired_at") == null) {
            throw new IllegalStateException("Session has not been permanently retired");
        }
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        var snapshots =
                jdbc.queryForList(
                        "SELECT snapshot_id, snapshot_version FROM ma_snapshot WHERE tenant_id = ?"
                            + " AND session_id = ? ORDER BY snapshot_version LIMIT ? FOR UPDATE",
                        tenant,
                        session,
                        limit);
        for (var row : snapshots) {
            String id = (String) row.get("snapshot_id");
            jdbc.update(
                    "UPDATE ma_event_stream SET current_snapshot_id = NULL WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' AND"
                            + " current_snapshot_id = ?",
                    tenant,
                    session,
                    id);
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                            + " 'SNAPSHOT' AND owner_key = ? AND owner_revision = ?",
                    scope,
                    ManagedSchemaKeys.key(scope, id),
                    row.get("snapshot_version"));
            jdbc.update(
                    "DELETE FROM ma_snapshot WHERE tenant_id = ? AND session_id = ? AND snapshot_id"
                            + " = ?",
                    tenant,
                    session,
                    id);
        }
        if (!snapshots.isEmpty()) {
            return true;
        }
        var messages =
                jdbc.queryForList(
                        "SELECT item_id FROM ma_message WHERE tenant_id = ? AND session_id = ?"
                                + " ORDER BY item_id LIMIT ? FOR UPDATE",
                        tenant,
                        session,
                        limit);
        for (var row : messages) {
            String id = (String) row.get("item_id");
            release(jdbc, scope, "MESSAGE", ManagedSchemaKeys.key(scope, id));
            jdbc.update(
                    "DELETE FROM ma_message WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                    tenant,
                    session,
                    id);
        }
        if (!messages.isEmpty()) {
            return true;
        }
        var records =
                jdbc.queryForList(
                        "SELECT record_key FROM ma_session_record WHERE session_scope_key = ?"
                                + " ORDER BY record_key LIMIT ? FOR UPDATE",
                        scope,
                        limit);
        for (var row : records) {
            String key = (String) row.get("record_key");
            release(jdbc, scope, "SESSION_RECORD", key);
            jdbc.update(
                    "DELETE FROM ma_session_record WHERE session_scope_key = ? AND record_key = ?",
                    scope,
                    key);
        }
        if (!records.isEmpty()) {
            return true;
        }
        List<Long> revisions =
                jdbc.queryForList(
                        "SELECT journal_revision FROM ma_session_journal_tx WHERE tenant_id = ? AND"
                                + " session_id = ? ORDER BY journal_revision LIMIT ? FOR UPDATE",
                        Long.class,
                        tenant,
                        session,
                        limit);
        for (long revision : revisions) {
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                            + " 'JOURNAL' AND owner_key = ? AND owner_revision = ?",
                    scope,
                    scope,
                    revision);
            jdbc.update(
                    "DELETE FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND"
                            + " journal_revision = ?",
                    tenant,
                    session,
                    revision);
        }
        if (!revisions.isEmpty()) {
            jdbc.update(
                    "UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", compacted_through_revision = GREATEST(compacted_through_revision, ?) WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND state = 'DELETED'",
                    revisions.getLast(),
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                    JdbcRuntimeBindingRepository.harnessDrainKey(session),
                    tenant,
                    session);
            return true;
        }
        var streams =
                jdbc.queryForList(
                        "SELECT stream_kind, stream_id FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND artifact_refs_resource_key IS NOT NULL LIMIT ?"
                            + " FOR UPDATE",
                        tenant,
                        session,
                        limit);
        for (var row : streams) {
            String kind = (String) row.get("stream_kind");
            String id = (String) row.get("stream_id");
            jdbc.update(
                    "UPDATE ma_event_stream SET artifact_refs_resource_key = NULL WHERE tenant_id ="
                            + " ? AND session_id = ? AND stream_kind = ? AND stream_id = ?",
                    tenant,
                    session,
                    kind,
                    id);
        }
        if (!streams.isEmpty()) {
            return true;
        }
        var streamRefs =
                jdbc.queryForList(
                        "SELECT owner_key, owner_revision, resource_key FROM ma_resource_ref WHERE"
                                + " session_scope_key = ? AND owner_kind = 'EVENT_STREAM' ORDER BY"
                                + " owner_key, owner_revision, resource_key LIMIT ? FOR UPDATE",
                        scope,
                        limit);
        for (var row : streamRefs) {
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind ="
                            + " 'EVENT_STREAM' AND owner_key = ? AND owner_revision = ? AND"
                            + " resource_key = ?",
                    scope,
                    row.get("owner_key"),
                    row.get("owner_revision"),
                    row.get("resource_key"));
        }
        if (!streamRefs.isEmpty()) {
            return true;
        }
        // Cursor counters remain on their durable stream roots even after the last event is
        // removed.
        var events =
                jdbc.queryForList(
                        "SELECT stream_kind, stream_id, sequence_id FROM ma_public_event WHERE"
                            + " tenant_id = ? AND session_id = ? ORDER BY stream_kind, stream_id,"
                            + " sequence_id LIMIT ? FOR UPDATE",
                        tenant,
                        session,
                        limit);
        for (var row : events) {
            jdbc.update(
                    "DELETE FROM ma_public_event WHERE tenant_id = ? AND session_id = ? AND"
                            + " stream_kind = ? AND stream_id = ? AND sequence_id = ?",
                    tenant,
                    session,
                    row.get("stream_kind"),
                    row.get("stream_id"),
                    row.get("sequence_id"));
        }
        if (!events.isEmpty()) {
            for (var row : events) {
                jdbc.update(
                        "UPDATE ma_event_stream SET replay_floor_sequence ="
                                + " GREATEST(replay_floor_sequence, ?) WHERE tenant_id = ? AND"
                                + " session_id = ? AND stream_kind = ? AND stream_id = ?",
                        row.get("sequence_id"),
                        tenant,
                        session,
                        row.get("stream_kind"),
                        row.get("stream_id"));
            }
            return true;
        }
        jdbc.update(
                "UPDATE ma_event_stream SET covered_sequence = last_sequence, snapshot_stale_since"
                    + " = NULL WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION'"
                    + " AND stream_id = X''",
                tenant,
                session);
        return false;
    }

    static void markCollectionCompleted(
            JdbcTemplate jdbc, String tenant, String session, String operationKey) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Retirement completion requires a transaction");
        }
        var roots =
                jdbc.queryForList(
                        "SELECT retired_at, retirement_generation, recovery_protected FROM"
                                + " ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                        tenant,
                        session);
        if (roots.size() != 1
                || roots.getFirst().get("retired_at") == null
                || ToolPublicationRetentionStore.number(roots.getFirst(), "retirement_generation")
                        < 1
                || ToolPublicationRetentionStore.flag(roots.getFirst(), "recovery_protected")) {
            throw new IllegalStateException("Session retirement is incomplete");
        }
        var heads =
                jdbc.queryForList(
                        "SELECT tenant_id, session_id, harness_session_id, head_kind, state,"
                            + " journal_revision, compacted_through_revision, writer_id,"
                            + " writer_lease_until, latest_checkpoint_resource_id, recovery_status"
                            + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? FOR"
                            + " UPDATE",
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                        JdbcRuntimeBindingRepository.harnessDrainKey(session));
        if (!heads.isEmpty()
                && (!tenant.equals(heads.getFirst().get("tenant_id"))
                        || !session.equals(heads.getFirst().get("harness_session_id")))) {
            throw new IllegalStateException("Session journal identity changed");
        }
        if (!heads.isEmpty() && "MANAGED_SESSION".equals(heads.getFirst().get("head_kind"))) {
            var head = heads.getFirst();
            if (!tenant.equals(head.get("tenant_id"))
                    || !session.equals(head.get("session_id"))
                    || !"DELETED".equals(head.get("state"))
                    || head.get("writer_id") != null
                    || head.get("writer_lease_until") != null
                    || head.get("latest_checkpoint_resource_id") != null
                    || !"READY".equals(head.get("recovery_status"))
                    || ToolPublicationRetentionStore.number(head, "compacted_through_revision")
                            != ToolPublicationRetentionStore.number(head, "journal_revision")) {
                throw new IllegalStateException("Session journal collection is incomplete");
            }
        }
        if (!jdbc.queryForList(
                        "SELECT journal_revision FROM ma_session_journal_tx WHERE tenant_id = ? AND"
                                + " session_id = ? LIMIT 1",
                        tenant,
                        session)
                .isEmpty()) {
            throw new IllegalStateException("Session journal collection is incomplete");
        }
        var operations =
                jdbc.queryForList(
                        "SELECT tenant_id, session_id, session_scope_key, state FROM ma_operation"
                            + " WHERE operation_key = ? AND operation_kind = 'SESSION_RESOURCE_GC'"
                            + " FOR UPDATE",
                        operationKey);
        if (operations.size() != 1
                || !tenant.equals(operations.getFirst().get("tenant_id"))
                || !session.equals(operations.getFirst().get("session_id"))
                || !ManagedSessionStore.sessionScopeKey(tenant, session)
                        .equals(operations.getFirst().get("session_scope_key"))
                || !"SUCCEEDED".equals(operations.getFirst().get("state"))) {
            throw new IllegalStateException("Session collection is not settled");
        }
        if (jdbc.update(
                        "UPDATE ma_session SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", resource_gc_completed = TRUE WHERE tenant_id = ? AND session_id = ? AND retired_at IS NOT NULL",
                        tenant,
                        session)
                != 1) {
            throw new IllegalStateException("Session retirement identity changed");
        }
    }

    private static void release(JdbcTemplate jdbc, String scope, String kind, String owner) {
        jdbc.update(
                "DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = ? AND"
                        + " owner_key = ?",
                scope,
                kind,
                owner);
    }
}
