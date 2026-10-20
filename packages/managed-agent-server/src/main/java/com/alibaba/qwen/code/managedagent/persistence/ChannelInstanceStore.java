package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * H5b/H5c: the control plane's channel indexes beside the V47 serving
 * tables — registered connections, the scope → Session route catalog,
 * the dispatcher's claim ledger, and the bounded reads the channel service
 * needs over the Session store's extension-record projection. Every row
 * here is located or settled by a journal commit; none is a second copy
 * of one.
 */
@Repository
public class ChannelInstanceStore {
    /** The states a registered connection reports. */
    public static final List<String> INSTANCE_STATES = List.of("connected",
            "disconnected");

    public record ChannelInstance(String tenantId, String channelId,
            String platform, String accountId, long accountGeneration,
            String state, String actorId, String workspaceId,
            String cwdRelative, String policyJson, long createdAt,
            long updatedAt) {
    }

    public record InstanceCursor(long createdAt, String channelId) {
    }

    public record InstancePage(List<ChannelInstance> instances,
            boolean hasMore) {
    }

    public record ChannelBinding(String tenantId, String channelId,
            String routeId, String sessionId, String scopeKind,
            String senderId, String chatId, String threadId,
            long createdAt) {
    }

    public record ChannelClaim(String tenantId, String channelId,
            String deliveryId, String sessionId, long claimedAt, long claimGeneration) {
    }

    /** One delivery record row the projection still shows as owed. */
    public record PendingDelivery(String sessionId, String deliveryId,
            long revision, String deliveryState, String recordResourceId) {
    }

    /** The projection's mirror of one committed delivery, any state. */
    public record DeliveryRecordState(String deliveryState,
            String recordResourceId) {
    }

    private static final RowMapper<ChannelInstance> INSTANCE = (row, index) ->
            new ChannelInstance(row.getString("tenant_id"),
                    row.getString("channel_id"), row.getString("platform"),
                    row.getString("account_id"),
                    row.getLong("account_generation"), row.getString("state"),
                    row.getString("actor_id"), row.getString("workspace_id"),
                    row.getString("cwd_relative"),
                    row.getString("policy_json"), row.getLong("gmt_create"),
                    row.getLong("gmt_modified"));
    private static final RowMapper<ChannelBinding> BINDING = (row, index) ->
            new ChannelBinding(row.getString("tenant_id"),
                    row.getString("channel_id"), row.getString("route_id"),
                    row.getString("session_id"), row.getString("scope_kind"),
                    row.getString("sender_id"), row.getString("chat_id"),
                    row.getString("thread_id"), row.getLong("gmt_create"));
    private static final RowMapper<ChannelClaim> CLAIM = (row, index) ->
            new ChannelClaim(row.getString("tenant_id"),
                    row.getString("channel_id"), row.getString("delivery_id"),
                    row.getString("session_id"), row.getLong("claimed_at"), row.getLong("claim_generation"));

    private final JdbcTemplate jdbc;

