package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelStoreSupport;
import com.alibaba.qwen.code.managedagent.contracts.persistence.PrWatchInjectionRepository;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Optional;

/** The ingress receipt fixes the PR-event envelope; its operation owns admission. */
public final class JdbcPrWatchInjectionRepository implements PrWatchInjectionRepository {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SELECT = "SELECT " + ManagedSchemaProjection.OPERATION.columns("o") + " FROM ma_request_receipt r JOIN ma_operation o"
            + " ON o.operation_key = r.result_operation_key AND o.operation_kind = 'PR_WATCH_INJECT'"
            + " WHERE r.namespace = 'PR_WATCH_INJECT'";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public JdbcPrWatchInjectionRepository(JdbcTemplate jdbc) {
        if (jdbc == null) {
            throw new IllegalArgumentException("jdbc is required");
        }
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    @Override
    public PrWatchInjection findOrCreate(PrWatchInjection candidate) {
        requireCandidate(candidate);
        transactions.executeWithoutResult(status -> {
            long now = databaseNow();
            String scope = ManagedSchemaKeys.key("CHANNEL", candidate.tenantId(), candidate.channelInstanceId());
            String target = ManagedSchemaKeys.key(candidate.sessionId());
            String operation = ManagedSchemaKeys.operationKey(OperationKind.PR_WATCH_INJECT, scope, target, candidate.inputId());
            String receipt = ManagedSchemaKeys.receiptKey(ReceiptNamespace.PR_WATCH_INJECT, candidate.tenantId(),
                    ReceiptScope.CHANNEL, candidate.channelInstanceId(), candidate.inputId());
            String request = JSON.createObjectNode().put("version", 1).put("channelInstanceId", candidate.channelInstanceId())
                    .put("bindingId", candidate.bindingId()).put("owner", candidate.owner()).put("repo", candidate.repo())
                    .put("prNumber", candidate.prNumber()).put("transition", candidate.transition())
                    .put("headSha", candidate.headSha()).put("episode", candidate.episode())
                    .put("evidence", candidate.evidence()).put("text", candidate.text())
                    .toString();
            String digest = ManagedSchemaKeys.key(candidate.inputId());
            int admitted = jdbc.update("INSERT IGNORE INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id,"
                            + " scope_kind, scope_key, scope_id, idempotency_key, idempotency_digest, request_digest,"
                            + " channel_id, session_id, state, result_operation_key, gmt_create, gmt_modified)"
                            + " VALUES (?, 'PR_WATCH_INJECT', ?, ?, 'CHANNEL', ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)",
                    receipt, ManagedSchemaKeys.key(candidate.tenantId()), candidate.tenantId(), scope,
                    candidate.channelInstanceId(), candidate.inputId(), digest, digest,
                    candidate.channelInstanceId(), candidate.sessionId(), operation, now, now);
            if (admitted == 1) {
                jdbc.update("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id, tenant_id,"
                                + " session_id, target_kind, target_key, request_digest, request_json, phase, state,"
                                + " gmt_create, gmt_modified) VALUES (?, ?, ?, 'PR_WATCH_INJECT', ?, ?, ?, 'SESSION', ?, ?, ?, 'STAGING', 'staged', ?, ?)",
                        operation, ManagedSessionStore.sessionScopeKey(candidate.tenantId(), candidate.sessionId()), scope,
                        candidate.inputId(), candidate.tenantId(), candidate.sessionId(), target, digest, request, now, now);
            }
        });
        PrWatchInjection saved = find(candidate.tenantId(), candidate.inputId()).orElseThrow(() ->
                new IllegalStateException("pr-watch injection receipt lost its operation"));
        if (!candidate.channelInstanceId().equals(saved.channelInstanceId())
                || !candidate.owner().equals(saved.owner())
                || !candidate.repo().equals(saved.repo())
                || candidate.prNumber() != saved.prNumber()
                || !candidate.transition().equals(saved.transition())
                || !candidate.headSha().equals(saved.headSha())
                || candidate.episode() != saved.episode()) {
            throw new IllegalStateException("pr-watch injection key collision");
        }
        return saved;
    }

    @Override
    public Optional<PrWatchInjection> find(String tenantId, String inputId) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(inputId, "inputId");
        List<PrWatchInjection> rows = jdbc.query(SELECT + " AND r.tenant_key = ? AND r.idempotency_digest = ?"
                        + " AND r.tenant_id = ? AND r.idempotency_key = ?", this::row,
                ManagedSchemaKeys.key(tenantId), ManagedSchemaKeys.key(inputId), tenantId, inputId);
        if (rows.size() > 1) {
            throw new IllegalStateException("pr-watch injection key collision");
        }
        return rows.stream().findFirst();
    }

