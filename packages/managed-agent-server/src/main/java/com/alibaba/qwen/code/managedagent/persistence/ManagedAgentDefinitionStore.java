package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Tenant-scoped AgentDefinition revisions (D8a). Revisions are append-only:
 * an update adds the next revision unless its content digest equals the
 * latest one, and no revision is ever rewritten. Each create or update
 * command is recorded under its Idempotency-Key, so a replay returns the
 * revision it produced the first time.
 */
@Repository
public class ManagedAgentDefinitionStore {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final RequestDigests digests;

    public ManagedAgentDefinitionStore(JdbcTemplate jdbc, RequestDigests digests) {
        this.jdbc = jdbc;
        this.digests = digests;
    }

    public record DefinitionRevision(String agentId, long revision,
            String digest, String definitionJson, long createdAt) {
    }

    public record Admission(DefinitionRevision revision, boolean replayed) {
    }

    /**
     * A concurrent request committed first. The losing transaction rolls
     * back; the caller then reads the committed command and replays it when
     * it is the same request, or answers {@link #code()}.
     */
    public static final class ConcurrentWriteException
            extends RuntimeException {
        private final String code;

        public ConcurrentWriteException(String code, String message) {
            super(message);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Creates a definition with revision 1 under a new agent ID. */
    @Transactional
    public Admission create(String tenantId, String idempotencyKey,
            String requestDigest, String agentId, String digest,
            String definitionJson, long now) {
        Optional<Admission> replay = replay(tenantId, idempotencyKey,
                requestDigest);
        if (replay.isPresent()) {
            return replay.get();
        }
        DefinitionRevision created = new DefinitionRevision(agentId, 1,
                digest, definitionJson, now);
        insertRevision(tenantId, created);
        return record(tenantId, idempotencyKey, requestDigest, created, now);
    }

    /**
     * Adds the next revision of an existing definition. Content equal to the
     * latest revision adds nothing and answers with that revision.
     */
    @Transactional
    public Admission update(String tenantId, String idempotencyKey,
            String requestDigest, String agentId, String digest,
            String definitionJson, long now) {
        Optional<Admission> replay = replay(tenantId, idempotencyKey,
                requestDigest);
        if (replay.isPresent()) {
            return replay.get();
        }
        DefinitionRevision latest = latest(tenantId, agentId)
                .orElseThrow(ManagedAgentDefinitionStore::notFound);
        DefinitionRevision result = latest;
        if (!latest.digest().equals(digest)) {
            result = new DefinitionRevision(agentId, latest.revision() + 1,
                    digest, definitionJson, now);
            try {
                insertRevision(tenantId, result);
            } catch (DuplicateKeyException error) {
                // A concurrent update took this revision number first. The
                // command was not recorded, so the same key can be retried.
                throw new ConcurrentWriteException("agent_revision_conflict",
                        "The agent definition changed concurrently;"
                                + " retry the update.");
            }
        }
        return record(tenantId, idempotencyKey, requestDigest, result, now);
    }

    public Map<String, Object> pinnedContent(SessionRecord session) {
        DefinitionRevision revision = find(session.tenantId(),
                session.agentId(), Long.parseLong(session.agentRevision()))
                .orElseThrow(ManagedAgentDefinitionStore::notFound);
        Map<String, Object> content;
        try {
            content = JSON.readValue(revision.definitionJson(),
                    new TypeReference<Map<String, Object>>() { });
        } catch (Exception error) {
            throw new IllegalStateException("Invalid pinned definition", error);
        }
        if (!revision.digest().equals(session.agentDefinitionDigest())
                || !digests.digest(content)
                        .equals("sha256:" + session.agentDefinitionDigest())) {
            throw new ManagedAgentException(HttpStatus.CONFLICT,
                    "hosted_agent_definition_conflict",
                    "The pinned agent definition digest does not match.");
        }
        return content;
    }

    public Optional<DefinitionRevision> latest(String tenantId,
            String agentId) {
        return first(jdbc.query("SELECT agent_id, revision, digest,"
                + " definition_json, gmt_create FROM ma_agent_definition"
                + " WHERE tenant_id = ? AND agent_id = ?"
                + " ORDER BY revision DESC LIMIT 1",
                ManagedAgentDefinitionStore::row, tenantId, agentId));
    }

    /**
     * The latest revision read inside the caller's transaction with the
     * agent's rows write-locked (D8b): a Session pinned to "latest" cannot
     * interleave with a concurrent update writing that same next revision.
     * FOR UPDATE stands for both engines: H2 has no FOR SHARE.
     */
    public Optional<DefinitionRevision> latestForUpdate(String tenantId,
            String agentId) {
        return first(jdbc.query("SELECT agent_id, revision, digest,"
                + " definition_json, gmt_create FROM ma_agent_definition"
                + " WHERE tenant_id = ? AND agent_id = ?"
                + " ORDER BY revision DESC LIMIT 1 FOR UPDATE",
                ManagedAgentDefinitionStore::row, tenantId, agentId));
    }

    public Optional<DefinitionRevision> find(String tenantId, String agentId,
            long revision) {
        return first(jdbc.query("SELECT agent_id, revision, digest,"
                + " definition_json, gmt_create FROM ma_agent_definition"
                + " WHERE tenant_id = ? AND agent_id = ? AND revision = ?",
                ManagedAgentDefinitionStore::row, tenantId, agentId,
                revision));
    }

    /**
     * Reads the command a concurrent request committed under this key. A
     * different request answers {@code 409 idempotency_conflict}.
     */
    public Optional<Admission> replayCommitted(String tenantId,
            String idempotencyKey, String requestDigest) {
        return replay(tenantId, idempotencyKey, requestDigest);
    }

    private Optional<Admission> replay(String tenantId,
            String idempotencyKey, String requestDigest) {
        List<String[]> commands = jdbc.query("SELECT request_digest,"
                + " agent_id, agent_revision AS revision FROM ma_request_receipt"
                + " WHERE receipt_key = ? AND namespace = 'AGENT_DEFINITION' AND tenant_id = ? AND idempotency_key = ?",
                (row, index) -> new String[] {row.getString(1),
                        row.getString(2), Long.toString(row.getLong(3))},
                receiptKey(tenantId, idempotencyKey), tenantId, idempotencyKey);
        if (commands.isEmpty()) {
            return Optional.empty();
        }
        String[] command = commands.getFirst();
        if (!command[0].equals(requestDigest)) {
            throw new ManagedAgentException(HttpStatus.CONFLICT,
                    "idempotency_conflict",
                    "The Idempotency-Key was used with a different request.");
        }
        DefinitionRevision revision = find(tenantId, command[1],
                Long.parseLong(command[2])).orElseThrow(() ->
                        new IllegalStateException(
                                "An agent definition command lost its revision"));
        return Optional.of(new Admission(revision, true));
    }

    private Admission record(String tenantId, String idempotencyKey,
            String requestDigest, DefinitionRevision revision, long now) {
        try {
            jdbc.update("INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id,"
                            + " scope_kind, scope_key, scope_id, idempotency_key, idempotency_digest, request_digest,"
                            + " state, agent_id, agent_revision, gmt_create, gmt_modified)"
                            + " VALUES (?, 'AGENT_DEFINITION', ?, ?, 'TENANT', ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?)",
                    receiptKey(tenantId, idempotencyKey), ManagedSchemaKeys.key(tenantId), tenantId,
                    ManagedSchemaKeys.key("TENANT", tenantId), tenantId, idempotencyKey,
                    ManagedSchemaKeys.key(idempotencyKey), requestDigest, revision.agentId(), revision.revision(), now, now);
        } catch (DuplicateKeyException error) {
            // A concurrent request recorded this key first.
            throw new ConcurrentWriteException("idempotency_conflict",
                    "The Idempotency-Key was used by a concurrent request.");
        }
        return new Admission(revision, false);
    }

    private static String receiptKey(String tenantId, String idempotencyKey) {
        return ManagedSchemaKeys.receiptKey(ReceiptNamespace.AGENT_DEFINITION, tenantId,
                ReceiptScope.TENANT, tenantId, idempotencyKey);
    }

    private void insertRevision(String tenantId, DefinitionRevision revision) {
        jdbc.update("INSERT INTO ma_agent_definition (tenant_id,"
                + " agent_id, revision, digest, definition_json, gmt_create)"
                + " VALUES (?, ?, ?, ?, ?, ?)", tenantId, revision.agentId(),
                revision.revision(), revision.digest(),
                revision.definitionJson(), revision.createdAt());
    }

    private static DefinitionRevision row(java.sql.ResultSet row, int index)
            throws java.sql.SQLException {
        return new DefinitionRevision(row.getString("agent_id"),
                row.getLong("revision"), row.getString("digest"),
                row.getString("definition_json"), row.getLong("gmt_create"));
    }

    private static <T> Optional<T> first(List<T> rows) {
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.getFirst());
    }

    public static ManagedAgentException notFound() {
        return new ManagedAgentException(HttpStatus.NOT_FOUND, "agent_not_found",
                "The agent definition was not found.");
    }
}
