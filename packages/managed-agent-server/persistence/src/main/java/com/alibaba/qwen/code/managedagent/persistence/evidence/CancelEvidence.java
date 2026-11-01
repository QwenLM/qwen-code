package com.alibaba.qwen.code.managedagent.persistence.evidence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.session.AcceptanceEvidence;
import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

/** Reconciles coalesced Turn cancels from that prompt's durable terminal event. */
@Component
public class CancelEvidence implements AcceptanceEvidence {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public CancelEvidence(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    public String kind() {
        return "CANCEL";
    }

    @Override
    public Optional<AcceptanceVerdict> read(ParkedOperation parked) {
        if (!kind().equals(parked.kind())) {
            return Optional.empty();
        }
        List<Target> targets = jdbc.query("SELECT t.turn_id, t.prompt_id, o.target_key"
                        + " FROM ma_operation o LEFT JOIN ma_turn t ON t.tenant_id = o.tenant_id"
                        + " AND t.session_id = o.session_id AND t.turn_id = o.target_id"
                        + " WHERE o.scope_key = ? AND o.tenant_id = ? AND o.session_id = ?"
                        + " AND o.operation_id = ? AND o.operation_kind = 'CANCEL'"
                        + " AND o.target_kind = 'TURN' AND o.state = 'RECOVERY_BLOCKED'"
                        + " AND o.delivery_state = 'BLOCKED' AND o.claim_owner IS NULL",
                (row, index) -> new Target(row.getString(1), row.getString(2), row.getString(3)),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(parked.tenantId(), parked.sessionId()),
                parked.tenantId(), parked.sessionId(), parked.operationId());
        if (targets.isEmpty()) {
            return Optional.empty();
        }
        Target target = targets.getFirst();
        if (target.turnId() == null || target.promptId() == null
                || !ManagedSchemaKeys.key(target.turnId()).equals(target.key())) {
            return Optional.of(AcceptanceVerdict.unknown());
        }
        List<Head> heads = jdbc.query("SELECT workspace_id, journal_revision FROM ma_session_head"
                        + " WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                (row, index) -> new Head(row.getString(1), row.getLong(2)),
                ManagedSchemaKeys.key(parked.tenantId()), ManagedSchemaKeys.key(parked.sessionId()),
                parked.tenantId(), parked.sessionId());
        if (heads.isEmpty() || heads.getFirst().workspaceId() == null) {
            return Optional.of(AcceptanceVerdict.unknown());
        }
        Head head = heads.getFirst();
        long through = head.revision();
        while (through > 0) {
            // Read one bounded transaction at a time. A Turn result's command id is
            // recorder:<uuid>, so it cannot be looked up by the prompt's command hash.
            List<Journal> rows = jdbc.query("SELECT journal_revision, record_encoding,"
                            + " CASE WHEN OCTET_LENGTH(record_bytes) <= ? THEN record_bytes END AS record_bytes,"
                            + " byte_length, record_digest FROM ma_session_journal_tx"
                            + " WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?"
                            + " AND operation = 'settleTurn' AND journal_revision <= ?"
                            + " ORDER BY journal_revision DESC LIMIT 1",
                    (row, index) -> new Journal(row.getLong(1), row.getString(2), row.getBytes(3),
                            row.getLong(4), row.getString(5)),
                    ManagedSessionStoreModels.MAX_TRANSACTION_BYTES,
                    parked.tenantId(), head.workspaceId(), parked.sessionId(), through);
            if (rows.isEmpty()) {
                break;
            }
            Journal journal = rows.getFirst();
            through = journal.revision() - 1;
            if (!"identity".equals(journal.encoding()) || journal.bytes() == null
                    || journal.bytes().length != journal.byteLength()
                    || !DigestUtils.sha256Hex(journal.bytes()).equals(journal.digest())) {
                throw new IllegalStateException("Stored cancel evidence is corrupt");
            }
            for (String line : new String(journal.bytes(), StandardCharsets.UTF_8).split("\n")) {
                JsonNode record = parse(line);
                if (!"managed_session_event_v1".equals(record.path("subtype").asText())) {
                    continue;
                }
                JsonNode event = record.path("managedSession");
                JsonNode key = event.path("sessionKey");
                JsonNode payload = event.path("payload");
                if (!"turn.settled".equals(event.path("kind").asText())
                        || !("turn:" + target.promptId()).equals(event.path("eventId").asText())
                        || !target.promptId().equals(payload.path("turnId").asText())
                        || !parked.tenantId().equals(key.path("tenantId").asText())
                        || !head.workspaceId().equals(key.path("workspaceId").asText())
                        || !parked.sessionId().equals(key.path("sessionId").asText())) {
                    continue;
                }
                AcceptanceVerdict verdict = switch (payload.path("outcome").asText()) {
                    case "cancelled" -> AcceptanceVerdict.committed();
                    case "completed", "error" -> AcceptanceVerdict.notCommitted("turn_already_settled");
                    default -> AcceptanceVerdict.unknown();
                };
                return Optional.of(verdict);
            }
        }
        // requestCancel aborts before its journal append. Even a closed journal
        // without that append cannot prove the abort never took effect.
        return Optional.of(AcceptanceVerdict.unknown());
    }

    private JsonNode parse(String line) {
        try {
            JsonNode parsed = json.readTree(line);
            if (parsed != null && parsed.isObject()) {
                return parsed;
            }
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored cancel evidence is unreadable", error);
        }
        throw new IllegalStateException("Stored cancel evidence is unreadable");
    }

    private record Target(String turnId, String promptId, String key) {}

    private record Head(String workspaceId, long revision) {}

    private record Journal(long revision, String encoding, byte[] bytes, long byteLength, String digest) {}
}
