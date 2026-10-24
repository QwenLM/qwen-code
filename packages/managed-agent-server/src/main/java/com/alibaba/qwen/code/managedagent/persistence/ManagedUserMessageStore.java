package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

@Service
public class ManagedUserMessageStore {
    private static final TypeReference<List<Map<String, Object>>> INPUT = new TypeReference<>() { };
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final RequestDigests digests;
    private final ManagedAgentService agents;

    public ManagedUserMessageStore(JdbcTemplate jdbc, ObjectMapper json, RequestDigests digests, ManagedAgentService agents) {
        this.jdbc = jdbc;
        this.json = json;
        this.digests = digests;
        this.agents = agents;
    }

    public record Message(String id, long sequence, long revision, String state,
            List<Map<String, Object>> input, String turnId) { }
    public record Snapshot(boolean paused, List<Message> messages) { }
    public record Command(String action, String messageId, Long expectedRevision, List<InputBlock> input) { }

    @Transactional
    public Snapshot query(String tenant, String actor, String session) {
        agents.authorizeUserMessages(tenant, actor, session);
        if (!agents.supportsUserMessageQueue()) {
            throw conflict("unsupported_feature");
        }
        lock(tenant, session);
        reconcile(tenant, session);
        return snapshot(tenant, session);
    }

