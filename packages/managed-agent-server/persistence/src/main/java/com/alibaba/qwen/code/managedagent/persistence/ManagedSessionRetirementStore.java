package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.nio.charset.StandardCharsets;
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
        ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, tenant, session);
        var packs = jdbc.queryForList("SELECT pack_id FROM ma_journal_pack WHERE tenant_id = ? AND session_id = ?"
                + " AND state <> 'RETIRED' ORDER BY pack_id LIMIT ? FOR UPDATE", tenant, session, limit);
        for (var pack : packs) {
            jdbc.update("UPDATE ma_journal_pack SET state = 'RETIRED', gmt_modified = "
                    + ManagedSchemaTime.SQL_NOW + " WHERE pack_id = ? AND tenant_id = ? AND session_id = ?",
                    pack.get("pack_id"), tenant, session);
        }
        if (!packs.isEmpty()) {
            return true;
        }
        var nativeSnapshots = jdbc.queryForList("SELECT owner_ref, owner_revision, resource_id FROM ma_resource_ref"
                + " WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'NATIVE_SNAPSHOT'"
                + " ORDER BY owner_ref, owner_revision, resource_id LIMIT ? FOR UPDATE", tenant, session, limit);
        for (var row : nativeSnapshots) {
            jdbc.update("DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'NATIVE_SNAPSHOT'"
                    + " AND owner_ref = ? AND owner_revision = ? AND resource_id = ?",
                    tenant, session, row.get("owner_ref"), row.get("owner_revision"), row.get("resource_id"));
        }
        if (!nativeSnapshots.isEmpty()) {
            return true;
        }
        var sideRefs = jdbc.queryForList("SELECT owner_ref,owner_revision,resource_id FROM ma_resource_ref"
                + " WHERE tenant_id=? AND session_id=? AND owner_kind='SIDE_QUERY' ORDER BY owner_ref,owner_revision,resource_id LIMIT ? FOR UPDATE",
                tenant, session, limit);
        for (var row : sideRefs) {
            jdbc.update("DELETE FROM ma_resource_ref WHERE tenant_id=? AND session_id=? AND owner_kind='SIDE_QUERY'"
                            + " AND owner_ref=? AND owner_revision=? AND resource_id=?", tenant, session, row.get("owner_ref"),
                    row.get("owner_revision"), row.get("resource_id"));
        }
        if (!sideRefs.isEmpty()) {
            return true;
        }
        var queries = jdbc.queryForList("SELECT query_id,read_lease_id FROM ma_side_query WHERE tenant_id=? AND session_id=?"
                + " ORDER BY query_id LIMIT ? FOR UPDATE", tenant, session, limit);
        for (var row : queries) {
            if (row.get("read_lease_id") != null) {
                // read_lease_id stays VARBINARY; the lease_id it names is now
                // VARCHAR, so bind the decoded text rather than raw bytes.
                jdbc.update("DELETE FROM ma_read_lease WHERE lease_id=?", text(row.get("read_lease_id")));
            }
            jdbc.update("DELETE FROM ma_side_query WHERE tenant_id=? AND session_id=? AND query_id=?", tenant, session,
                    row.get("query_id"));
        }
        if (!queries.isEmpty()) {
            return true;
        }
        var receipts = jdbc.queryForList("SELECT receipt_key FROM ma_request_receipt WHERE tenant_id=? AND session_id=?"
                + " AND namespace='SIDE_QUERY' ORDER BY receipt_key LIMIT ? FOR UPDATE", tenant, session, limit);
        for (var row : receipts) {
            jdbc.update("DELETE FROM ma_request_receipt WHERE receipt_key=? AND namespace='SIDE_QUERY'", row.get("receipt_key"));
        }
        if (!receipts.isEmpty()) {
            return true;
        }
        var clientFilesRequests = jdbc.queryForList("SELECT binding_generation, request_id FROM ma_client_files_request"
                + " WHERE tenant_id=? AND session_id=? ORDER BY binding_generation, request_id LIMIT ? FOR UPDATE",
                tenant, session, limit);
        for (var row : clientFilesRequests) {
            jdbc.update("DELETE FROM ma_client_files_request WHERE tenant_id=? AND session_id=?"
                    + " AND binding_generation=? AND request_id=?", tenant, session,
                    row.get("binding_generation"), row.get("request_id"));
        }
        if (!clientFilesRequests.isEmpty()) {
            return true;
        }
        var clientFilesBindings = jdbc.queryForList("SELECT session_id FROM ma_client_files_binding"
                + " WHERE tenant_id=? AND session_id=? FOR UPDATE", tenant, session);
        if (!clientFilesBindings.isEmpty()) {
            jdbc.update("DELETE FROM ma_client_files_binding WHERE tenant_id=? AND session_id=?", tenant, session);
        }
        if (!clientFilesBindings.isEmpty()) {
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
            release(jdbc, tenant, session, "MESSAGE", ManagedIdentityRefs.ref(
                    ManagedIdentityRefs.OWNER_REF_BYTES, tenant, session, id));
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
                        "SELECT domain, record_id FROM ma_session_record WHERE tenant_id = ?"
                                + " AND session_id = ? ORDER BY domain, record_id LIMIT ? FOR UPDATE",
                        tenant,
                        session,
                        limit);
        for (var row : records) {
            String domain = (String) row.get("domain");
            String recordId = (String) row.get("record_id");
            if ("automation_run".equals(domain)) {
                jdbc.update("UPDATE ma_schedule_occurrence SET is_run_terminal = 0"
                                + " WHERE tenant_id = ? AND run_id = ? AND session_id = ?",
                        tenant, recordId, session);
            }
            release(jdbc, tenant, session, "SESSION_RECORD", ManagedIdentityRefs.ref(
                    ManagedIdentityRefs.OWNER_REF_BYTES, session, domain, recordId));
            jdbc.update(
                    "DELETE FROM ma_session_record WHERE tenant_id = ? AND session_id = ? AND domain = ? AND record_id = ?",
                    tenant,
                    session,
                    domain,
                    recordId);
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
                    "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind ="
                            + " 'JOURNAL' AND owner_ref = ? AND owner_revision = ?",
                    tenant,
                    session,
                    ManagedSchemaKeys.identity(ManagedIdentityRefs.ref(
                            ManagedIdentityRefs.OWNER_REF_BYTES, tenant, session)),
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
                    "UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", compacted_through_revision = GREATEST(compacted_through_revision, ?) WHERE tenant_id = ? AND harness_session_id = ? AND session_id = ? AND state = 'DELETED'",
                    revisions.getLast(),
                    tenant,
                    session,
                    session);
            return true;
        }
        var cleanupOwners = jdbc.queryForList("SELECT owner_ref, owner_revision, resource_id"
                + " FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'HOSTED_CLEANUP'"
                + " ORDER BY owner_ref, owner_revision, resource_id LIMIT ? FOR UPDATE", tenant, session, limit);
        for (var row : cleanupOwners) {
            jdbc.update("DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                    + " AND owner_kind = 'HOSTED_CLEANUP' AND owner_ref = ? AND owner_revision = ?"
                    + " AND resource_id = ?", tenant, session, row.get("owner_ref"), row.get("owner_revision"), row.get("resource_id"));
        }
        if (!cleanupOwners.isEmpty()) {
            return true;
        }
        var stagedRows = jdbc.queryForList(
                "SELECT id, execution_call_id_hash, delivery_seq FROM ma_runtime_stage"
                        + " WHERE runtime_session_key = ? ORDER BY execution_call_id_hash, delivery_seq"
                        + " LIMIT ? FOR UPDATE",
                ManagedSessionStore.sessionScopeKey(tenant, session),
                limit);
        for (var row : stagedRows) {
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'RUNTIME_STAGE'"
                            + " AND owner_ref = ? AND owner_revision = ?",
                    tenant,
                    session,
                    ManagedSchemaKeys.identity((String) row.get("execution_call_id_hash")),
                    row.get("delivery_seq"));
            jdbc.update("DELETE FROM ma_runtime_stage WHERE id = ?", row.get("id"));
        }
        if (!stagedRows.isEmpty()) {
            return true;
        }
        var stagedRefs = jdbc.queryForList(
                "SELECT owner_ref, owner_revision, resource_id FROM ma_resource_ref"
                        + " WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'RUNTIME_STAGE'"
                        + " ORDER BY owner_ref, owner_revision, resource_id LIMIT ? FOR UPDATE",
                tenant,
                session,
                limit);
        for (var row : stagedRefs) {
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'RUNTIME_STAGE'"
                            + " AND owner_ref = ? AND owner_revision = ? AND resource_id = ?",
                    tenant,
                    session,
                    row.get("owner_ref"),
                    row.get("owner_revision"),
                    row.get("resource_id"));
        }
        if (!stagedRefs.isEmpty()) {
            return true;
        }
        var streams =
                jdbc.queryForList(
                        "SELECT stream_kind, stream_id FROM ma_event_stream WHERE tenant_id = ? AND"
                            + " session_id = ? AND artifact_refs_resource_ref IS NOT NULL LIMIT ?"
                            + " FOR UPDATE",
                        tenant,
                        session,
                        limit);
        for (var row : streams) {
            String kind = (String) row.get("stream_kind");
            String id = (String) row.get("stream_id");
            jdbc.update(
                    "UPDATE ma_event_stream SET artifact_refs_resource_ref = NULL WHERE tenant_id ="
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
                        "SELECT owner_ref, owner_revision, resource_id FROM ma_resource_ref WHERE"
                                + " tenant_id = ? AND session_id = ? AND owner_kind = 'EVENT_STREAM' ORDER BY"
                                + " owner_ref, owner_revision, resource_id LIMIT ? FOR UPDATE",
                        tenant,
                        session,
                        limit);
        for (var row : streamRefs) {
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind ="
                            + " 'EVENT_STREAM' AND owner_ref = ? AND owner_revision = ? AND"
                            + " resource_id = ?",
                    tenant,
                    session,
                    row.get("owner_ref"),
                    row.get("owner_revision"),
                    row.get("resource_id"));
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
                "UPDATE ma_event_stream SET covered_sequence = last_sequence"
                    + " WHERE tenant_id = ? AND session_id = ? AND stream_kind = 'SESSION'"
                    + " AND stream_id = ''",
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
                        "SELECT retired_at, retirement_generation, is_recovery_protected FROM"
                                + " ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                        tenant,
                        session);
        if (roots.size() != 1
                || roots.getFirst().get("retired_at") == null
                || ToolPublicationRetentionStore.number(roots.getFirst(), "retirement_generation")
                        < 1
                || ToolPublicationRetentionStore.flag(roots.getFirst(), "is_recovery_protected")) {
            throw new IllegalStateException("Session retirement is incomplete");
        }
        var heads =
                jdbc.queryForList(
                        "SELECT tenant_id, session_id, harness_session_id, head_kind, state,"
                            + " journal_revision, compacted_through_revision, writer_id,"
                            + " writer_lease_until, latest_checkpoint_resource_id, recovery_status"
                            + " FROM ma_session_head WHERE tenant_id = ? AND harness_session_id = ? FOR"
                            + " UPDATE",
                        tenant,
                        session);
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
        if (!jdbc.queryForList("SELECT resource_id FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                + " AND owner_kind = 'NATIVE_SNAPSHOT' LIMIT 1", tenant, session).isEmpty()) {
            throw new IllegalStateException("Native snapshot collection is incomplete");
        }
        if (hasJournalPacks(jdbc, tenant, session)) {
            throw new IllegalStateException("Session journal pack collection is incomplete");
        }
        String retirementScope = ManagedSessionStore.sessionScopeKey(tenant, session);
        if (!jdbc.queryForList("SELECT id FROM ma_runtime_stage WHERE runtime_session_key = ? LIMIT 1",
                retirementScope).isEmpty()
                || !jdbc.queryForList("SELECT resource_id FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                        + " AND owner_kind = 'RUNTIME_STAGE' LIMIT 1", tenant, session).isEmpty()) {
            throw new IllegalStateException("Runtime staging collection is incomplete");
        }
        var operations =
                jdbc.queryForList(
                        "SELECT tenant_id, session_id, state FROM ma_operation"
                            + " WHERE operation_ref = ? AND operation_kind = 'SESSION_RESOURCE_GC'"
                            + " FOR UPDATE",
                        ManagedSchemaKeys.identity(operationKey));
        if (operations.size() != 1
                || !tenant.equals(operations.getFirst().get("tenant_id"))
                || !session.equals(operations.getFirst().get("session_id"))
                || !"SUCCEEDED".equals(operations.getFirst().get("state"))) {
            throw new IllegalStateException("Session collection is not settled");
        }
        if (jdbc.update(
                        "UPDATE ma_session SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", is_resource_gc_completed = TRUE WHERE tenant_id = ? AND session_id = ? AND retired_at IS NOT NULL",
                        tenant,
                        session)
                != 1) {
            throw new IllegalStateException("Session retirement identity changed");
        }
    }

    static boolean hasJournalPacks(JdbcTemplate jdbc, String tenant, String session) {
        return !jdbc.queryForList("SELECT pack_id FROM ma_journal_pack WHERE tenant_id = ? AND session_id = ? LIMIT 1",
                tenant, session).isEmpty();
    }

    private static void release(JdbcTemplate jdbc, String tenant, String session, String kind, String owner) {
        jdbc.update(
                "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = ? AND"
                        + " owner_ref = ?",
                tenant,
                session,
                kind,
                ManagedSchemaKeys.identity(owner));
    }

    private static String text(Object value) {
        return value instanceof byte[] bytes
                ? new String(bytes, StandardCharsets.UTF_8) : (String) value;
    }
}
