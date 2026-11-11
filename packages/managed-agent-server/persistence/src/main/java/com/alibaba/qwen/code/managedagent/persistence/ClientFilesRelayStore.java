package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Binding;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.managedagent.repository.ClientFilesRelay;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;

@Repository
@Transactional(transactionManager = "managedAgentTransactionManager")
public class ClientFilesRelayStore implements ClientFilesRelay {
    private static final String BINDING_COLUMNS =
            "tenant_id,session_id,actor_id,generation,state,server_id,token_hash,"
                    + "connection_id,expires_at,gmt_create,gmt_modified";
    private static final String REQUEST_COLUMNS =
            "request_id,binding_generation,payload_json,state,response_json,error_code,"
                    + "expires_at,gmt_create,gmt_modified";
    private static final RowMapper<Binding> BINDING_MAPPER = (rs, rowNum) -> new Binding(
            text(rs, "tenant_id"), text(rs, "session_id"), text(rs, "actor_id"),
            rs.getLong("generation"), rs.getString("state"), rs.getString("server_id"),
            rs.getString("token_hash"), rs.getLong("expires_at"),
            rs.getLong("gmt_create"), rs.getLong("gmt_modified"), rs.getString("connection_id"));
    private static final RowMapper<QueuedRequest> REQUEST_MAPPER = (rs, rowNum) -> new QueuedRequest(
            rs.getString("request_id"), rs.getLong("binding_generation"),
            rs.getString("payload_json"), rs.getString("state"),
            rs.getString("response_json"), rs.getString("error_code"),
            rs.getLong("expires_at"), rs.getLong("gmt_create"), rs.getLong("gmt_modified"));

    private final JdbcTemplate jdbc;

    public ClientFilesRelayStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public Binding register(String tenantId, String sessionId, String actorId, String serverId,
            String tokenHash, long expiresAt, long now, String connectionId) {
        String scope = ManagedSchemaKeys.key(tenantId, sessionId);
        // The read is locked so concurrent registrations serialize their
        // generation increments instead of losing an update.
        Binding previous = findByScopeForUpdate(scope);
        if (previous == null) {
            try {
                jdbc.update("INSERT INTO ma_client_files_binding (session_scope_key,"
                                + BINDING_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        scope, ManagedSchemaKeys.identity(tenantId),
                        ManagedSchemaKeys.identity(sessionId), ManagedSchemaKeys.identity(actorId),
                        1L, ClientFilesModels.STATE_ACTIVE, serverId, tokenHash, connectionId,
                        expiresAt, now, now);
                return new Binding(tenantId, sessionId, actorId, 1L, ClientFilesModels.STATE_ACTIVE,
                        serverId, tokenHash, expiresAt, now, now, connectionId);
            } catch (org.springframework.dao.DuplicateKeyException raced) {
                // A concurrent first registration won the insert; advance it.
                previous = findByScopeForUpdate(scope);
            }
        }
        long generation = previous.generation() + 1;
        jdbc.update("UPDATE ma_client_files_binding SET actor_id=?,generation=?,state=?,"
                        + "server_id=?,token_hash=?,connection_id=?,expires_at=?,gmt_modified=?"
                        + " WHERE session_scope_key=?",
                ManagedSchemaKeys.identity(actorId), generation, ClientFilesModels.STATE_ACTIVE,
                serverId, tokenHash, connectionId, expiresAt, now, scope);
        return new Binding(tenantId, sessionId, actorId, generation, ClientFilesModels.STATE_ACTIVE,
                serverId, tokenHash, expiresAt, previous.createdAt(), now, connectionId);
    }

