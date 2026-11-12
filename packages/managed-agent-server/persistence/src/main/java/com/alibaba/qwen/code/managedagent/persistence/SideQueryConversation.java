package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Prefix;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Objects;
import java.util.Set;

final class SideQueryConversation {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DOMAIN = "side_query_conversation";

    private SideQueryConversation() {}

    static void mainInputAccepted(JdbcTemplate jdbc, String tenant, String session) {
        ObjectNode state = state(jdbc, tenant, session);
        if (state.isEmpty()) {
            return;
        }
        state.put("mainInputBoundary", state.has("mainInputBoundary")
                ? state.path("mainInputBoundary").asLong() + 1 : admittedInputs(jdbc, tenant, session));
        save(jdbc, tenant, session, state);
    }

    static ObjectNode state(JdbcTemplate jdbc, String tenant, String session) {
        String scope = scope(tenant, session);
        var rows = jdbc.query("SELECT options_json FROM ma_session_record WHERE session_scope_key=?"
                        + " AND record_key=? AND record_kind='CONVERSATION' FOR UPDATE",
                (row, index) -> row.getString(1), scope, ManagedSchemaKeys.key(scope, DOMAIN));
        if (rows.isEmpty()) {
            return JSON.createObjectNode();
        }
        try {
            return (ObjectNode) JSON.readTree(rows.getFirst());
        } catch (java.io.IOException | ClassCastException error) {
            throw corrupt();
        }
    }

    static Prefix capture(JdbcTemplate jdbc, String tenant, String session,
            long revision, long sequence, String digest, JdbcJournalPacks packs) {
        ObjectNode state = state(jdbc, tenant, session);
        if (!state.has("mainInputBoundary")) {
            state.put("mainInputBoundary", admittedInputs(jdbc, tenant, session));
            save(jdbc, tenant, session, state);
        }
        long projected = state.path("journalRevision").asLong();
        if (projected > revision) {
            throw corrupt();
        }
        if (projected > 0 && (!state.has("lastCommitDigest") || !state.path("acceptedTurns").isObject())) {
            projected = 0;
        }
        if (projected > 0 && projected == revision
                && !Objects.equals(state.path("lastCommitDigest").asText(null), digest)) {
            throw corrupt();
        }
        if (projected != revision) {
            var accepted = new HashMap<String, Boolean>();
            if (projected > 0) {
                state.path("acceptedTurns").fields().forEachRemaining(entry -> {
                    if (!entry.getValue().isBoolean()) {
                        throw corrupt();
                    }
                    accepted.put(entry.getKey(), entry.getValue().booleanValue());
                });
            }
            String previous = projected == 0 ? null : state.path("lastCommitDigest").asText(null);
            long nextRevision = projected + 1;
            long completedSequence = projected == 0 ? 0 : state.path("completedTurnSequence").asLong();
            long users = projected == 0 ? 0 : state.path("completedUserTurnCount").asLong();
            String version = projected == 0 ? emptyVersion() : state.path("contentVersion").asText();
            long scannedBytes = 0;
            for (long after = projected; after < revision;) {
                var rows = jdbc.query("SELECT journal_revision,record_bytes,record_digest,previous_commit_digest,"
                                + "commit_digest,byte_length FROM ma_session_journal_tx WHERE tenant_id=? AND session_id=?"
                                + " AND journal_revision>? AND journal_revision<=? ORDER BY journal_revision LIMIT 32",
                        (row, index) -> {
                            byte[] bytes = row.getBytes(2);
                            if (bytes == null && packs != null) {
                                bytes = packs.resolveBytes(tenant, session, row.getLong(1),
                                        row.getString(3), row.getLong(6));
                            }
                            return new Transaction(row.getLong(1), bytes, row.getString(3),
                                    row.getString(4), row.getString(5));
                        }, tenant, session, after, revision);
                if (rows.isEmpty()) {
                    throw corrupt();
                }
                for (var row : rows) {
                    if (row.bytes() == null) {
                        throw corrupt();
                    }
                    scannedBytes += row.bytes().length;
                    if (scannedBytes > com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.MAX_MODEL_REQUEST_BYTES) {
                        throw corrupt();
                    }
                    if (row.revision() != nextRevision++ || !JournalStoreRows.sha256(row.bytes()).equals(row.digest())
                            || !java.util.Objects.equals(previous, row.previous())) {
                        throw corrupt();
                    }
                    previous = row.commit();
                    for (String line : new String(row.bytes(), StandardCharsets.UTF_8).split("\n")) {
                        JsonNode event;
                        try {
                            event = JSON.readTree(line);
                        } catch (java.io.IOException error) {
                            throw corrupt();
                        }
                        if (event == null) {
                            throw corrupt();
                        }
                        if (!"managed_session_event_v1".equals(event.path("subtype").asText())) {
                            continue;
                        }
                        event = event.path("managedSession");
                        JsonNode payload = event.path("payload");
                        String turn = payload.path("turnId").asText();
                        if ("input.accepted".equals(event.path("kind").asText())) {
                            accepted.put(turn, Set.of("web_shell", "cli", "user", "channel")
                                    .contains(payload.path("source").asText()));
                            if (accepted.size() > 128) {
                                throw corrupt();
                            }
                        } else if ("turn.settled".equals(event.path("kind").asText())) {
                            Boolean realUser = accepted.remove(turn);
                            if (realUser != null && "completed".equals(payload.path("outcome").asText())) {
                                completedSequence = event.path("sequence").asLong();
                                version = ManagedSchemaKeys.key("side-query-content/1", version, turn,
                                        Long.toString(completedSequence));
                                if (realUser) {
                                    users++;
                                }
                            }
                        }
                    }
                    after = row.revision();
                }
            }
            if (!java.util.Objects.equals(previous, digest)) {
                throw corrupt();
            }
            state.put("journalRevision", revision);
            state.put("completedTurnSequence", completedSequence);
            state.put("completedUserTurnCount", users);
            state.put("contentVersion", version);
            state.put("lastCommitDigest", digest);
            state.set("acceptedTurns", JSON.valueToTree(accepted));
            save(jdbc, tenant, session, state);
        }
        return new Prefix(revision, sequence, digest, state.path("completedTurnSequence").asLong(),
                state.path("contentVersion").asText(emptyVersion()),
                state.path("completedUserTurnCount").asLong(), state.path("mainInputBoundary").asLong());
    }

