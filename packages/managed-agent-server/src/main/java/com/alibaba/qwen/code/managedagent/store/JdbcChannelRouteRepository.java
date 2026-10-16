package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/** The ingress receipt fixes routing identity; its operation owns attachment admission. */
public final class JdbcChannelRouteRepository implements ChannelRouteRepository {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SELECT = "SELECT " + ManagedSchemaProjection.OPERATION.columns("o") + " FROM ma_request_receipt r JOIN ma_operation o"
            + " ON o.operation_key = r.result_operation_key AND o.operation_kind = 'CHANNEL_INGRESS'"
            + " WHERE r.namespace = 'CHANNEL_INGRESS'";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public JdbcChannelRouteRepository(JdbcTemplate jdbc) {
        if (jdbc == null) {
            throw new IllegalArgumentException("jdbc is required");
        }
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    @Override
    public ChannelRoute findOrCreate(ChannelRoute candidate) {
        requireCandidate(candidate);
        String route = ChannelRouteRepository.routeKey(candidate.tenantId(), candidate.channelInstanceId(),
                candidate.accountGeneration(), candidate.platformEventId(), candidate.semanticRevision());
        transactions.executeWithoutResult(status -> {
            long now = databaseNow();
            String scope = ManagedSchemaKeys.key("CHANNEL", candidate.tenantId(), candidate.channelInstanceId());
            String target = ManagedSchemaKeys.key(candidate.sessionId());
            String operation = ManagedSchemaKeys.operationKey(OperationKind.CHANNEL_INGRESS, scope, target, route);
            String receipt = ManagedSchemaKeys.receiptKey(ReceiptNamespace.CHANNEL_INGRESS, candidate.tenantId(),
                    ReceiptScope.CHANNEL, candidate.channelInstanceId(), route);
            var body = JSON.createObjectNode().put("version", 1).put("channelId", candidate.channelInstanceId())
                    .put("accountGeneration", candidate.accountGeneration()).put("platformEventId", candidate.platformEventId())
                    .put("semanticRevision", candidate.semanticRevision()).put("senderId", candidate.senderId());
            if (candidate.chatId() != null) {
                body.put("chatId", candidate.chatId());
            }
            if (candidate.threadId() != null) {
                body.put("threadId", candidate.threadId());
            }
            body.set("stagedAttachmentRefs", JSON.valueToTree(candidate.stagedAttachmentRefs()));
            String request = body.toString();
            String digest = ManagedSchemaKeys.key(candidate.channelInstanceId(), Long.toString(candidate.accountGeneration()),
                    candidate.platformEventId(), Long.toString(candidate.semanticRevision()));
            int admitted = jdbc.update("INSERT IGNORE INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id,"
                            + " scope_kind, scope_key, scope_id, idempotency_key, idempotency_digest, request_digest,"
                            + " channel_id, account_generation, semantic_revision, session_id, state, result_operation_key,"
                            + " gmt_create, gmt_modified) VALUES (?, 'CHANNEL_INGRESS', ?, ?, 'CHANNEL', ?, ?, ?, ?, ?,"
                            + " ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)",
                    receipt, ManagedSchemaKeys.key(candidate.tenantId()), candidate.tenantId(), scope,
                    candidate.channelInstanceId(), route, ManagedSchemaKeys.key(route), digest,
                    candidate.channelInstanceId(), candidate.accountGeneration(), candidate.semanticRevision(),
                    candidate.sessionId(), operation, now, now);
            if (admitted == 1) {
                jdbc.update("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id, tenant_id,"
                                + " session_id, target_kind, target_key, request_digest, request_json, result_json, phase, state,"
                                + " gmt_create, gmt_modified) VALUES (?, ?, ?, 'CHANNEL_INGRESS', ?, ?, ?, 'SESSION', ?, ?, ?, ?, ?, ?, ?, ?)",
                        operation, ManagedSessionStore.sessionScopeKey(candidate.tenantId(), candidate.sessionId()), scope, route, candidate.tenantId(), candidate.sessionId(), target, digest, request,
                        candidate.inputId() == null ? null : JSON.createObjectNode().put("inputId", candidate.inputId()).toString(),
                        "admitted".equals(candidate.state()) ? "ADMITTED" : "STAGING", candidate.state(), now, now);
            }
        });
        ChannelRoute saved = find(candidate.tenantId(), route).orElseThrow(() ->
                new IllegalStateException("channel ingress receipt lost its operation"));
        if (!candidate.channelInstanceId().equals(saved.channelInstanceId())
                || candidate.accountGeneration() != saved.accountGeneration()
                || !candidate.platformEventId().equals(saved.platformEventId())
                || candidate.semanticRevision() != saved.semanticRevision()) {
            throw new IllegalStateException("channel route key collision");
        }
        return saved;
    }

    @Override
    public Optional<ChannelRoute> find(String tenantId, String routeKey) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(routeKey, "routeKey");
        List<ChannelRoute> rows = jdbc.query(SELECT + " AND r.tenant_key = ? AND r.idempotency_digest = ?"
                        + " AND r.tenant_id = ? AND r.idempotency_key = ?", this::row,
                ManagedSchemaKeys.key(tenantId), ManagedSchemaKeys.key(routeKey), tenantId, routeKey);
        if (rows.size() > 1) {
            throw new IllegalStateException("channel route key collision");
        }
        return rows.stream().findFirst();
    }