    public ChannelInstanceStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Registers or refreshes a connection; the generation never moves back. */
    public ChannelInstance register(ChannelInstance candidate) {
        long now = databaseNow();
        Optional<ChannelInstance> existing = findInstance(candidate.tenantId(),
                candidate.channelId());
        if (existing.isEmpty()) {
            jdbc.update("INSERT INTO ma_channel_instance (tenant_id,"
                            + " channel_id, platform, account_id,"
                            + " account_generation, state, actor_id,"
                            + " workspace_id, cwd_relative, policy_json,"
                            + " gmt_create, gmt_modified)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    candidate.tenantId(), candidate.channelId(),
                    candidate.platform(), candidate.accountId(),
                    candidate.accountGeneration(), candidate.state(),
                    candidate.actorId(), candidate.workspaceId(),
                    candidate.cwdRelative(), candidate.policyJson(), now, now);
        } else {
            ChannelInstance current = existing.get();
            if (candidate.accountGeneration() < current.accountGeneration()) {
                throw new IllegalStateException("channel_generation_stale");
            }
            if (!current.platform().equals(candidate.platform())
                    || !current.accountId().equals(candidate.accountId())) {
                throw new IllegalStateException("channel_identity_conflict");
            }
            // An ownership move must not inherit what was visible to the
            // old owner: every retained binding still names a Session of
            // the old Workspace, and its routes and receipts would answer
            // under the new connection's read authority. Re-registering a
            // fresh connection with no bindings keeps the history.
            boolean ownershipMoves = !current.actorId()
                    .equals(candidate.actorId())
                    || !current.workspaceId().equals(candidate.workspaceId())
                    || !current.cwdRelative().equals(candidate.cwdRelative());
            if (ownershipMoves && jdbc.queryForObject(
                    "SELECT COUNT(*) FROM ma_channel_binding"
                            + " WHERE tenant_id = ? AND channel_id = ?",
                    Long.class, candidate.tenantId(),
                    candidate.channelId()) > 0) {
                throw new IllegalStateException("channel_ownership_conflict");
            }
            // The monotonic-generation check rides in the write itself: an
            // overlapping registration that moved the row forward can no
            // longer slip between the earlier SELECT and this UPDATE. An
            // ownership move's binding count rides in this same statement:
            // a racing bind committed between the pre-check and now makes
            // the subquery flatten the write to zero rows (R10 P2).
            if (ownershipMoves) {
                int rows = jdbc.update("UPDATE ma_channel_instance"
                                + " SET account_generation = ?, state = ?,"
                                + " actor_id = ?, workspace_id = ?,"
                                + " cwd_relative = ?, policy_json = ?,"
                                + " gmt_modified = ?"
                                + " WHERE tenant_id = ? AND channel_id = ?"
                                + " AND account_generation <= ?"
                                + " AND (SELECT COUNT(*) FROM"
                                + " ma_channel_binding b"
                                + " WHERE b.tenant_id = ?"
                                + " AND b.channel_id = ?) = 0",
                        candidate.accountGeneration(), candidate.state(),
                        candidate.actorId(), candidate.workspaceId(),
                        candidate.cwdRelative(), candidate.policyJson(), now,
                        candidate.tenantId(), candidate.channelId(),
                        candidate.accountGeneration(), candidate.tenantId(),
                        candidate.channelId());
                if (rows == 0) {
                    throw new IllegalStateException(
                            "channel_ownership_conflict");
                }
            } else {
                int rows = jdbc.update("UPDATE ma_channel_instance"
                                + " SET account_generation = ?, state = ?,"
                                + " actor_id = ?, workspace_id = ?,"
                                + " cwd_relative = ?, policy_json = ?,"
                                + " gmt_modified = ?"
                                + " WHERE tenant_id = ? AND channel_id = ?"
                                + " AND account_generation <= ?",
                        candidate.accountGeneration(), candidate.state(),
                        candidate.actorId(), candidate.workspaceId(),
                        candidate.cwdRelative(), candidate.policyJson(), now,
                        candidate.tenantId(), candidate.channelId(),
                        candidate.accountGeneration());
                if (rows == 0) {
                    throw new IllegalStateException(
                            "channel_generation_stale");
                }
            }
        }
        return findInstance(candidate.tenantId(), candidate.channelId())
                .orElseThrow();
    }

    public Optional<ChannelInstance> setState(String tenantId,
            String channelId, String state) {
        jdbc.update("UPDATE ma_channel_instance SET state = ?,"
                        + " gmt_modified = ? WHERE tenant_id = ?"
                        + " AND channel_id = ?",
                state, databaseNow(), tenantId, channelId);
        return findInstance(tenantId, channelId);
    }

