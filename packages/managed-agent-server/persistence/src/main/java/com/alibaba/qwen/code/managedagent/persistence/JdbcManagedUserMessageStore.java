package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.UserMessagePolicy;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
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
@Qualifier("managedAgentTransactionManager")
public class JdbcManagedUserMessageStore
        implements ManagedUserMessageStore {
    private com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles;
    @org.springframework.beans.factory.annotation.Autowired
    public void configureWorktreeFiles(com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles value) { worktreeFiles = value; }

    private static final TypeReference<List<Map<String, Object>>> INPUT = new TypeReference<>() { };
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final RequestDigests digests;
    private final UserMessagePolicy agents;

    public JdbcManagedUserMessageStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, @Qualifier("managedAgentObjectMapper") ObjectMapper json, RequestDigests digests, @Qualifier("managedUserMessagePolicy") UserMessagePolicy agents) {
        this.jdbc = jdbc;
        this.json = json;
        this.digests = digests;
        this.agents = agents;
    }

    @Transactional
    public Snapshot queryMessages(String tenant, String actor, String session) {
        // The raw-actor queue path keeps the filter-admitted actor verbatim
        // (R7-1): the Workspace gates compare the raw actor, and a
        // principal is built only where an ownership row must be matched.
        agents.authorizeUserMessages(tenant, actor, session);
        return queueSnapshot(tenant, session);
    }

    @Transactional
    public Snapshot queryMessages(SessionPrincipal principal, String session) {
        agents.authorizeUserMessages(principal, session);
        return queueSnapshot(principal.tenantId(), session);
    }

    private Snapshot queueSnapshot(String tenant, String session) {
        if (!agents.supportsUserMessageQueue()) {
            throw conflict("unsupported_feature");
        }
        lock(tenant, session);
        reconcile(tenant, session);
        return snapshot(tenant, session);
    }

    @Transactional
    public Snapshot command(String tenant, String actor, String session,
            String key, Command command) {
        agents.authorizeUserMessageActor(tenant, actor, session);
        // A String actor never carries a business-actor subject, so the
        // pre-ownership receipt key is the exact compatible identity.
        return commandInternal(tenant, actor, session,
                DigestUtils.sha256Hex(actor + "\n" + key), key, command,
                () -> agents.authorizeUserMessages(tenant, actor, session));
    }

    @Transactional
    public Snapshot command(SessionPrincipal principal, String session,
            String key, Command command) {
        agents.authorizeUserMessageActor(principal, session);
        return commandInternal(principal.tenantId(), principal.userId(),
                session, commandKey(principal, key), key, command,
                () -> agents.authorizeUserMessages(principal, session));
    }

    private Snapshot commandInternal(String tenant, String actor,
            String session, String commandKey, String key, Command command,
            Runnable authorizeMessages) {
        if (key == null || key.isBlank() || key.length() > 128) {
            throw refusal("invalid_request", "A bounded Idempotency-Key is required.");
        }
        lockSession(tenant, session);
        if (command == null || command.action() == null) {
            throw refusal("invalid_request", "A queue action is required.");
        }
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
        authorizeMessages.run();
        lock(tenant, session);
        if (!agents.supportsUserMessageQueue()) {
            throw conflict("unsupported_feature");
        }
        reconcile(tenant, session);
        switch (command.action()) {
            case "submit" -> {
                JdbcSessionWorktreeStore.requireReady(worktreeFiles, jdbc, tenant, session);
                List<Map<String, Object>> input = input(tenant, session, command.input());
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
                SideQueryConversation.mainInputAccepted(jdbc, tenant, session);
            }
            case "edit", "withdraw" -> {
                String input = "edit".equals(command.action()) ? encode(input(tenant, session, command.input())) : null;
                if (input == null && snapshot(tenant, session).messages().stream()
                        .anyMatch(message -> message.id().equals(command.messageId()) && "recovery_blocked".equals(message.state()))) {
                    jdbc.update("UPDATE ma_user_message_queue SET is_paused = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
                }
                // Keep a blocked claim's identity so a late durable receipt can still settle it.
                int changed = input == null
                        ? jdbc.update("UPDATE ma_user_message SET revision = CASE WHEN state = 'queued' THEN revision + 1 ELSE revision END, state = 'withdrawn'"
                                + " WHERE tenant_id = ? AND session_id = ? AND message_id = ? AND revision = ? AND state IN ('queued', 'recovery_blocked')",
                                tenant, session, command.messageId(), command.expectedRevision())
                        : jdbc.update("UPDATE ma_user_message SET input_json = ?, revision = revision + 1"
                                + " WHERE tenant_id = ? AND session_id = ? AND message_id = ? AND revision = ? AND state = 'queued'",
                                input, tenant, session, command.messageId(), command.expectedRevision());
                if (changed != 1) {
                    throw conflict("user_message_conflict");
                }
            }
            case "resume" -> {
                JdbcSessionWorktreeStore.requireReady(worktreeFiles, jdbc, tenant, session);
                if ("RECOVERY_BLOCKED".equals(latestTurn(tenant, session).get("status"))) {
                    throw conflict("user_message_recovery_blocked");
                }
                if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message WHERE tenant_id = ? AND session_id = ?"
                        + " AND state = 'recovery_blocked'", Integer.class, tenant, session) > 0) {
                    throw conflict("user_message_recovery_blocked");
                }
                String turn = latestTurn(tenant, session).get("turnId");
                jdbc.update("UPDATE ma_user_message_queue SET is_paused = FALSE, resumed_turn_id = ? WHERE tenant_id = ? AND session_id = ?",
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
            jdbc.update("UPDATE ma_user_message_queue SET is_paused = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
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
                + " AND q.is_paused = FALSE AND m.state = 'queued' AND NOT EXISTS (SELECT 1 FROM ma_turn t"
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
    public void startNext(String tenant, String session, QueuedDispatchSubmitter submitter) {
        if (!agents.supportsUserMessageQueue()) {
            return;
        }
        // The Session row is the first lock, as in Turn admission, which the
        // submitter below runs in this transaction without the tenant guard:
        // it orders this dispatch against lifecycle and other admissions of
        // the Session, and the storage fence is checked by Turn admission.
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
            jdbc.update("UPDATE ma_user_message_queue SET is_paused = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
            return;
        }
        Message first = snapshot.messages().getFirst();
        QueuedIdentity identity = queuedIdentity(tenant, session, first.id());
        List<InputBlock> input = first.input().stream().map(block -> {
            if ("text".equals(block.get("type"))) {
                return new InputBlock("input_text", (String) block.get("text"));
            }
            Map<?, ?> resource = (Map<?, ?>) block.get("resource");
            String name = java.net.URLDecoder.decode(((String) resource.get("uri")).substring("managed-input:///".length()), StandardCharsets.UTF_8);
            return new InputBlock("input_file", (String) resource.get("text"), (String) resource.get("mimeType"), null, name);
        }).toList();
        jdbc.update("UPDATE ma_user_message SET state = 'claimed' WHERE tenant_id = ? AND session_id = ? AND message_id = ? AND state = 'queued'", tenant, session, first.id());
        var admission = submitter.submit(tenant, identity.principal(),
                identity.actorId(), "user-queue:" + first.id(), session, input);
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

    private List<Map<String, Object>> input(String tenant, String session, List<InputBlock> blocks) {
        List<Map<String, Object>> input = agents.userMessageInput(blocks);
        String profile = jdbc.queryForObject("SELECT tool_profile FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session);
        if (WorkspaceToolProfiles.EXTERNAL_FILES.equals(profile)
                && input.stream().anyMatch(block -> !"text".equals(block.get("type")))) {
            throw conflict("workspace_unavailable");
        }
        return input;
    }

    private String lockSession(String tenant, String session) {
        var status = jdbc.query("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                (row, index) -> row.getString(1), tenant, session);
        if (status.isEmpty()) {
            throw new ManagedAgentException(404, "session_not_found", "Session not found.");
        }
        return status.getFirst();
    }

    private static String commandKey(SessionPrincipal principal, String key) {
        if (!principal.actorPresent()) {
            // Preserve the pre-ownership receipt keys for callers whose
            // verified context carries no business actor.
            return DigestUtils.sha256Hex(principal.userId() + "\n" + key);
        }
        return DigestUtils.sha256Hex("session-principal-v1\0"
                + principal.userId() + "\0" + principal.actorSubjectId()
                + "\0" + key);
    }

    // A bound Session's queued actor dispatches raw: rebuilding a principal
    // from the filter-admitted actor would 400 a byte-long non-ASCII actor
    // whose queue this dispatcher drained before (R7-1). An unbound
    // dispatch keeps the exact durable principal.
    private record QueuedIdentity(String actorId, SessionPrincipal principal) { }

    private QueuedIdentity queuedIdentity(String tenant, String session,
            String messageId) {
        record QueuedActor(String actorId, boolean unbound) { }
        QueuedActor owner = jdbc.queryForObject(
                "SELECT m.actor_id, s.workspace_id IS NULL"
                        + " FROM ma_user_message m JOIN ma_session s"
                        + " ON s.tenant_id = m.tenant_id"
                        + " AND s.session_id = m.session_id"
                        + " WHERE m.tenant_id = ? AND m.session_id = ?"
                        + " AND m.message_id = ?",
                (result, index) -> new QueuedActor(result.getString(1),
                        result.getBoolean(2)),
                tenant, session, messageId);
        if (owner == null || owner.actorId() == null) {
            throw new ManagedAgentException(404, "session_not_found",
                    "The Session was not found.");
        }
        if (!owner.unbound()) {
            return new QueuedIdentity(owner.actorId(), null);
        }
        ManagedSessionPrincipal.Row row = ManagedSessionPrincipal.find(jdbc,
                tenant, session);
        if (row == null) {
            // A legacy Session never wrote an ownership row: dispatch on
            // behalf of the actor recorded on the queued message under the
            // unified authority, so a principal-created Session whose row
            // was deleted still refuses while genuine legacy queues run.
            // The raw twin never constructs a byte-bounded principal from
            // the stored actor, so a filter-admitted long actor's queue
            // keeps draining instead of wedging the tick (R11-4).
            ManagedSessionPrincipal.requireAuthority(jdbc, tenant, session,
                    owner.actorId());
            return new QueuedIdentity(owner.actorId(), null);
        }
        if (!owner.actorId().equals(row.userId())) {
            throw new ManagedAgentException(404, "session_not_found",
                    "The Session was not found.");
        }
        SessionPrincipal durable = row.actorPresent()
                ? SessionPrincipal.of(tenant, row.userId(),
                        row.actorSubjectId())
                : SessionPrincipal.ofUser(tenant, row.userId());
        return new QueuedIdentity(row.userId(), durable);
    }

    private void lock(String tenant, String session) {
        if (!"ACTIVE".equals(lockSession(tenant, session))) {
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
                jdbc.update("UPDATE ma_user_message_queue SET is_paused = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
            }
        }
        jdbc.update("UPDATE ma_user_message SET state = 'recovery_blocked' WHERE tenant_id = ? AND session_id = ? AND state = 'claimed'"
                + " AND turn_id IN (SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                + " AND status IN ('COMPLETED', 'FAILED', 'CANCELLED'))", tenant, session, tenant, session);
    }

    private Snapshot snapshot(String tenant, String session) {
        boolean paused = Boolean.TRUE.equals(jdbc.queryForObject("SELECT is_paused FROM ma_user_message_queue"
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

    public static void capture(JdbcTemplate jdbc, String tenant, String session, List<JsonNode> records) {
        for (JsonNode record : records) {
            JsonNode event = record.path("managedSession");
            if (!"message.committed".equals(event.path("kind").asText())
                    || !"user".equals(event.path("payload").path("role").asText())) {
                continue;
            }
            String identity = event.path("payload").path("messageId").asText();
            int separator = identity.lastIndexOf(':');
            if (!identity.startsWith("umsg_") || separator < 0) {
                continue;
            }
            String revisionText = identity.substring(separator + 1);
            if (revisionText.isEmpty() || revisionText.length() > 19
                    || !revisionText.chars().allMatch(character -> character >= '0' && character <= '9')) {
                continue;
            }
            long revision;
            try {
                revision = Long.parseLong(revisionText);
            } catch (NumberFormatException ignored) {
                continue;
            }
            if (revision < 1) {
                continue;
            }
            jdbc.update("UPDATE ma_user_message SET state = 'consumed', consumed_sequence = ? WHERE tenant_id = ?"
                            + " AND session_id = ? AND message_id = ? AND revision = ? AND turn_id IS NOT NULL"
                            + " AND state IN ('claimed', 'recovery_blocked', 'withdrawn')",
                    event.path("sequence").asLong(), tenant, session, identity.substring(0, separator), revision);
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
        return new ManagedAgentException(409, code, "The user message queue changed or is unavailable.");
    }
    private static ManagedAgentException refusal(String code, String message) {
        return new ManagedAgentException(400, code, message);
    }
}
