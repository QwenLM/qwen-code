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
                    + "expires_at,gmt_create,gmt_modified";
    private static final String REQUEST_COLUMNS =
            "request_id,binding_generation,payload_json,state,response_json,error_code,"
                    + "expires_at,gmt_create,gmt_modified";
    private static final RowMapper<Binding> BINDING_MAPPER = (rs, rowNum) -> new Binding(
            text(rs, "tenant_id"), text(rs, "session_id"), text(rs, "actor_id"),
            rs.getLong("generation"), rs.getString("state"), rs.getString("server_id"),
            rs.getString("token_hash"), rs.getLong("expires_at"),
            rs.getLong("gmt_create"), rs.getLong("gmt_modified"));
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
            String tokenHash, long expiresAt, long now) {
        String scope = ManagedSchemaKeys.key(tenantId, sessionId);
        // The read is locked so concurrent registrations serialize their
        // generation increments instead of losing an update.
        Binding previous = findByScopeForUpdate(scope);
        if (previous == null) {
            try {
                jdbc.update("INSERT INTO ma_client_files_binding (session_scope_key,"
                                + BINDING_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        scope, ManagedSchemaKeys.identity(tenantId),
                        ManagedSchemaKeys.identity(sessionId), ManagedSchemaKeys.identity(actorId),
                        1L, ClientFilesModels.STATE_ACTIVE, serverId, tokenHash, expiresAt, now, now);
                return new Binding(tenantId, sessionId, actorId, 1L, ClientFilesModels.STATE_ACTIVE,
                        serverId, tokenHash, expiresAt, now, now);
            } catch (org.springframework.dao.DuplicateKeyException raced) {
                // A concurrent first registration won the insert; advance it.
                previous = findByScopeForUpdate(scope);
            }
        }
        long generation = previous.generation() + 1;
        jdbc.update("UPDATE ma_client_files_binding SET actor_id=?,generation=?,state=?,"
                        + "server_id=?,token_hash=?,expires_at=?,gmt_modified=? WHERE session_scope_key=?",
                ManagedSchemaKeys.identity(actorId), generation, ClientFilesModels.STATE_ACTIVE,
                serverId, tokenHash, expiresAt, now, scope);
        return new Binding(tenantId, sessionId, actorId, generation, ClientFilesModels.STATE_ACTIVE,
                serverId, tokenHash, expiresAt, previous.createdAt(), now);
    }

    @Override
    public void restore(String tenantId, String sessionId, Binding previous, long now) {
        String scope = ManagedSchemaKeys.key(tenantId, sessionId);
        // Locked so a concurrent re-registration cannot interleave with the
        // compensation and leave the binding fenced to a refused credential.
        findByScopeForUpdate(scope);
        jdbc.update("UPDATE ma_client_files_binding SET actor_id=?,generation=?,state=?,"
                        + "server_id=?,token_hash=?,expires_at=?,gmt_modified=? WHERE session_scope_key=?",
                ManagedSchemaKeys.identity(previous.actorId()), previous.generation(),
                ClientFilesModels.STATE_ACTIVE, previous.serverId(), previous.tokenHash(),
                previous.expiresAt(), now, scope);
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
    public int queuedCount(String tenantId, String sessionId, long generation) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request"
                        + " WHERE session_scope_key=? AND binding_generation=? AND state=?",
                Integer.class, ManagedSchemaKeys.key(tenantId, sessionId), generation,
                ClientFilesModels.REQUEST_QUEUED);
        return count == null ? 0 : count;
    }

    @Override
    public List<QueuedRequest> queued(String tenantId, String sessionId, long generation, int limit) {
        return jdbc.query("SELECT " + REQUEST_COLUMNS + " FROM ma_client_files_request"
                        + " WHERE session_scope_key=? AND binding_generation=? AND state=?"
                        + " ORDER BY id LIMIT ?",
                REQUEST_MAPPER, ManagedSchemaKeys.key(tenantId, sessionId), generation,
                ClientFilesModels.REQUEST_QUEUED, limit);
    }

    @Override
    public QueuedRequest request(String tenantId, String sessionId, long generation, String requestId) {
        List<QueuedRequest> rows = jdbc.query("SELECT " + REQUEST_COLUMNS
                        + " FROM ma_client_files_request WHERE session_scope_key=?"
                        + " AND binding_generation=? AND request_id=?",
                REQUEST_MAPPER, ManagedSchemaKeys.key(tenantId, sessionId), generation, requestId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    @Override
    public boolean answer(String tenantId, String sessionId, long generation, String requestId,
            String responseJson, long now) {
        return jdbc.update("UPDATE ma_client_files_request SET state=?,response_json=?,gmt_modified=?"
                        + " WHERE session_scope_key=? AND binding_generation=? AND request_id=? AND state=?",
                ClientFilesModels.REQUEST_ANSWERED, responseJson, now,
                ManagedSchemaKeys.key(tenantId, sessionId), generation, requestId,
                ClientFilesModels.REQUEST_QUEUED) > 0;
    }

    @Override
    public boolean fail(String tenantId, String sessionId, long generation, String requestId,
            String errorCode, long now) {
        return jdbc.update("UPDATE ma_client_files_request SET state=?,error_code=?,gmt_modified=?"
                        + " WHERE session_scope_key=? AND binding_generation=? AND request_id=? AND state=?",
                ClientFilesModels.REQUEST_FAILED, errorCode, now,
                ManagedSchemaKeys.key(tenantId, sessionId), generation, requestId,
                ClientFilesModels.REQUEST_QUEUED) > 0;
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