    public Optional<ChannelInstance> findInstance(String tenantId,
            String channelId) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.CHANNEL_INSTANCE.columns() + " FROM ma_channel_instance"
                        + " WHERE tenant_id = ? AND channel_id = ?",
                INSTANCE, tenantId, channelId).stream().findFirst();
    }

    /** Newest first by (createdAt, channelId); {@code before} is exclusive. */
    public InstancePage listInstances(String tenantId, InstanceCursor before,
            int limit) {
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        String cursor = "";
        if (before != null) {
            cursor = " AND (gmt_create < ? OR gmt_create = ?"
                    + " AND channel_id < ?)";
            arguments.add(before.createdAt());
            arguments.add(before.createdAt());
            arguments.add(before.channelId());
        }
        arguments.add(limit + 1);
        List<ChannelInstance> rows = jdbc.query(
                "SELECT " + ManagedSchemaProjection.CHANNEL_INSTANCE.columns() + " FROM ma_channel_instance"
                        + " WHERE tenant_id = ?" + cursor
                        + " ORDER BY gmt_create DESC, channel_id DESC LIMIT ?",
                INSTANCE, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new InstancePage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    public Optional<ChannelBinding> findBinding(String tenantId,
            String channelId, String routeId) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.CHANNEL_BINDING.columns() + " FROM ma_channel_binding"
                        + " WHERE tenant_id = ? AND channel_id = ?"
                        + " AND route_id = ?",
                BINDING, tenantId, channelId, routeId).stream().findFirst();
    }

    /** Inserts the binding, or keeps the first one a racing admission won. */
    public ChannelBinding bind(ChannelBinding candidate) {
        jdbc.update("INSERT IGNORE INTO ma_channel_binding"
                        + " (tenant_id, channel_id, route_id, session_id,"
                        + " scope_kind, sender_id, chat_id, thread_id,"
                        + " gmt_create) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                candidate.tenantId(), candidate.channelId(),
                candidate.routeId(), candidate.sessionId(),
                candidate.scopeKind(), candidate.senderId(),
                candidate.chatId(), candidate.threadId(), databaseNow());
        return findBinding(candidate.tenantId(), candidate.channelId(),
                candidate.routeId()).orElseThrow();
    }

    /**
     * The channel's Sessions that owe a dispatcher at least one delivery,
     * oldest owed first. Scoping on the store's delivery projection — not
     * on a window of the newest bindings — lets a claim reach a delivery
     * owed by any binding, however many the channel has.
     */
    public List<String> listSessionsWithPendingDeliveries(String tenantId,
            String channelId, int limit) {
        return jdbc.query("SELECT r.session_id, MIN(r.gmt_create) AS"
                        + " oldest_due"
                        + " FROM ma_session_record r"
                        + " JOIN ma_channel_binding b"
                        + " ON b.tenant_id = r.tenant_id"
                        + " AND b.session_id = r.session_id"
                        + " JOIN ma_session s"
                        + " ON s.tenant_id = r.tenant_id"
                        + " AND s.session_id = r.session_id"
                        + " AND s.session_kind = 'PUBLIC' AND s.status = 'ACTIVE'"
                        + " WHERE r.record_kind = 'DOMAIN' AND r.tenant_id = ? AND b.channel_id = ?"
                        + " AND r.domain = 'channel_delivery'"
                        + " AND r.delivery_state IN ('planned', 'partial')"
                        + " GROUP BY r.session_id"
                        + " ORDER BY oldest_due, r.session_id LIMIT ?",
                (row, index) -> row.getString(1), tenantId, channelId,
                limit);
    }

    /** One delivery's committed mirror state and record resource. */
    public Optional<DeliveryRecordState> findDeliveryRecord(String tenantId,
            String sessionId, String deliveryId) {
        return jdbc.query("SELECT delivery_state, record_resource_id"
                        + " FROM ma_session_record"
                        + " WHERE record_kind = 'DOMAIN' AND session_scope_key = ?"
                        + " AND domain = 'channel_delivery'"
                        + " AND record_id = ?",
                (row, index) -> new DeliveryRecordState(row.getString(1),
                        row.getString(2)),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                deliveryId).stream().findFirst();
    }

    /**
     * The channel_delivery rows of one Session whose delivery line is still
     * owed to a dispatcher, oldest first.
     */
    public List<PendingDelivery> findPendingDeliveries(String tenantId,
            String sessionId, int limit) {
        // The ordering index can scan all completed deliveries before finding a due row.
        return jdbc.query("SELECT session_id, record_id, revision,"
                        + " delivery_state, record_resource_id"
                        + " FROM ma_session_record USE INDEX (ix_ma_record_session_delivery)"
                        + " WHERE record_kind = 'DOMAIN' AND session_scope_key = ?"
                        + " AND domain = 'channel_delivery'"
                        + " AND delivery_state IN ('planned', 'partial')"
                        + " ORDER BY gmt_create, record_key LIMIT ?",
                (row, index) -> new PendingDelivery(row.getString("session_id"),
                        row.getString("record_id"), row.getLong("revision"),
                        row.getString("delivery_state"),
                        row.getString("record_resource_id")),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                limit);
    }

    /** One inline resource's text, or null when it is not inline-held. */
    public String readResource(String tenantId, String sessionId, String resourceId) {
        List<byte[]> rows = jdbc.query(
                "SELECT inline_bytes FROM ma_resource"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED'",
                (row, index) -> row.getBytes("inline_bytes"),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId, resourceId);
        return rows.isEmpty() ? null
                : new String(rows.getFirst(), StandardCharsets.UTF_8);
    }

    public ChannelClaim claim(String tenantId, String channelId,
            String deliveryId, String sessionId) {
        long now = databaseNow();
        jdbc.update("UPDATE ma_delivery SET source_session_id = ?, claimed_at = ?,"
                        + " claim_generation = claim_generation + 1, gmt_modified = ?"
                        + " WHERE delivery_key = ? AND delivery_kind = 'CHANNEL' AND tenant_id = ?"
                        + " AND channel_id = ? AND delivery_id = ? AND claimed_at IS NULL",
                sessionId, now, now,
                JdbcChannelDeliveryRepository.deliveryKey(tenantId, channelId, deliveryId),
                tenantId, channelId, deliveryId);
        ChannelClaim claim = findClaim(tenantId, channelId, deliveryId)
                .orElseThrow(() -> new IllegalStateException("Channel delivery must exist before its claim"));
        if (!sessionId.equals(claim.sessionId())) {
            throw new IllegalStateException("Channel claim belongs to another Session");
        }
        return claim;
    }

    /** A re-claim of a partial delivery restarts its lease with a new fence. */
    public ChannelClaim touchClaim(String tenantId, String channelId,
            String deliveryId) {
        long now = databaseNow();
        jdbc.update("UPDATE ma_delivery SET claimed_at = ?, claim_generation = claim_generation + 1,"
                        + " reconcile_operation_id = NULL, gmt_modified = ? WHERE delivery_key = ? AND delivery_kind = 'CHANNEL'"
                        + " AND tenant_id = ? AND channel_id = ? AND delivery_id = ? AND claimed_at IS NOT NULL",
                now, now, JdbcChannelDeliveryRepository.deliveryKey(tenantId, channelId, deliveryId),
                tenantId, channelId, deliveryId);
        return findClaim(tenantId, channelId, deliveryId).orElseThrow();
    }

    public Optional<ChannelClaim> findClaim(String tenantId, String channelId,
            String deliveryId) {
        return jdbc.query("SELECT tenant_id, channel_id, delivery_id, source_session_id AS session_id, claimed_at, claim_generation"
                        + " FROM ma_delivery WHERE delivery_key = ? AND delivery_kind = 'CHANNEL'"
                        + " AND tenant_id = ? AND channel_id = ? AND delivery_id = ? AND claimed_at IS NOT NULL",
                CLAIM, JdbcChannelDeliveryRepository.deliveryKey(tenantId, channelId, deliveryId),
                tenantId, channelId, deliveryId).stream().findFirst();
    }

    public static final String RECONCILE_OPERATION_PREFIX = "channel-reconcile:";

    public static String reconciliationOperationId(ChannelClaim claim) {
        return RECONCILE_OPERATION_PREFIX + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                claim.tenantId(), claim.channelId(), claim.deliveryId(), Long.toString(claim.claimGeneration()));
    }

    public boolean reserveReconciliation(ChannelClaim claim) {
        return jdbc.update("UPDATE ma_delivery SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", reconcile_operation_id = ? WHERE delivery_key = ? AND delivery_kind = 'CHANNEL' AND tenant_id = ? AND channel_id = ? AND delivery_id = ? AND source_session_id = ? AND claimed_at = ? AND claim_generation = ? AND transport_state IN ('planned','sending','partial')",
                reconciliationOperationId(claim), JdbcChannelDeliveryRepository.deliveryKey(claim.tenantId(), claim.channelId(), claim.deliveryId()),
                claim.tenantId(), claim.channelId(), claim.deliveryId(), claim.sessionId(), claim.claimedAt(), claim.claimGeneration()) == 1;
    }

    static void requireReconciliationFence(JdbcTemplate jdbc, String tenantId, String sessionId,
            String deliveryId, String operationId) {
        if (!operationId.startsWith(RECONCILE_OPERATION_PREFIX)) {
            return;
        }
        List<ChannelClaim> claims = jdbc.query("SELECT tenant_id,channel_id,delivery_id,source_session_id AS session_id,"
                        + " claimed_at,claim_generation FROM ma_delivery WHERE reconcile_operation_id = ?"
                        + " AND delivery_kind = 'CHANNEL' FOR UPDATE", CLAIM, operationId);
        if (claims.size() != 1 || !tenantId.equals(claims.getFirst().tenantId())
                || !sessionId.equals(claims.getFirst().sessionId()) || !deliveryId.equals(claims.getFirst().deliveryId())
                || !operationId.equals(reconciliationOperationId(claims.getFirst()))) {
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(org.springframework.http.HttpStatus.CONFLICT,
                    "channel_claim_stale", "The channel delivery claim changed before reconciliation committed.");
        }
    }

    /** Expired open CHANNEL rows, with the claim and transport authority in one row. */
    public List<ChannelClaim> findExpiredClaims(long before, int limit) {
        return jdbc.query("SELECT tenant_id, channel_id, delivery_id, source_session_id AS session_id, claimed_at, claim_generation"
                        + " FROM ma_delivery WHERE delivery_kind = 'CHANNEL' AND claimed_at < ?"
                        + " AND transport_state IN ('planned', 'sending', 'partial')"
                        + " ORDER BY claimed_at, delivery_id LIMIT ?",
                CLAIM, before, limit);
    }

    public String sessionStatus(String tenantId, String sessionId) {
        List<String> rows = jdbc.query(
                "SELECT status FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ? AND session_kind = 'PUBLIC'",
                (row, index) -> row.getString("status"), tenantId,
                sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public long databaseNow() {
        return jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(),"
                        + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Math.addExact(
                        Math.multiplyExact(row.getLong(1), 1000),
                        row.getLong(2) / 1000));
    }
}