    @Override
    public ChannelRoute admit(String tenantId, String routeKey, String inputId) {
        ChannelStoreSupport.requireId(inputId, "inputId");
        ChannelRoute old = find(tenantId, routeKey).orElse(null);
        if (old == null) {
            return null;
        }
        String scope = ManagedSchemaKeys.key("CHANNEL", tenantId, old.channelInstanceId());
        String operation = ManagedSchemaKeys.operationKey(OperationKind.CHANNEL_INGRESS, scope,
                ManagedSchemaKeys.key(old.sessionId()), routeKey);
        int changed = jdbc.update("UPDATE ma_operation SET state = 'admitted', phase = 'ADMITTED', result_json = ?,"
                        + " gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'CHANNEL_INGRESS' AND state = 'staged'",
                JSON.createObjectNode().put("inputId", inputId).toString(), databaseNow(), operation);
        ChannelRoute current = find(tenantId, routeKey).orElse(null);
        return changed == 1 || current != null && "admitted".equals(current.state()) && inputId.equals(current.inputId())
                ? current : null;
    }

    @Override
    public RoutePage listByChannel(String tenantId, String channelInstanceId, RouteCursor before, int limit) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("limit must be in [1, 100]");
        }
        List<Object> args = new ArrayList<>(List.of(ManagedSchemaKeys.key(tenantId), tenantId, channelInstanceId));
        String cursor = "";
        if (before != null) {
            cursor = " AND (r.gmt_create < ? OR r.gmt_create = ? AND r.idempotency_key < ?)";
            args.add(before.createdAt());
            args.add(before.createdAt());
            args.add(before.routeKey());
        }
        args.add(limit + 1);
        List<ChannelRoute> rows = jdbc.query(SELECT + " AND r.tenant_key = ? AND r.tenant_id = ? AND r.channel_id = ?"
                + cursor + " ORDER BY r.gmt_create DESC, r.idempotency_key DESC LIMIT ?", this::row, args.toArray());
        boolean more = rows.size() > limit;
        return new RoutePage(more ? rows.subList(0, limit) : rows, more);
    }

    private ChannelRoute row(java.sql.ResultSet row, int index) throws java.sql.SQLException {
        JsonNode body = ManagedToolResultStore.parse(row.getString("request_json"));
        JsonNode result = row.getString("result_json") == null ? JSON.createObjectNode()
                : ManagedToolResultStore.parse(row.getString("result_json"));
        List<String> refs = new ArrayList<>();
        body.path("stagedAttachmentRefs").forEach(ref -> refs.add(ref.asText()));
        return new ChannelRoute(row.getString("tenant_id"), row.getString("operation_id"), body.path("channelId").asText(),
                body.path("accountGeneration").asLong(), body.path("platformEventId").asText(),
                body.path("semanticRevision").asLong(), row.getString("session_id"), body.path("senderId").asText(),
                nullable(body, "chatId"), nullable(body, "threadId"), row.getString("state"), nullable(result, "inputId"),
                List.copyOf(refs), row.getLong("gmt_create"), row.getLong("gmt_modified"));
    }

    private static String nullable(JsonNode body, String field) {
        return body.path(field).isTextual() ? body.path(field).asText() : null;
    }

    private long databaseNow() {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
    }

    private static void requireCandidate(ChannelRoute candidate) {
        if (candidate == null) {
            throw new IllegalArgumentException("candidate is required");
        }
        ChannelStoreSupport.requireId(candidate.tenantId(), "tenantId");
        ChannelStoreSupport.requireId(candidate.channelInstanceId(), "channelInstanceId");
        ChannelStoreSupport.requireId(candidate.platformEventId(), "platformEventId");
        ChannelStoreSupport.requireId(candidate.sessionId(), "sessionId");
        ChannelStoreSupport.requireId(candidate.senderId(), "senderId");
        if (candidate.accountGeneration() < 1 || candidate.semanticRevision() < 1) {
            throw new IllegalArgumentException("generation and revision must be positive");
        }
        if (!ROUTE_STATES.contains(candidate.state())
                || "admitted".equals(candidate.state()) == (candidate.inputId() == null)) {
            throw new IllegalArgumentException("a staged route has no input; an admitted route requires it");
        }
        if (candidate.stagedAttachmentRefs() == null || candidate.stagedAttachmentRefs().size() > 100) {
            throw new IllegalArgumentException("stagedAttachmentRefs must hold at most 100 entries");
        }
    }
}
