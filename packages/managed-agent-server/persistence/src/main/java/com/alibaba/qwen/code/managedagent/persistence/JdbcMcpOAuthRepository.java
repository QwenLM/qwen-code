package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.security.ProtectedSecret;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.List;

@Repository
public class JdbcMcpOAuthRepository implements McpOAuthRepository {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper json;
    private final SecretProtector secrets;

    public JdbcMcpOAuthRepository(
            @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            ObjectProvider<SecretProtector> secrets) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.json = json;
        this.secrets = secrets.getIfAvailable();
    }

    @Override
    public Attempt createAttempt(Attempt value) {
        return transaction.execute(
                status -> {
                    var workspace =
                            jdbc.queryForList(
                                    "SELECT state FROM ma_workspace WHERE tenant_id=? AND"
                                            + " workspace_id=? FOR UPDATE",
                                    String.class,
                                    value.scope().tenant(),
                                    value.scope().workspace());
                    if (workspace.size() != 1 || !"ACTIVE".equals(workspace.getFirst())) {
                        throw conflict("workspace_unavailable");
                    }
                    return createAttemptLocked(value);
                });
    }

    private Attempt createAttemptLocked(Attempt value) {
        requireEncryption();
        String scope = scope(value.scope());
        long now = System.currentTimeMillis();
        jdbc.update(
                "DELETE FROM ma_mcp_oauth_attempt WHERE scope_key=? AND expires_at_ms<?",
                scope,
                now - 86_400_000);
        try {
            Attempt existing = attempt(value.scope(), value.id());
            if (!value.requestDigest().equals(existing.requestDigest())) {
                throw conflict("idempotency_conflict");
            }
            return existing;
        } catch (ManagedAgentException missing) {
            if (missing.getStatus() != 404) {
                throw missing;
            }
        }
        Long count =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_mcp_oauth_attempt WHERE scope_key=? AND"
                                + " expires_at_ms>?",
                        Long.class,
                        scope,
                        now);
        if (count != null && count >= 32) {
            throw conflict("oauth_attempt_capacity");
        }
        ProtectedSecret protectedValue =
                protect("attempt", value.scope(), value.id(), value.secrets());
        try {
            jdbc.update(
                    "INSERT INTO ma_mcp_oauth_attempt"
                        + " (attempt_key,scope_key,tenant_id,workspace_id,actor_id,attempt_id,"
                        + "state_hash,nonce_hash,request_digest,state,expires_at_ms,binding_json,encryption_key_id,encrypted_values,gmt_create)"
                        + " VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,"
                            + ManagedSchemaTime.SQL_NOW
                            + ")",
                    key(value.scope(), value.id()),
                    scope,
                    value.scope().tenant(),
                    value.scope().workspace(),
                    value.scope().actor(),
                    value.id(),
                    value.stateHash(),
                    value.nonceHash(),
                    value.requestDigest(),
                    value.expiresAt(),
                    encode(value.binding()),
                    protectedValue.getKeyId(),
                    protectedValue.getCiphertext());
        } catch (DuplicateKeyException duplicate) {
            Attempt existing = attempt(value.scope(), value.id());
            if (!value.requestDigest().equals(existing.requestDigest())) {
                throw conflict("idempotency_conflict");
            }
            return existing;
        }
        return attempt(value.scope(), value.id());
    }

    @Override
    public Attempt attempt(Scope scope, String id) {
        var rows =
                jdbc.query(
                        "SELECT * FROM ma_mcp_oauth_attempt WHERE attempt_key=? AND scope_key=?",
                        (row, index) -> readAttempt(row),
                        key(scope, id),
                        scope(scope));
        if (rows.size() != 1) {
            throw missing();
        }
        return rows.getFirst();
    }

    @Override
    public Attempt receiveCode(String stateHash, String issuer, String code, long now) {
        return transaction.execute(
                status -> {
                    var rows =
                            jdbc.query(
                                    "SELECT * FROM ma_mcp_oauth_attempt WHERE state_hash=? FOR"
                                            + " UPDATE",
                                    (row, index) -> readAttempt(row),
                                    stateHash);
                    if (rows.size() != 1) {
                        throw missing();
                    }
                    Attempt value = rows.getFirst();
                    if (value.expiresAt() <= now
                            || !"pending".equals(value.state())
                            || issuer != null
                                    && !issuer.equals(value.binding().path("issuer").asText())) {
                        throw conflict("oauth_callback_invalid");
                    }
                    var payload = value.secrets().deepCopy();
                    ((com.fasterxml.jackson.databind.node.ObjectNode) payload).put("code", code);
                    ProtectedSecret encrypted =
                            protect("attempt", value.scope(), value.id(), payload);
                    jdbc.update(
                            "UPDATE ma_mcp_oauth_attempt SET"
                                + " state='code_received',encryption_key_id=?,encrypted_values=?"
                                + " WHERE attempt_key=?",
                            encrypted.getKeyId(),
                            encrypted.getCiphertext(),
                            key(value.scope(), value.id()));
                    return attempt(value.scope(), value.id());
                });
    }

    @Override
    public void rejectAttempt(String stateHash, long now) {
        jdbc.update(
                "UPDATE ma_mcp_oauth_attempt SET state='failed' WHERE state_hash=? AND"
                        + " state='pending' AND expires_at_ms>?",
                stateHash,
                now);
    }

    @Override
    public Attempt claimAttempt(Scope scope, String id, String nonceHash, long now) {
        Attempt value = attempt(scope, id);
        if (!MessageDigest.isEqual(
                value.nonceHash().getBytes(StandardCharsets.US_ASCII),
                nonceHash.getBytes(StandardCharsets.US_ASCII))) {
            throw missing();
        }
        if ("completed".equals(value.state())) {
            return value;
        }
        if (value.expiresAt() <= now
                || jdbc.update(
                                "UPDATE ma_mcp_oauth_attempt SET state='exchanging' WHERE"
                                        + " attempt_key=? AND state='code_received' AND"
                                        + " expires_at_ms>?",
                                key(scope, id),
                                now)
                        != 1) {
            throw conflict("oauth_authorization_unavailable");
        }
        return attempt(scope, id);
    }

    @Override
    public Credential completeAttempt(
            Scope scope, String id, JsonNode tokens, long expiresAt, long now) {
        return transaction.execute(
                status -> {
                    lockWorkspace(scope);
                    var rows =
                            jdbc.query(
                                    "SELECT * FROM ma_mcp_oauth_attempt WHERE attempt_key=? AND"
                                            + " scope_key=? FOR UPDATE",
                                    (row, index) -> readAttempt(row),
                                    key(scope, id),
                                    scope(scope));
                    if (rows.size() != 1) {
                        throw missing();
                    }
                    Attempt attempt = rows.getFirst();
                    if ("completed".equals(attempt.state())) {
                        return credential(scope, attempt.credentialId());
                    }
                    if (!"exchanging".equals(attempt.state()) || attempt.expiresAt() <= now) {
                        throw conflict("oauth_authorization_unavailable");
                    }
                    String credentialId = McpOAuthRepository.credentialId(scope, attempt.binding());
                    var generations =
                            jdbc.queryForList(
                                    "SELECT generation FROM ma_mcp_credential WHERE"
                                        + " credential_key=? FOR UPDATE",
                                    Long.class,
                                    key(scope, credentialId));
                    long observed = attempt.binding().path("credentialEpoch").asLong();
                    if ((generations.isEmpty() ? 0 : generations.getFirst()) != observed) {
                        throw conflict("oauth_credential_generation_conflict");
                    }
                    ProtectedSecret encrypted = protect("credential", scope, credentialId, tokens);
                    if (generations.isEmpty()) {
                        jdbc.update(
                                "INSERT INTO ma_mcp_credential"
                                    + " (credential_key,scope_key,tenant_id,workspace_id,actor_id,credential_id,"
                                    + "binding_json,generation,state,expires_at_ms,encryption_key_id,encrypted_values,gmt_create)"
                                    + " VALUES (?,?,?,?,?,?,?,1,'active',?,?,?,"
                                        + ManagedSchemaTime.SQL_NOW
                                        + ")",
                                key(scope, credentialId),
                                scope(scope),
                                scope.tenant(),
                                scope.workspace(),
                                scope.actor(),
                                credentialId,
                                encode(attempt.binding()),
                                expiresAt,
                                encrypted.getKeyId(),
                                encrypted.getCiphertext());
                    } else {
                        jdbc.update(
                                "UPDATE ma_mcp_credential SET"
                                    + " binding_json=?,generation=generation+1,state='active',expires_at_ms=?,encryption_key_id=?,encrypted_values=?,refresh_lease=NULL,refresh_until_ms=NULL"
                                    + " WHERE credential_key=? AND generation=?",
                                encode(attempt.binding()),
                                expiresAt,
                                encrypted.getKeyId(),
                                encrypted.getCiphertext(),
                                key(scope, credentialId),
                                observed);
                    }
                    ProtectedSecret cleared =
                            protect("attempt", scope, id, json.createObjectNode());
                    jdbc.update(
                            "UPDATE ma_mcp_oauth_attempt SET"
                                + " state='completed',credential_id=?,encryption_key_id=?,encrypted_values=?"
                                + " WHERE attempt_key=?",
                            credentialId,
                            cleared.getKeyId(),
                            cleared.getCiphertext(),
                            key(scope, id));
                    return credential(scope, credentialId);
                });
    }

    @Override
    public void failAttempt(Scope scope, String id) {
        ProtectedSecret cleared = protect("attempt", scope, id, json.createObjectNode());
        jdbc.update(
                "UPDATE ma_mcp_oauth_attempt SET"
                    + " state='failed',encryption_key_id=?,encrypted_values=? WHERE attempt_key=?"
                    + " AND scope_key=? AND state='exchanging'",
                cleared.getKeyId(),
                cleared.getCiphertext(),
                key(scope, id),
                scope(scope));
    }

    @Override
    public Credential credential(Scope scope, String id) {
        var rows =
                jdbc.query(
                        "SELECT * FROM ma_mcp_credential WHERE credential_key=? AND scope_key=?",
                        (row, index) -> readCredential(row),
                        key(scope, id),
                        scope(scope));
        if (rows.size() != 1) {
            throw missing();
        }
        return rows.getFirst();
    }

    @Override
    public Credential findCredential(String tenant, String workspace, String id) {
        var rows =
                jdbc.query(
                        "SELECT * FROM ma_mcp_credential WHERE tenant_id=? AND workspace_id=? AND"
                                + " credential_id=?",
                        (row, index) -> readCredential(row),
                        tenant,
                        workspace,
                        id);
        if (rows.size() != 1) {
            throw missing();
        }
        return rows.getFirst();
    }

    @Override
    public List<Credential> credentials(Scope scope) {
        return jdbc.query(
                "SELECT * FROM ma_mcp_credential WHERE scope_key=? ORDER BY gmt_create DESC LIMIT"
                        + " 256",
                (row, index) -> readCredential(row),
                scope(scope));
    }

    @Override
    public Credential claimRefresh(
            Scope scope, String id, long generation, String lease, long now, long until) {
        int changed =
                jdbc.update(
                        "UPDATE ma_mcp_credential SET"
                                + " state='refreshing',refresh_lease=?,refresh_until_ms=? WHERE"
                                + " credential_key=? AND scope_key=? AND generation=? AND"
                                + " state='active'",
                        lease,
                        until,
                        key(scope, id),
                        scope(scope),
                        generation);
        if (changed != 1) {
            throw conflict("oauth_authorization_unavailable");
        }
        return credential(scope, id);
    }

    @Override
    public Credential completeRefresh(
            Scope scope,
            String id,
            long generation,
            String lease,
            JsonNode tokens,
            long expiresAt) {
        ProtectedSecret encrypted = protect("credential", scope, id, tokens);
        int changed =
                jdbc.update(
                        "UPDATE ma_mcp_credential SET"
                            + " state='active',expires_at_ms=?,encryption_key_id=?,encrypted_values=?,"
                            + " refresh_lease=NULL,refresh_until_ms=NULL WHERE credential_key=? AND"
                            + " scope_key=? AND generation=? AND state='refreshing' AND"
                            + " refresh_lease=? AND refresh_until_ms>?",
                        expiresAt,
                        encrypted.getKeyId(),
                        encrypted.getCiphertext(),
                        key(scope, id),
                        scope(scope),
                        generation,
                        lease,
                        System.currentTimeMillis());
        if (changed != 1) {
            throw conflict("oauth_authorization_unavailable");
        }
        return credential(scope, id);
    }

    @Override
    public void failRefresh(Scope scope, String id, long generation, String lease) {
        jdbc.update(
                "UPDATE ma_mcp_credential SET"
                    + " state='reauthorization_required',refresh_lease=NULL,refresh_until_ms=NULL"
                    + " WHERE credential_key=? AND scope_key=? AND generation=? AND"
                    + " state='refreshing' AND refresh_lease=?",
                key(scope, id),
                scope(scope),
                generation,
                lease);
    }

    @Override
    public Credential revoke(Scope scope, String id, long generation) {
        return transaction.execute(
                status -> {
                    lockWorkspace(scope);
                    return revokeLocked(scope, id, generation);
                });
    }

    private Credential revokeLocked(Scope scope, String id, long generation) {
        Credential current = credential(scope, id);
        if ("revoked".equals(current.state())) {
            return current;
        }
        ProtectedSecret cleared = protect("credential", scope, id, json.createObjectNode());
        if (jdbc.update(
                        "UPDATE ma_mcp_credential SET"
                            + " state='revoked',generation=generation+1,encryption_key_id=?,encrypted_values=?,"
                            + " refresh_lease=NULL,refresh_until_ms=NULL WHERE credential_key=? AND"
                            + " scope_key=? AND generation=?",
                        cleared.getKeyId(),
                        cleared.getCiphertext(),
                        key(scope, id),
                        scope(scope),
                        generation)
                != 1) {
            throw conflict("oauth_credential_generation_conflict");
        }
        return credential(scope, id);
    }

    private void lockWorkspace(Scope scope) {
        var rows =
                jdbc.queryForList(
                        "SELECT state FROM ma_workspace WHERE tenant_id=? AND workspace_id=? FOR"
                            + " UPDATE",
                        String.class,
                        scope.tenant(),
                        scope.workspace());
        if (rows.size() != 1 || !"ACTIVE".equals(rows.getFirst())) {
            throw conflict("workspace_unavailable");
        }
    }

    private Attempt readAttempt(ResultSet row) throws SQLException {
        Scope scope =
                new Scope(
                        row.getString("tenant_id"),
                        row.getString("workspace_id"),
                        row.getString("actor_id"));
        String id = row.getString("attempt_id");
        return new Attempt(
                id,
                scope,
                row.getString("state_hash"),
                row.getString("nonce_hash"),
                row.getString("request_digest"),
                row.getString("state"),
                row.getLong("expires_at_ms"),
                parse(row.getString("binding_json")),
                unprotect("attempt", scope, id, row),
                row.getString("credential_id"));
    }

    private Credential readCredential(ResultSet row) throws SQLException {
        Scope scope =
                new Scope(
                        row.getString("tenant_id"),
                        row.getString("workspace_id"),
                        row.getString("actor_id"));
        String id = row.getString("credential_id");
        return new Credential(
                id,
                scope,
                parse(row.getString("binding_json")),
                row.getLong("generation"),
                row.getString("state"),
                row.getLong("expires_at_ms"),
                unprotect("credential", scope, id, row),
                row.getString("refresh_lease"),
                row.getObject("refresh_until_ms", Long.class));
    }

    private ProtectedSecret protect(String kind, Scope scope, String id, JsonNode value) {
        requireEncryption();
        byte[] bytes = encode(value).getBytes(StandardCharsets.UTF_8);
        try {
            return secrets.protect(context(kind, scope, id), bytes);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private JsonNode unprotect(String kind, Scope scope, String id, ResultSet row)
            throws SQLException {
        requireEncryption();
        byte[] bytes =
                secrets.unprotect(
                        context(kind, scope, id),
                        new ProtectedSecret(
                                row.getString("encryption_key_id"),
                                row.getString("encrypted_values")));
        try {
            return parse(new String(bytes, StandardCharsets.UTF_8));
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private String context(String kind, Scope scope, String id) {
        return "managed-mcp-oauth:" + kind + ":" + key(scope, id);
    }

    private static String scope(Scope scope) {
        return ManagedSchemaKeys.key(scope.tenant(), scope.workspace(), scope.actor());
    }

    private static String key(Scope scope, String id) {
        return ManagedSchemaKeys.key(scope.tenant(), scope.workspace(), scope.actor(), id);
    }

    private String encode(JsonNode value) {
        try {
            return json.writeValueAsString(value);
        } catch (IOException invalid) {
            throw new IllegalArgumentException("Invalid OAuth state", invalid);
        }
    }

    private JsonNode parse(String value) {
        try {
            return json.readTree(value);
        } catch (IOException invalid) {
            throw new IllegalStateException("Invalid saved OAuth state", invalid);
        }
    }

    private void requireEncryption() {
        if (secrets == null) {
            throw conflict("oauth_encryption_unavailable");
        }
    }

    private static ManagedAgentException missing() {
        return new ManagedAgentException(404, "oauth_not_found", "OAuth state was not found.");
    }

    private static ManagedAgentException conflict(String code) {
        return new ManagedAgentException(409, code, "OAuth authorization requires attention.");
    }
}