    private static void save(JdbcTemplate jdbc, String tenant, String session, ObjectNode state) {
        String scope = scope(tenant, session);
        String key = ManagedSchemaKeys.key(scope, DOMAIN);
        int updated = jdbc.update("UPDATE ma_session_record SET options_json=?, revision=revision+1"
                + " WHERE session_scope_key=? AND record_key=? AND record_kind='CONVERSATION'",
                state.toString(), scope, key);
        if (updated == 0) {
            String workspace = jdbc.queryForObject("SELECT workspace_id FROM ma_session WHERE tenant_id=? AND session_id=?",
                    String.class, tenant, session);
            jdbc.update("INSERT INTO ma_session_record (session_scope_key,record_key,tenant_id,session_id,workspace_id,domain,"
                            + "record_id,revision,record_kind,options_json,gmt_create) VALUES (?,?,?,?,?,?,?,1,'CONVERSATION',?,?)",
                    scope, key, tenant, session, workspace, DOMAIN, DOMAIN, state.toString(), ToolPublicationRetentionStore.now(jdbc));
        }
    }

    static String scope(String tenant, String session) {
        return com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session);
    }

    private static long admittedInputs(JdbcTemplate jdbc, String tenant, String session) {
        Long turns = jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id=? AND session_id=?",
                Long.class, tenant, session);
        Long queued = jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message WHERE tenant_id=? AND session_id=? AND turn_id IS NULL",
                Long.class, tenant, session);
        return Objects.requireNonNull(turns) + Objects.requireNonNull(queued);
    }

    private static ManagedAgentException corrupt() {
        return new ManagedAgentException(409, "side_query_history_unavailable",
                "Verified original conversation history is unavailable.");
    }

    private static String emptyVersion() {
        return ManagedSchemaKeys.key("side-query-content/1", "[]");
    }

    private record Transaction(long revision, byte[] bytes, String digest, String previous, String commit) {}
}