    @Override
    public boolean restore(String tenantId, String sessionId, long failedGeneration,
            Binding previous, long now) {
        String scope = ManagedSchemaKeys.key(tenantId, sessionId);
        // Locked, and fenced on the failed attempt still owning the active
        // binding: a newer registration or an unregister that already committed
        // must not be clobbered or reopened by a late compensation.
        Binding current = findByScopeForUpdate(scope);
        if (current == null || current.generation() != failedGeneration || !current.active()) {
            return false;
        }
        // Rewind to the generation the previous client's downlink was opened
        // with, so that client keeps draining instead of being refused 409.
        // The next registration re-allocates the failed attempt's generation,
        // so drop the failed attempt's retained request rows first — otherwise
        // a fresh client's restarted JSON-RPC ids would attach to them.
        jdbc.update("DELETE FROM ma_client_files_request WHERE session_scope_key=?"
                + " AND binding_generation=?", scope, failedGeneration);
        jdbc.update("UPDATE ma_client_files_binding SET actor_id=?,generation=?,state=?,"
                        + "server_id=?,token_hash=?,connection_id=?,expires_at=?,gmt_modified=?"
                        + " WHERE session_scope_key=?",
                ManagedSchemaKeys.identity(previous.actorId()), previous.generation(),
                ClientFilesModels.STATE_ACTIVE, previous.serverId(), previous.tokenHash(),
                previous.connectionId(), previous.expiresAt(), now, scope);
        return true;
    }

    @Override
    public Binding find(String tenantId, String sessionId) {
        return findByScope(ManagedSchemaKeys.key(tenantId, sessionId));
    }

    @Override
    public Binding findBySession(String sessionId) {
        List<Binding> rows = jdbc.query("SELECT " + BINDING_COLUMNS
                + " FROM ma_client_files_binding WHERE session_id=?", BINDING_MAPPER,
                ManagedSchemaKeys.identity(sessionId));
        return rows.isEmpty() ? null : rows.get(0);
    }

    @Override
    public boolean close(String tenantId, String sessionId, long expectedGeneration, long now) {
        return jdbc.update("UPDATE ma_client_files_binding SET state=?,gmt_modified=?"
                        + " WHERE session_scope_key=? AND generation=? AND state=?",
                ClientFilesModels.STATE_CLOSED, now, ManagedSchemaKeys.key(tenantId, sessionId),
                expectedGeneration, ClientFilesModels.STATE_ACTIVE) > 0;
    }

    @Override
    public void enqueue(String tenantId, String sessionId, long generation, String requestId,
            String payloadJson, long expiresAt, long now) {
        String scope = ManagedSchemaKeys.key(tenantId, sessionId);
        // The key includes the generation: a re-registered Harness restarts
        // its JSON-RPC ids, which must not attach to the old generation's
        // rows (the poll reads by generation).
        jdbc.update("INSERT INTO ma_client_files_request (request_key,session_scope_key,"
                        + "tenant_id,session_id,binding_generation,request_id,payload_json,state,"
                        + "expires_at,gmt_create,gmt_modified) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ManagedSchemaKeys.key(scope, generation + ":" + requestId), scope,
                ManagedSchemaKeys.identity(tenantId), ManagedSchemaKeys.identity(sessionId),
                generation, requestId, payloadJson, ClientFilesModels.REQUEST_QUEUED,
                expiresAt, now, now);
    }