    @Override
    public PrWatchInjection admit(String tenantId, String inputId) {
        ChannelStoreSupport.requireId(inputId, "inputId");
        PrWatchInjection old = find(tenantId, inputId).orElse(null);
        if (old == null) {
            return null;
        }
        String scope = ManagedSchemaKeys.key("CHANNEL", tenantId, old.channelInstanceId());
        String operation = ManagedSchemaKeys.operationKey(OperationKind.PR_WATCH_INJECT, scope,
                ManagedSchemaKeys.key(old.sessionId()), inputId);
        jdbc.update("UPDATE ma_operation SET state = 'admitted', phase = 'ADMITTED', result_json = ?,"
                        + " gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'PR_WATCH_INJECT' AND state = 'staged'",
                JSON.createObjectNode().put("inputId", inputId).toString(), databaseNow(), operation);
        return find(tenantId, inputId).orElse(null);
    }

    @Override
    public boolean releaseStaged(String tenantId, String inputId) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(inputId, "inputId");
        PrWatchInjection old = find(tenantId, inputId).orElse(null);
        if (old == null || !"staged".equals(old.state())) {
            return false;
        }
        String scope = ManagedSchemaKeys.key("CHANNEL", tenantId, old.channelInstanceId());
        String operation = ManagedSchemaKeys.operationKey(OperationKind.PR_WATCH_INJECT, scope,
                ManagedSchemaKeys.key(old.sessionId()), inputId);
        String receipt = ManagedSchemaKeys.receiptKey(ReceiptNamespace.PR_WATCH_INJECT, tenantId,
                ReceiptScope.CHANNEL, old.channelInstanceId(), inputId);
        Boolean released = transactions.execute(status -> {
            // The state guard keeps a concurrent admission from being released:
            // if the row slipped to admitted, leave both rows untouched.
            int ops = jdbc.update("DELETE FROM ma_operation WHERE operation_key = ?"
                    + " AND operation_kind = 'PR_WATCH_INJECT' AND state = 'staged'", operation);
            if (ops != 1) {
                return false;
            }
            jdbc.update("DELETE FROM ma_request_receipt WHERE receipt_key = ?"
                    + " AND namespace = 'PR_WATCH_INJECT'", receipt);
            return true;
        });
        return Boolean.TRUE.equals(released);
    }

    private PrWatchInjection row(java.sql.ResultSet row, int index) throws java.sql.SQLException {
        JsonNode body = JdbcManagedToolResultStore.parse(row.getString("request_json"));
        return new PrWatchInjection(row.getString("tenant_id"), row.getString("operation_id"),
                body.path("channelInstanceId").asText(), body.path("bindingId").asText(),
                row.getString("session_id"), body.path("owner").asText(), body.path("repo").asText(),
                body.path("prNumber").asLong(), body.path("transition").asText(), body.path("headSha").asText(),
                body.path("episode").asLong(), body.path("evidence").asText(), body.path("text").asText(),
                row.getString("state"), row.getLong("gmt_create"), row.getLong("gmt_modified"));
    }

    private long databaseNow() {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
    }

    private static void requireCandidate(PrWatchInjection candidate) {
        if (candidate == null) {
            throw new IllegalArgumentException("candidate is required");
        }
        ChannelStoreSupport.requireId(candidate.tenantId(), "tenantId");
        ChannelStoreSupport.requireId(candidate.channelInstanceId(), "channelInstanceId");
        ChannelStoreSupport.requireId(candidate.inputId(), "inputId");
        ChannelStoreSupport.requireId(candidate.bindingId(), "bindingId");
        ChannelStoreSupport.requireId(candidate.sessionId(), "sessionId");
        ChannelStoreSupport.requireId(candidate.owner(), "owner");
        ChannelStoreSupport.requireId(candidate.repo(), "repo");
        ChannelStoreSupport.requireId(candidate.transition(), "transition");
        ChannelStoreSupport.requireId(candidate.headSha(), "headSha");
        if (candidate.prNumber() < 1 || candidate.episode() < 1) {
            throw new IllegalArgumentException("prNumber and episode must be positive");
        }
        if (!INJECTION_STATES.contains(candidate.state())) {
            throw new IllegalArgumentException("unknown injection state");
        }
        if (candidate.evidence() == null || candidate.text() == null || candidate.text().isEmpty()) {
            throw new IllegalArgumentException("evidence and text are required");
        }
    }
}
