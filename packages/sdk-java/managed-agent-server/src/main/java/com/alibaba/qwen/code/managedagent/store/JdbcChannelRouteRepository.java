package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/**
 * JDBC ledger of the H5 channel ingress route bindings. Times are the
 * database clock's epoch milliseconds, the store's convention, so
 * created_at and updated_at never depend on an application host's clock.
 */
public final class JdbcChannelRouteRepository implements ChannelRouteRepository {
    private static final String COLUMNS = String.join(", ",
            "tenant_id", "route_key", "channel_instance_id",
            "account_generation", "platform_event_id", "semantic_revision",
            "session_id", "sender_id", "chat_id", "thread_id", "state",
            "input_id", "staged_attachment_refs_json", "created_at",
            "updated_at");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final RowMapper<ChannelRoute> MAPPER = (row, index) ->
            new ChannelRoute(
                    row.getString("tenant_id"),
                    row.getString("route_key"),
                    row.getString("channel_instance_id"),
                    row.getLong("account_generation"),
                    row.getString("platform_event_id"),
                    row.getLong("semantic_revision"),
                    row.getString("session_id"),
                    row.getString("sender_id"),
                    row.getString("chat_id"),
                    row.getString("thread_id"),
                    row.getString("state"),
                    row.getString("input_id"),
                    readRefs(row.getString("staged_attachment_refs_json")),
                    row.getLong("created_at"),
                    row.getLong("updated_at"));

    private final JdbcTemplate jdbc;

    public JdbcChannelRouteRepository(JdbcTemplate jdbc) {
        if (jdbc == null) {
            throw new IllegalArgumentException("jdbc is required");
        }
        this.jdbc = jdbc;
    }

    @Override
    public ChannelRoute findOrCreate(ChannelRoute candidate) {
        requireCandidate(candidate);
        try {
            long now = databaseNow();
            jdbc.update("INSERT INTO qwen_managed_channel_route (" + COLUMNS
                            + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    candidate.tenantId(),
                    ChannelRouteRepository.routeKey(candidate.tenantId(),
                            candidate.channelInstanceId(),
                            candidate.accountGeneration(),
                            candidate.platformEventId(),
                            candidate.semanticRevision()),
                    candidate.channelInstanceId(),
                    candidate.accountGeneration(),
                    candidate.platformEventId(),
                    candidate.semanticRevision(),
                    candidate.sessionId(),
                    candidate.senderId(),
                    candidate.chatId(),
                    candidate.threadId(),
                    candidate.state(),
                    candidate.inputId(),
                    writeRefs(candidate.stagedAttachmentRefs()),
                    now, now);
        } catch (DuplicateKeyException duplicate) {
            // Ingress redelivery of one platform event: keep the first row.
        }
        Optional<ChannelRoute> stored = find(candidate.tenantId(),
                ChannelRouteRepository.routeKey(candidate.tenantId(),
                        candidate.channelInstanceId(),
                        candidate.accountGeneration(),
                        candidate.platformEventId(),
                        candidate.semanticRevision()));
        ChannelRoute row = stored.orElseThrow(() -> new IllegalStateException(
                "channel route insert left no row"));
        if (!row.channelInstanceId().equals(candidate.channelInstanceId())
                || row.accountGeneration() != candidate.accountGeneration()
                || !row.platformEventId().equals(candidate.platformEventId())
                || row.semanticRevision() != candidate.semanticRevision()) {
            throw new IllegalStateException("channel route key collision");
        }
        return row;
    }

    @Override
    public Optional<ChannelRoute> find(String tenantId, String routeKey) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(routeKey, "routeKey");
        return jdbc.query("SELECT " + COLUMNS
                        + " FROM qwen_managed_channel_route"
                        + " WHERE tenant_id = ? AND route_key = ?",
                MAPPER, tenantId, routeKey).stream().findFirst();
    }

    @Override
    public ChannelRoute admit(String tenantId, String routeKey,
            String inputId) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(routeKey, "routeKey");
        ChannelStoreSupport.requireId(inputId, "inputId");
        int updated = jdbc.update("UPDATE qwen_managed_channel_route SET"
                        + " state = 'admitted', input_id = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND route_key = ?"
                        + " AND state = 'staged'",
                inputId, databaseNow(), tenantId, routeKey);
        Optional<ChannelRoute> current = find(tenantId, routeKey);
        if (updated == 1) {
            return current.orElseThrow(() -> new IllegalStateException(
                    "channel route admission left no row"));
        }
        return current.filter(row -> "admitted".equals(row.state())
                && inputId.equals(row.inputId())).orElse(null);
    }

    @Override
    public RoutePage listByChannel(String tenantId, String channelInstanceId,
            RouteCursor before, int limit) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("limit must be in [1, 100]");
        }
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        arguments.add(channelInstanceId);
        String cursor = "";
        if (before != null) {
            cursor = " AND (created_at < ? OR created_at = ?"
                    + " AND route_key < ?)";
            arguments.add(before.createdAt());
            arguments.add(before.createdAt());
            arguments.add(before.routeKey());
        }
        arguments.add(limit + 1);
        List<ChannelRoute> rows = jdbc.query("SELECT " + COLUMNS
                        + " FROM qwen_managed_channel_route"
                        + " WHERE tenant_id = ? AND channel_instance_id = ?" + cursor
                        + " ORDER BY created_at DESC, route_key DESC LIMIT ?",
                MAPPER, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new RoutePage(hasMore ? rows.subList(0, limit) : rows, hasMore);
    }

    private long databaseNow() {
        return jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(),"
                        + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Math.addExact(
                        Math.multiplyExact(row.getLong(1), 1000),
                        row.getLong(2) / 1000));
    }

    private static void requireCandidate(ChannelRoute candidate) {
        if (candidate == null) {
            throw new IllegalArgumentException("candidate is required");
        }
        ChannelStoreSupport.requireId(candidate.tenantId(), "tenantId");
        ChannelStoreSupport.requireId(candidate.channelInstanceId(),
                "channelInstanceId");
        ChannelStoreSupport.requireId(candidate.platformEventId(),
                "platformEventId");
        ChannelStoreSupport.requireId(candidate.sessionId(), "sessionId");
        ChannelStoreSupport.requireId(candidate.senderId(), "senderId");
        if (candidate.accountGeneration() < 1) {
            throw new IllegalArgumentException(
                    "accountGeneration must be positive");
        }
        if (candidate.semanticRevision() < 1) {
            throw new IllegalArgumentException(
                    "semanticRevision must be positive");
        }
        if (!ROUTE_STATES.contains(candidate.state())) {
            throw new IllegalArgumentException(
                    "unknown route state " + candidate.state());
        }
        if ("admitted".equals(candidate.state())
                == (candidate.inputId() == null)) {
            throw new IllegalArgumentException(
                    "an admitted route carries its input id; a staged route carries none");
        }
        if (candidate.stagedAttachmentRefs() == null
                || candidate.stagedAttachmentRefs().size() > 100) {
            throw new IllegalArgumentException(
                    "stagedAttachmentRefs must hold at most 100 entries");
        }
    }

    private static String writeRefs(List<String> refs) {
        try {
            return refs.isEmpty() ? null : JSON.writeValueAsString(refs);
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException(
                    "staged attachment refs are not serializable", error);
        }
    }

    private static List<String> readRefs(String json) {
        if (json == null) {
            return List.of();
        }
        try {
            return JSON.readValue(json, new TypeReference<>() {
            });
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(
                    "stored staged attachment refs are corrupt", error);
        }
    }
}