    @Override
    public int queuedCount(String tenantId, String sessionId, long generation, long now) {
        // An expired-but-unwalked row must not occupy a queue slot, so the
        // depth check excludes rows past their deadline as well as settled ones.
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request"
                        + " WHERE session_scope_key=? AND binding_generation=? AND state=?"
                        + " AND expires_at>?",
                Integer.class, ManagedSchemaKeys.key(tenantId, sessionId), generation,
                ClientFilesModels.REQUEST_QUEUED, now);
        return count == null ? 0 : count;
    }

    @Override
    public List<QueuedRequest> queued(String tenantId, String sessionId, long generation, int limit,
            long now) {
        // Enforce the deadline at delivery, not only at the periodic sweep: a
        // downlink resuming after a request expired must not execute work the
        // Runtime has already been told failed.
        return jdbc.query("SELECT " + REQUEST_COLUMNS + " FROM ma_client_files_request"
                        + " WHERE session_scope_key=? AND binding_generation=? AND state=?"
                        + " AND expires_at>? ORDER BY id LIMIT ?",
                REQUEST_MAPPER, ManagedSchemaKeys.key(tenantId, sessionId), generation,
                ClientFilesModels.REQUEST_QUEUED, now, limit);
    }

    @Override
    public QueuedRequest request(String tenantId, String sessionId, long generation, String requestId) {
        // Resolve by the unique request_key (the same derivation enqueue uses)
        // so the waiter poller hits the business-key index instead of scanning
        // the Session's whole request history on every tick.
        String requestKey = ManagedSchemaKeys.key(
                ManagedSchemaKeys.key(tenantId, sessionId), generation + ":" + requestId);
        List<QueuedRequest> rows = jdbc.query("SELECT " + REQUEST_COLUMNS
                        + " FROM ma_client_files_request WHERE request_key=?",
                REQUEST_MAPPER, requestKey);
        return rows.isEmpty() ? null : rows.get(0);
    }

    @Override
    public boolean answer(String tenantId, String sessionId, long generation, String requestId,
            String responseJson, long now) {
        // A late answer after the deadline must not settle work the Runtime has
        // already been told failed.
        return jdbc.update("UPDATE ma_client_files_request SET state=?,response_json=?,gmt_modified=?"
                        + " WHERE session_scope_key=? AND binding_generation=? AND request_id=?"
                        + " AND state=? AND expires_at>?",
                ClientFilesModels.REQUEST_ANSWERED, responseJson, now,
                ManagedSchemaKeys.key(tenantId, sessionId), generation, requestId,
                ClientFilesModels.REQUEST_QUEUED, now) > 0;
    }

    @Override
    public boolean fail(String tenantId, String sessionId, long generation, String requestId,
            String errorCode, long now) {
        return jdbc.update("UPDATE ma_client_files_request SET state=?,error_code=?,gmt_modified=?"
                        + " WHERE session_scope_key=? AND binding_generation=? AND request_id=?"
                        + " AND state=? AND expires_at>?",
                ClientFilesModels.REQUEST_FAILED, errorCode, now,
                ManagedSchemaKeys.key(tenantId, sessionId), generation, requestId,
                ClientFilesModels.REQUEST_QUEUED, now) > 0;
    }

    @Override
    public int failQueued(String tenantId, String sessionId, long generation, String errorCode, long now) {
        return jdbc.update("UPDATE ma_client_files_request SET state=?,error_code=?,gmt_modified=?"
                        + " WHERE session_scope_key=? AND binding_generation=? AND state=?",
                ClientFilesModels.REQUEST_FAILED, errorCode, now,
                ManagedSchemaKeys.key(tenantId, sessionId), generation,
                ClientFilesModels.REQUEST_QUEUED);
    }

    @Override
    public int expireBefore(long now, int limit) {
        return jdbc.update("UPDATE ma_client_files_request SET state=?,gmt_modified=?"
                        + " WHERE state=? AND expires_at<=? LIMIT ?",
                ClientFilesModels.REQUEST_EXPIRED, now, ClientFilesModels.REQUEST_QUEUED, now, limit);
    }

    @Override
    public int closeExpiredBindings(long now, int limit) {
        return jdbc.update("UPDATE ma_client_files_binding SET state=?,gmt_modified=?"
                        + " WHERE state=? AND expires_at<=? LIMIT ?",
                ClientFilesModels.STATE_CLOSED, now, ClientFilesModels.STATE_ACTIVE, now, limit);
    }

    @Override
    public int deleteSettledBefore(long cutoff, int limit) {
        return jdbc.update("DELETE FROM ma_client_files_request WHERE state IN (?,?,?)"
                        + " AND gmt_modified<? LIMIT ?",
                ClientFilesModels.REQUEST_ANSWERED, ClientFilesModels.REQUEST_FAILED,
                ClientFilesModels.REQUEST_EXPIRED, cutoff, limit);
    }

    @Override
    public void deleteSession(String tenantId, String sessionId) {
        String scope = ManagedSchemaKeys.key(tenantId, sessionId);
        jdbc.update("DELETE FROM ma_client_files_request WHERE session_scope_key=?", scope);
        jdbc.update("DELETE FROM ma_client_files_binding WHERE session_scope_key=?", scope);
    }

    private Binding findByScope(String scope) {
        List<Binding> rows = jdbc.query("SELECT " + BINDING_COLUMNS
                + " FROM ma_client_files_binding WHERE session_scope_key=?", BINDING_MAPPER, scope);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private Binding findByScopeForUpdate(String scope) {
        List<Binding> rows = jdbc.query("SELECT " + BINDING_COLUMNS
                + " FROM ma_client_files_binding WHERE session_scope_key=? FOR UPDATE",
                BINDING_MAPPER, scope);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static String text(ResultSet rs, String column) throws SQLException {
        byte[] value = rs.getBytes(column);
        return value == null ? null : new String(value, StandardCharsets.UTF_8);
    }
}
