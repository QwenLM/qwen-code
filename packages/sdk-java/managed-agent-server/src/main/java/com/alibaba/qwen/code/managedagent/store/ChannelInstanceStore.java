package com.alibaba.qwen.code.managedagent.store;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

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
            String deliveryId, String sessionId, long claimedAt) {
    }

    /** One delivery record row the projection still shows as owed. */
    public record PendingDelivery(String sessionId, String deliveryId,
            long revision, String deliveryState, String recordResourceId) {
    }

    private static final RowMapper<ChannelInstance> INSTANCE = (row, index) ->
            new ChannelInstance(row.getString("tenant_id"),
                    row.getString("channel_id"), row.getString("platform"),
                    row.getString("account_id"),
                    row.getLong("account_generation"), row.getString("state"),
                    row.getString("actor_id"), row.getString("workspace_id"),
                    row.getString("cwd_relative"),
                    row.getString("policy_json"), row.getLong("created_at"),
                    row.getLong("updated_at"));
    private static final RowMapper<ChannelBinding> BINDING = (row, index) ->
            new ChannelBinding(row.getString("tenant_id"),
                    row.getString("channel_id"), row.getString("route_id"),
                    row.getString("session_id"), row.getString("scope_kind"),
                    row.getString("sender_id"), row.getString("chat_id"),
                    row.getString("thread_id"), row.getLong("created_at"));
    private static final RowMapper<ChannelClaim> CLAIM = (row, index) ->
            new ChannelClaim(row.getString("tenant_id"),
                    row.getString("channel_id"), row.getString("delivery_id"),
                    row.getString("session_id"), row.getLong("claimed_at"));

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
            jdbc.update("INSERT INTO qwen_managed_channel_instance (tenant_id,"
                            + " channel_id, platform, account_id,"
                            + " account_generation, state, actor_id,"
                            + " workspace_id, cwd_relative, policy_json,"
                            + " created_at, updated_at)"
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
            jdbc.update("UPDATE qwen_managed_channel_instance SET"
                            + " account_generation = ?, state = ?, actor_id = ?,"
                            + " workspace_id = ?, cwd_relative = ?,"
                            + " policy_json = ?, updated_at = ?"
                            + " WHERE tenant_id = ? AND channel_id = ?",
                    candidate.accountGeneration(), candidate.state(),
                    candidate.actorId(), candidate.workspaceId(),
                    candidate.cwdRelative(), candidate.policyJson(), now,
                    candidate.tenantId(), candidate.channelId());
        }
        return findInstance(candidate.tenantId(), candidate.channelId())
                .orElseThrow();
    }

    public Optional<ChannelInstance> setState(String tenantId,
            String channelId, String state) {
        jdbc.update("UPDATE qwen_managed_channel_instance SET state = ?,"
                        + " updated_at = ? WHERE tenant_id = ?"
                        + " AND channel_id = ?",
                state, databaseNow(), tenantId, channelId);
        return findInstance(tenantId, channelId);
    }

    public Optional<ChannelInstance> findInstance(String tenantId,
            String channelId) {
        return jdbc.query("SELECT * FROM qwen_managed_channel_instance"
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
            cursor = " AND (created_at < ? OR created_at = ?"
                    + " AND channel_id < ?)";
            arguments.add(before.createdAt());
            arguments.add(before.createdAt());
            arguments.add(before.channelId());
        }
        arguments.add(limit + 1);
        List<ChannelInstance> rows = jdbc.query(
                "SELECT * FROM qwen_managed_channel_instance"
                        + " WHERE tenant_id = ?" + cursor
                        + " ORDER BY created_at DESC, channel_id DESC LIMIT ?",
                INSTANCE, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new InstancePage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    public Optional<ChannelBinding> findBinding(String tenantId,
            String channelId, String routeId) {
        return jdbc.query("SELECT * FROM qwen_managed_channel_binding"
                        + " WHERE tenant_id = ? AND channel_id = ?"
                        + " AND route_id = ?",
                BINDING, tenantId, channelId, routeId).stream().findFirst();
    }

    /** Inserts the binding, or keeps the first one a racing admission won. */
    public ChannelBinding bind(ChannelBinding candidate) {
        jdbc.update("INSERT IGNORE INTO qwen_managed_channel_binding"
                        + " (tenant_id, channel_id, route_id, session_id,"
                        + " scope_kind, sender_id, chat_id, thread_id,"
                        + " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                candidate.tenantId(), candidate.channelId(),
                candidate.routeId(), candidate.sessionId(),
                candidate.scopeKind(), candidate.senderId(),
                candidate.chatId(), candidate.threadId(), databaseNow());
        return findBinding(candidate.tenantId(), candidate.channelId(),
                candidate.routeId()).orElseThrow();
    }

    /** The channel's bound Sessions, newest binding first. */
    public List<ChannelBinding> listBindings(String tenantId,
            String channelId, int limit) {
        return jdbc.query("SELECT * FROM qwen_managed_channel_binding"
                        + " WHERE tenant_id = ? AND channel_id = ?"
                        + " ORDER BY created_at DESC, route_id DESC LIMIT ?",
                BINDING, tenantId, channelId, limit);
    }

    /**
     * The channel_delivery rows of one Session whose delivery line is still
     * owed to a dispatcher, oldest first.
     */
    public List<PendingDelivery> findPendingDeliveries(String tenantId,
            String sessionId, int limit) {
        return jdbc.query("SELECT session_id, record_id, revision,"
                        + " delivery_state, record_resource_id"
                        + " FROM qwen_managed_session_extension_record"
                        + " WHERE session_scope_key = ?"
                        + " AND domain = 'channel_delivery'"
                        + " AND delivery_state IN ('planned', 'partial')"
                        + " ORDER BY created_at, record_key LIMIT ?",
                (row, index) -> new PendingDelivery(row.getString("session_id"),
                        row.getString("record_id"), row.getLong("revision"),
                        row.getString("delivery_state"),
                        row.getString("record_resource_id")),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                limit);
    }

    /** One inline resource's text, or null when it is not inline-held. */
    public String readResource(String tenantId, String resourceId) {
        List<byte[]> rows = jdbc.query(
                "SELECT inline_bytes FROM qwen_managed_session_resource"
                        + " WHERE tenant_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED'",
                (row, index) -> row.getBytes("inline_bytes"), tenantId,
                resourceId);
        return rows.isEmpty() ? null
                : new String(rows.getFirst(), StandardCharsets.UTF_8);
    }

    public ChannelClaim claim(String tenantId, String channelId,
            String deliveryId, String sessionId) {
        jdbc.update("INSERT IGNORE INTO qwen_managed_channel_claim"
                        + " (tenant_id, channel_id, delivery_id, session_id,"
                        + " claimed_at) VALUES (?, ?, ?, ?, ?)",
                tenantId, channelId, deliveryId, sessionId, databaseNow());
        return findClaim(tenantId, channelId, deliveryId).orElseThrow();
    }

    /** A re-claim of a partial delivery restarts its lease. */
    public void touchClaim(String tenantId, String channelId,
            String deliveryId) {
        jdbc.update("UPDATE qwen_managed_channel_claim SET claimed_at = ?"
                        + " WHERE tenant_id = ? AND channel_id = ?"
                        + " AND delivery_id = ?",
                databaseNow(), tenantId, channelId, deliveryId);
    }

    public Optional<ChannelClaim> findClaim(String tenantId, String channelId,
            String deliveryId) {
        return jdbc.query("SELECT * FROM qwen_managed_channel_claim"
                        + " WHERE tenant_id = ? AND channel_id = ?"
                        + " AND delivery_id = ?",
                CLAIM, tenantId, channelId, deliveryId).stream().findFirst();
    }

    /** Claims older than {@code before} whose ledger row still says sending. */
    public List<ChannelClaim> findExpiredSendingClaims(long before,
            int limit) {
        return jdbc.query("SELECT c.* FROM qwen_managed_channel_claim c"
                        + " JOIN qwen_managed_channel_delivery d"
                        + " ON d.tenant_id = c.tenant_id"
                        + " AND d.channel_instance_id = c.channel_id"
                        + " AND d.delivery_id = c.delivery_id"
                        + " WHERE c.claimed_at < ? AND d.state = 'sending'"
                        + " ORDER BY c.claimed_at, c.delivery_id LIMIT ?",
                CLAIM, before, limit);
    }

    public String sessionStatus(String tenantId, String sessionId) {
        List<String> rows = jdbc.query(
                "SELECT status FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
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