    @Transactional
    public Snapshot command(String tenant, String actor, String session, String key, Command command) {
        agents.authorizeUserMessages(tenant, actor, session);
        if (key == null || key.isBlank() || key.length() > 128) {
            throw refusal("invalid_request", "A bounded Idempotency-Key is required.");
        }
        lock(tenant, session);
        if (command == null || command.action() == null) {
            throw refusal("invalid_request", "A queue action is required.");
        }
        String commandKey = DigestUtils.sha256Hex(actor + "\n" + key);
        String digest = digests.digest(command);
        var replay = jdbc.query("SELECT request_digest, result_json FROM ma_user_message_command"
                        + " WHERE tenant_id = ? AND session_id = ? AND command_key = ?",
                (row, index) -> Map.entry(row.getString(1), row.getString(2)), tenant, session, commandKey);
        if (!replay.isEmpty()) {
            if (!digest.equals(replay.getFirst().getKey())) {
                throw conflict("idempotency_conflict");
            }
            return decode(replay.getFirst().getValue(), Snapshot.class);
        }
        if (!agents.supportsUserMessageQueue()) {
            throw conflict("unsupported_feature");
        }
        reconcile(tenant, session);
        switch (command.action()) {
            case "submit" -> {
                List<Map<String, Object>> input = agents.userMessageInput(command.input());
                Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message WHERE tenant_id = ?"
                        + " AND session_id = ? AND state IN ('queued', 'claimed', 'recovery_blocked')", Integer.class, tenant, session);
                if (count != null && count >= 32) {
                    throw conflict("user_message_queue_full");
                }
                Long sequence = jdbc.queryForObject("SELECT next_sequence FROM ma_user_message_queue"
                        + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session);
                Long context = jdbc.queryForObject("SELECT context_revision FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                        Long.class, tenant, session);
                jdbc.update("INSERT INTO ma_user_message (tenant_id, session_id, message_id, sequence_number, revision,"
                                + " actor_id, input_json, state, context_revision) VALUES (?, ?, ?, ?, 1, ?, ?, 'queued', ?)",
                        tenant, session, "umsg_" + UUID.randomUUID(), sequence, actor, encode(input), context);
                jdbc.update("UPDATE ma_user_message_queue SET next_sequence = next_sequence + 1 WHERE tenant_id = ? AND session_id = ?",
                        tenant, session);
            }
            case "edit", "withdraw" -> {
                String input = "edit".equals(command.action()) ? encode(agents.userMessageInput(command.input())) : null;
                int changed = input == null
                        ? jdbc.update("UPDATE ma_user_message SET state = 'withdrawn', revision = revision + 1"
                                + " WHERE tenant_id = ? AND session_id = ? AND message_id = ? AND revision = ? AND (state = 'queued' OR (state = 'recovery_blocked' AND turn_id IS NULL))",
                                tenant, session, command.messageId(), command.expectedRevision())
                        : jdbc.update("UPDATE ma_user_message SET input_json = ?, revision = revision + 1"
                                + " WHERE tenant_id = ? AND session_id = ? AND message_id = ? AND revision = ? AND state = 'queued'",
                                input, tenant, session, command.messageId(), command.expectedRevision());
                if (changed != 1) {
                    throw conflict("user_message_conflict");
                }
            }
            case "resume" -> {
                if ("RECOVERY_BLOCKED".equals(latestTurn(tenant, session).get("status"))) {
                    throw conflict("user_message_recovery_blocked");
                }
                if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message WHERE tenant_id = ? AND session_id = ?"
                        + " AND state = 'recovery_blocked'", Integer.class, tenant, session) > 0) {
                    throw conflict("user_message_recovery_blocked");
                }
                String turn = latestTurn(tenant, session).get("turnId");
                jdbc.update("UPDATE ma_user_message_queue SET paused = FALSE, resumed_turn_id = ? WHERE tenant_id = ? AND session_id = ?",
                        turn, tenant, session);
            }
            default -> throw refusal("invalid_request", "Unknown user message action.");
        }
        Snapshot result = snapshot(tenant, session);
        jdbc.update("INSERT INTO ma_user_message_command (tenant_id, session_id, command_key, actor_id, request_digest, result_json)"
                + " VALUES (?, ?, ?, ?, ?, ?)", tenant, session, commandKey, actor, digest, encode(result));
        return result;
    }

    @Transactional
    public List<Message> claim(String tenant, String session, String promptId, boolean initialOnly) {
        lock(tenant, session);
        reconcile(tenant, session);
        if (initialOnly) {
            return read(tenant, session, "state = 'claimed' AND prompt_id = ?", promptId);
        }
        if (snapshot(tenant, session).paused()) {
            return List.of();
        }
        var turns = jdbc.query("SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND prompt_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING')",
                (row, index) -> row.getString(1), tenant, session, promptId);
        if (turns.isEmpty()) {
            return List.of();
        }
        Long context = jdbc.queryForObject("SELECT context_revision FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session);
        Integer mismatches = jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message WHERE tenant_id = ? AND session_id = ?"
                        + " AND state = 'queued' AND COALESCE(context_revision, -1) <> COALESCE(?, -1)", Integer.class, tenant, session, context);
        if (mismatches != null && mismatches > 0) {
            jdbc.update("UPDATE ma_user_message SET state = 'recovery_blocked' WHERE tenant_id = ? AND session_id = ? AND state = 'queued'",
                    tenant, session);
            jdbc.update("UPDATE ma_user_message_queue SET paused = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
            return List.of();
        }
        jdbc.update("UPDATE ma_user_message SET state = 'claimed', turn_id = ?, prompt_id = ? WHERE tenant_id = ?"
                + " AND session_id = ? AND state = 'queued'", turns.getFirst(), promptId, tenant, session);
        // A lost reply must never make an already claimed message look absent.
        return read(tenant, session, "state = 'claimed' AND prompt_id = ?", promptId);
    }

    public List<Map<String, String>> readySessions() {
        return jdbc.query("SELECT DISTINCT m.tenant_id, m.session_id, q.last_dispatch_at FROM ma_user_message m JOIN ma_session s"
                + " ON s.tenant_id = m.tenant_id AND s.session_id = m.session_id JOIN ma_user_message_queue q"
                + " ON q.tenant_id = m.tenant_id AND q.session_id = m.session_id WHERE s.status = 'ACTIVE'"
                + " AND q.paused = FALSE AND m.state = 'queued' AND NOT EXISTS (SELECT 1 FROM ma_turn t"
                + " WHERE t.tenant_id = m.tenant_id AND t.session_id = m.session_id AND t.status IN ('ACCEPTED', 'RUNNING', 'CANCELLING', 'RECOVERY_BLOCKED'))"
                + " AND NOT EXISTS (SELECT 1 FROM ma_user_message blocked WHERE blocked.tenant_id = m.tenant_id"
                + " AND blocked.session_id = m.session_id AND blocked.state IN ('claimed', 'recovery_blocked'))"
                + " ORDER BY q.last_dispatch_at, m.tenant_id, m.session_id LIMIT 32", (row, index) -> Map.of("tenant", row.getString(1), "session", row.getString(2)));
    }

    @Transactional
    public void attempted(String tenant, String session) {
        jdbc.update("UPDATE ma_user_message_queue SET last_dispatch_at = "
                + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
    }

    @Transactional
    public void startNext(String tenant, String session) {
        if (!agents.supportsUserMessageQueue()) {
            return;
        }
        ManagedSessionStore.lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenant, ManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        lock(tenant, session);
        reconcile(tenant, session);
        Snapshot snapshot = snapshot(tenant, session);
        if (snapshot.paused() || snapshot.messages().isEmpty() || snapshot.messages().stream()
                .anyMatch(message -> !"queued".equals(message.state()))) {
            return;
        }
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                + " AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING', 'RECOVERY_BLOCKED')", Integer.class, tenant, session) > 0) {
            return;
        }
        Long context = jdbc.queryForObject("SELECT context_revision FROM ma_session WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session);
        Integer mismatches = jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message WHERE tenant_id = ? AND session_id = ?"
                + " AND state = 'queued' AND COALESCE(context_revision, -1) <> COALESCE(?, -1)", Integer.class, tenant, session, context);
        if (mismatches != null && mismatches > 0) {
            jdbc.update("UPDATE ma_user_message SET state = 'recovery_blocked' WHERE tenant_id = ? AND session_id = ? AND state = 'queued'", tenant, session);
            jdbc.update("UPDATE ma_user_message_queue SET paused = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
            return;
        }
        Message first = snapshot.messages().getFirst();
        String actor = jdbc.queryForObject("SELECT actor_id FROM ma_user_message WHERE tenant_id = ? AND session_id = ? AND message_id = ?",
                String.class, tenant, session, first.id());
        List<InputBlock> input = first.input().stream().map(block -> {
            if ("text".equals(block.get("type"))) {
                return new InputBlock("input_text", (String) block.get("text"));
            }
            Map<?, ?> resource = (Map<?, ?>) block.get("resource");
            String name = java.net.URLDecoder.decode(((String) resource.get("uri")).substring("managed-input:///".length()), StandardCharsets.UTF_8);
            return new InputBlock("input_file", (String) resource.get("text"), (String) resource.get("mimeType"), null, name);
        }).toList();
        jdbc.update("UPDATE ma_user_message SET state = 'claimed' WHERE tenant_id = ? AND session_id = ? AND message_id = ? AND state = 'queued'", tenant, session, first.id());
        var admission = agents.submitTurn(tenant, actor, "user-queue:" + first.id(), session, input);
        String prompt = jdbc.queryForObject("SELECT prompt_id FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                String.class, tenant, session, admission.turnId());
        jdbc.update("UPDATE ma_user_message SET state = 'claimed', turn_id = ?, prompt_id = ? WHERE tenant_id = ?"
                + " AND session_id = ? AND message_id = ? AND state = 'claimed'", admission.turnId(), prompt, tenant, session, first.id());
    }

    @Transactional
    public void retireClosed() {
        jdbc.update("UPDATE ma_user_message SET state = 'withdrawn' WHERE state = 'queued' AND EXISTS"
                + " (SELECT 1 FROM ma_session s WHERE s.tenant_id = ma_user_message.tenant_id"
                + " AND s.session_id = ma_user_message.session_id AND s.status <> 'ACTIVE')");
    }

    private void lock(String tenant, String session) {
        var status = jdbc.query("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                (row, index) -> row.getString(1), tenant, session);
        if (status.isEmpty()) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND, "session_not_found", "Session not found.");
        }
        if (!"ACTIVE".equals(status.getFirst())) {
            throw conflict("session_not_active");
        }
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message_queue WHERE tenant_id = ? AND session_id = ?",
                Integer.class, tenant, session) == 0) {
            jdbc.update("INSERT INTO ma_user_message_queue (tenant_id, session_id) VALUES (?, ?)", tenant, session);
        }
    }

    private Map<String, String> latestTurn(String tenant, String session) {
        var turns = jdbc.query("SELECT turn_id, status FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY gmt_create DESC, turn_id DESC LIMIT 1",
                (row, index) -> Map.of("turnId", row.getString(1), "status", row.getString(2)), tenant, session);
        return turns.isEmpty() ? Map.of() : turns.getFirst();
    }

    private void reconcile(String tenant, String session) {
        Map<String, String> turn = latestTurn(tenant, session);
        if (List.of("FAILED", "CANCELLED", "CANCELLING", "RECOVERY_BLOCKED").contains(turn.getOrDefault("status", ""))) {
            String resumed = jdbc.queryForObject("SELECT resumed_turn_id FROM ma_user_message_queue WHERE tenant_id = ? AND session_id = ?",
                    String.class, tenant, session);
            if (!Objects.equals(resumed, turn.get("turnId"))) {
                jdbc.update("UPDATE ma_user_message_queue SET paused = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
            }
        }
        jdbc.update("UPDATE ma_user_message SET state = 'recovery_blocked' WHERE tenant_id = ? AND session_id = ? AND state = 'claimed'"
                + " AND turn_id IN (SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                + " AND status IN ('COMPLETED', 'FAILED', 'CANCELLED'))", tenant, session, tenant, session);
    }

    private Snapshot snapshot(String tenant, String session) {
        boolean paused = Boolean.TRUE.equals(jdbc.queryForObject("SELECT paused FROM ma_user_message_queue"
                + " WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session));
        List<Message> messages = read(tenant, session, "state IN ('queued', 'claimed', 'recovery_blocked')");
        return new Snapshot(paused || messages.stream().anyMatch(message -> "recovery_blocked".equals(message.state())), messages);
    }

    private List<Message> read(String tenant, String session, String predicate, Object... parameters) {
        List<Object> args = new ArrayList<>(List.of(tenant, session));
        args.addAll(List.of(parameters));
        return jdbc.query("SELECT message_id, sequence_number, revision, state, input_json, turn_id FROM ma_user_message"
                        + " WHERE tenant_id = ? AND session_id = ? AND " + predicate + " ORDER BY sequence_number",
                (row, index) -> new Message(row.getString(1), row.getLong(2), row.getLong(3), row.getString(4),
                        decodeInput(row.getString(5)), row.getString(6)), args.toArray());
    }

    public static void capture(JdbcTemplate jdbc, ObjectMapper json, String tenant, String session, byte[] records) {
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            try {
                JsonNode event = json.readTree(line).path("managedSession");
                if (!"message.committed".equals(event.path("kind").asText())
                        || !"user".equals(event.path("payload").path("role").asText())) {
                    continue;
                }
                String identity = event.path("payload").path("messageId").asText();
                int separator = identity.lastIndexOf(':');
                if (!identity.startsWith("umsg_") || separator < 0) {
                    continue;
                }
                long revision = Long.parseLong(identity.substring(separator + 1));
                jdbc.update("UPDATE ma_user_message SET state = 'consumed', consumed_sequence = ? WHERE tenant_id = ?"
                                + " AND session_id = ? AND message_id = ? AND revision = ? AND state IN ('claimed', 'recovery_blocked')",
                        event.path("sequence").asLong(), tenant, session, identity.substring(0, separator), revision);
            } catch (com.fasterxml.jackson.core.JsonProcessingException | NumberFormatException error) {
                throw new IllegalArgumentException("Invalid user message receipt", error);
            }
        }
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }
    private <T> T decode(String value, Class<T> type) {
        try {
            return json.readValue(value, type);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }
    private List<Map<String, Object>> decodeInput(String value) {
        try {
            return json.readValue(value, INPUT);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }
    private static ManagedAgentException conflict(String code) {
        return new ManagedAgentException(HttpStatus.CONFLICT, code, "The user message queue changed or is unavailable.");
    }
    private static ManagedAgentException refusal(String code, String message) {
        return new ManagedAgentException(HttpStatus.BAD_REQUEST, code, message);
    }
}
