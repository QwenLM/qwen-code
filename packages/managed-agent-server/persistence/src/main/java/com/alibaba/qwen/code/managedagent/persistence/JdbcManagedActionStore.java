package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHostedRecoveryRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedUserQuestions;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.repository.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.support.DataAccessUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.closed;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.read;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.require;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.resource;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.safeNumber;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.text;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.validAnswers;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedActionJournalValidation.validateQuestionResources;

@Repository
@Qualifier("managedAgentTransactionManager")
public class JdbcManagedActionStore
        implements ManagedActionStore {
    private final JdbcTemplate jdbc;
    private final AgentStateStore sessions;

    public JdbcManagedActionStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, AgentStateStore sessions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
    }

    public String approvalMode(String tenantId, String sessionId) {
        return jdbc.queryForObject(
                "SELECT approval_mode FROM ma_session WHERE tenant_id = ? AND session_id"
                        + " = ? AND session_kind = 'PUBLIC'",
                String.class,
                tenantId,
                sessionId);
    }

    private OwnerRow ownerRow(String tenantId, String sessionId) {
        return DataAccessUtils.nullableSingleResult(jdbc.query(
                "SELECT owner_actor_key, creator_actor_key, workspace_id, tool_profile"
                        + " FROM ma_session WHERE"
                        + " tenant_id = ? AND session_id = ? AND session_kind = 'PUBLIC'",
                (result, row) -> new OwnerRow(result.getString(1),
                        result.getString(2), result.getString(3), result.getString(4)),
                tenantId, sessionId));
    }

    // Persisted ownership and the anonymous tenant-owned shape precede replay.
    private boolean ownerIdentityAdmits(OwnerRow session, String actorId) {
        String recorded = session == null ? null
                : session.owner() != null ? session.owner() : session.creator();
        if (recorded != null) {
            return actorId != null && recorded.equals(actorId);
        }
        return session != null && session.workspaceId() == null;
    }

    // The mutable half: any actor holding OPERATOR on the Session's
    // Workspace. Revocable out from under an admitted caller, so admit
    // evaluates it after the actor-scoped replay.
    private boolean workspaceOperatorAdmits(String tenantId,
            OwnerRow session, String actorId) {
        return session != null && session.workspaceId() != null
                && new JdbcManagedWorkspaceRegistry(jdbc)
                        .accessOf(tenantId, actorId, session.workspaceId()).canCreate();
    }

    private record OwnerRow(String owner, String creator, String workspaceId, String toolProfile) {
    }

    private static ManagedAgentException forbidden() {
        return new ManagedAgentException(
                403,
                "action_forbidden",
                "Only the Session's owner or a Workspace operator may answer its Actions.");
    }

    private static ManagedAgentException shellForbidden() {
        return new ManagedAgentException(
                403,
                "action_forbidden",
                "Only the Session's recorded owner may answer its Shell Actions.");
    }

    void apply(
            String tenantId,
            String workspaceId,
            String sessionId,
            long firstSequence,
            int eventCount,
            byte[] bytes,
            Function<String, StoredResource> resources) {
        apply(tenantId, workspaceId, sessionId, firstSequence, eventCount, bytes, resources, new java.util.HashMap<>());
    }

    void apply(String tenantId, String workspaceId, String sessionId, long firstSequence,
            int eventCount, byte[] bytes, Function<String, StoredResource> resources, Map<String, JsonNode> hostedReferences) {
        int index = -1;
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            index++;
            JsonNode record = read(line);
            if (!"managed_session_event_v1".equals(record.path("subtype").asText())) {
                continue;
            }
            JsonNode event = record.path("managedSession");
            if (!"action.changed".equals(event.path("kind").asText())) {
                continue;
            }
            jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id=? AND session_id=? FOR UPDATE",
                    String.class, tenantId, sessionId);
            JsonNode envelope = event.deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) envelope).remove("subject");
            if (event.has("subject")) {
                JsonNode subject = event.path("subject");
                closed(subject, "type", "scopeId", "activationId", "epoch");
                require(
                        "activation".equals(subject.path("type").asText())
                                && text(subject.path("scopeId"))
                                && text(subject.path("activationId"))
                                && safeNumber(subject.path("epoch"))
                                && subject.path("epoch").asLong() >= 1);
            }
            closed(
                    envelope,
                    "v",
                    "sequence",
                    "eventId",
                    "sessionKey",
                    "kind",
                    "occurredAt",
                    "payload");
            require(text(event.path("eventId")));
            require(
                    index < eventCount
                            && safeNumber(event.path("v"))
                            && event.path("v").asLong() == 1
                            && safeNumber(event.path("sequence"))
                            && event.path("sequence").asLong() == firstSequence + index
                            && safeNumber(event.path("occurredAt")));
            JsonNode key = event.path("sessionKey");
            closed(key, "tenantId", "workspaceId", "sessionId");
            require(
                    tenantId.equals(key.path("tenantId").asText())
                            && workspaceId.equals(key.path("workspaceId").asText())
                            && sessionId.equals(key.path("sessionId").asText()));
            JsonNode payload = event.path("payload");
            closed(
                    payload,
                    "requestId",
                    "kind",
                    "source",
                    "inputRevision",
                    "optionsRef",
                    "state",
                    "decisionRef");
            require(
                    safeNumber(payload.path("inputRevision"))
                            && payload.path("inputRevision").asLong() >= 1);
            String id = payload.path("requestId").asText();
            String state = payload.path("state").asText();
            require(
                    JdbcManagedActionStore.ACTION_ID.matcher(id).matches()
                            && List.of("permission", "question").contains(payload.path("kind").asText())
                            && "tool_call".equals(payload.path("source").asText())
                            && List.of("requested", "decided", "expired", "cancelled")
                                    .contains(state));
            JsonNode ref = payload.path("optionsRef");
            StoredResource resource = resource(ref, "managed-action-options", resources);
            JsonNode options = read(new String(resource.bytes(), StandardCharsets.UTF_8));
            boolean question = ManagedUserQuestions.isQuestion(options);
            require((question ? "question" : "permission").equals(payload.path("kind").asText()));
            List<String> optionFields = new ArrayList<>(List.of(
                    "v",
                    "requestId",
                    "turnId",
                    "functionCallId",
                    "toolName",
                    "policyRevision",
                    "inputRevision",
                    "createdAt",
                    "expiresAt",
                    question ? "questions" : "options"));
            if (options.has("inputRef")) {
                optionFields.add("inputRef");
            }
            if (options.has("continuationRef")) {
                optionFields.add("continuationRef");
            }
            if (options.has("requiresHumanDecision")) {
                optionFields.add("requiresHumanDecision");
                require(options.path("requiresHumanDecision").isBoolean() && options.path("requiresHumanDecision").booleanValue());
            }
            closed(options, optionFields.toArray(String[]::new));
            require(
                    safeNumber(options.path("v"))
                            && (options.path("v").asLong() == 3 || question)
                            && (!question || options.has("inputRef") && options.has("continuationRef"))
                            && id.equals(options.path("requestId").asText())
                            && safeNumber(options.path("inputRevision"))
                            && options.path("inputRevision").asLong()
                                    == payload.path("inputRevision").asLong()
                            && options.path("inputRevision").asLong() >= 1
                            && options.path("policyRevision")
                                    .asText()
                                    .equals(question ? ManagedUserQuestions.POLICY : "hosted-tool-approval/1")
                            && text(options.path("turnId"))
                            && text(options.path("functionCallId"))
                            && text(options.path("toolName"))
                            && safeNumber(options.path("createdAt"))
                            && safeNumber(options.path("expiresAt"))
                            && options.path("expiresAt").asLong()
                                    > options.path("createdAt").asLong());
            if (question) {
                validateQuestionResources(sessionId, options, resources);
            } else {
                require(options.path("options").isArray() && options.path("options").size() == 2
                        && "allow".equals(options.path("options").get(0).path("id").asText())
                        && "deny".equals(options.path("options").get(1).path("id").asText()));
                for (JsonNode option : options.path("options")) {
                    closed(option, "id", "label");
                    require(text(option.path("label")));
                }
            }
            if (options.has("inputRef")) {
                String inputKind = options.path("inputRef").path("kind").asText();
                boolean command = options.path("v").asLong() == 3 && "managed-extension-command-input".equals(inputKind);
                resource(options.path("inputRef"), command ? inputKind : "managed-tool-input", resources);
                if (command) {
                    JsonNode continuation = read(new String(resource(options.path("continuationRef"),
                            "hosted-approval-continuation", resources).bytes(), StandardCharsets.UTF_8));
                    JsonNode step = continuation.path("commandStep");
                    String toolName = "shell".equals(step.path("toolName").asText()) ? "run_shell_command" : "read_file";
                    int ordinal = continuation.path("approvalOrdinal").asInt(-1);
                    require(ordinal >= 0 && ordinal < continuation.path("calls").size()
                            && options.path("inputRef").equals(step.path("inputRef"))
                            && toolName.equals(options.path("toolName").asText())
                            && id.equals(continuation.path("actionId").asText())
                            && options.path("functionCallId").equals(continuation.path("calls").get(ordinal).path("call").path("callId")));
                }
            }
            if (options.has("continuationRef")) {
                ManagedHostedRecoveryRecords.reference(options.path("continuationRef"), "hosted-approval-continuation", tenantId, workspaceId, sessionId, resources, hostedReferences);
            }
            Action previous = find(tenantId, sessionId, id).orElse(null);
            require(
                    previous == null
                            ? "requested".equals(state)
                            : previous.options().equals(options)
                                    && "requested".equals(previous.state())
                                    && !"requested".equals(state));
            JsonNode decision = payload.path("decisionRef");
            String receipt = null;
            String digest = null;
            if ("decided".equals(state)) {
                StoredResource decided = resource(decision, "managed-action-decision", resources);
                JsonNode body = read(new String(decided.bytes(), StandardCharsets.UTF_8));
                closed(body, "v", question ? "answers" : "optionId", "inputRevision", "policyRevision");
                require(
                        safeNumber(body.path("v"))
                                && body.path("v").asLong() == (question ? 2 : 1)
                                && (question ? validAnswers(options, body.path("answers"))
                                        : List.of("allow", "deny").contains(body.path("optionId").asText()))
                                && body.path("inputRevision").equals(options.path("inputRevision"))
                                && body.path("policyRevision")
                                        .equals(options.path("policyRevision"))
                                && decided.digest().equals(ManagedActionStore.decisionDigest(body)));
                receipt =
                        "decision_"
                                + ManagedExtensionProjection.recordKey(
                                        sessionId, "action_decision", id + ":" + decided.digest());
                digest = decided.digest();
                if ("allow".equals(body.path("optionId").asText()) && options.has("continuationRef")
                        && publicPlanExit(tenantId, sessionId, options)) {
                    JsonNode input = read(new String(resource(options.path("inputRef"), "managed-tool-input", resources).bytes(),
                            StandardCharsets.UTF_8));
                    JsonNode request = read(input.path("payloadJson").asText());
                    JsonNode continuation = read(new String(resource(options.path("continuationRef"),
                            "hosted-approval-continuation", resources).bytes(), StandardCharsets.UTF_8));
                    require(sessionId.equals(input.path("harnessSessionId").asText())
                            && "exit_plan_mode".equals(request.path("toolName").asText())
                            && request.path("input").size() == 1 && request.path("input").path("plan").isTextual()
                            && !request.path("input").path("plan").asText().isBlank()
                            && continuation.path("promptId").equals(options.path("turnId"))
                            && continuation.path("calls").size() == 1
                            && continuation.path("calls").get(0).path("call").path("name").asText().equals("exit_plan_mode")
                            && continuation.path("calls").get(0).path("call").path("callId").equals(options.path("functionCallId"))
                            && continuation.path("calls").get(0).path("inputRef").equals(options.path("inputRef"))
                            && continuation.path("calls").get(0).path("actionId").asText().equals(id));
                    jdbc.update("UPDATE ma_session SET is_plan_enabled=FALSE, approval_revision=approval_revision+1,"
                                    + " version=version+1, gmt_modified=? WHERE tenant_id=? AND session_id=? AND is_plan_enabled=TRUE"
                                    + " AND EXISTS (SELECT 1 FROM ma_turn WHERE tenant_id=? AND session_id=?"
                                    + " AND prompt_id=? AND is_plan_enabled=TRUE AND status IN ('ACCEPTED','RUNNING'))",
                            event.path("occurredAt").asLong(), tenantId, sessionId, tenantId, sessionId,
                            options.path("turnId").asText());
                }
            } else {
                require(decision.isNull());
            }
            if (previous == null) {
                jdbc.update("INSERT INTO ma_session_record (tenant_id, workspace_id, session_id, record_kind, domain, record_id, action_id, revision, action_version, state, options_json, prompt_id, gmt_create, first_sequence) VALUES (?, ?, ?, 'ACTION', 'action', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        tenantId, workspaceId, sessionId, id, id,
                        event.path("sequence").asLong(), options.path("inputRevision").asLong(),
                        state, options.toString(), options.path("turnId").asText(), options.path("createdAt").asLong(), event.path("sequence").asLong());
            } else {
                jdbc.update("UPDATE ma_session_record SET state = ?, decision_receipt_id = ?,"
                                + " decision_digest = ?, revision = ? WHERE tenant_id = ? AND session_id = ?"
                                + " AND record_kind = 'ACTION' AND action_id = ?",
                        state, receipt, digest, event.path("sequence").asLong(), tenantId, sessionId, id);
            }
            replaceActionReferences(tenantId, workspaceId, sessionId, id,
                    event.path("sequence").asLong(), ref, options, decision);
            if (jdbc.queryForObject(
                            "SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND"
                                    + " session_id = ? AND session_kind = 'PUBLIC'",
                            Integer.class,
                            tenantId,
                            sessionId)
                    == 1) {
                sessions.appendPublicEventIfAbsent(
                        tenantId,
                        sessionId,
                        null,
                        "action.updated",
                        Map.of("actionId", id, "state", state),
                        false,
                        "action:" + id + ":" + event.path("sequence").asLong());
            }
        }
    }

    private void replaceActionReferences(String tenantId, String workspaceId, String sessionId,
            String actionId, long revision, JsonNode optionsRef, JsonNode options, JsonNode decisionRef) {
        String ownerRef = JdbcManagedExtensionRecordStore.sessionRecordOwnerRef(
                sessionId, "action", actionId);
        List<JsonNode> refs = new ArrayList<>(List.of(optionsRef));
        if (options.has("inputRef")) {
            refs.add(options.get("inputRef"));
        }
        if (options.has("continuationRef")) {
            refs.add(options.get("continuationRef"));
        }
        if (decisionRef != null && !decisionRef.isNull()) {
            refs.add(decisionRef);
        }
        jdbc.update(
                "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind ="
                        + " 'SESSION_RECORD' AND owner_ref = ?",
                tenantId, sessionId, ManagedSchemaKeys.identity(ownerRef));
        for (JsonNode ref : refs) {
            String resourceId = ref.path("resourceId").asText();
            jdbc.update(
                    "INSERT INTO ma_resource_ref (owner_kind, owner_ref, owner_revision, tenant_id, workspace_id, session_id, resource_id, gmt_create) VALUES ('SESSION_RECORD', ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                    ManagedSchemaKeys.identity(ownerRef), revision, tenantId, workspaceId, sessionId, resourceId);
        }
    }

    private boolean publicPlanExit(String tenantId, String sessionId, JsonNode options) {
        return options.path("v").asInt() == 3 && options.path("toolName").asText().equals("exit_plan_mode")
                && jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn t JOIN ma_session s ON s.tenant_id=t.tenant_id"
                        + " AND s.session_id=t.session_id WHERE t.tenant_id=? AND t.session_id=? AND t.prompt_id=?"
                        + " AND t.is_plan_enabled=TRUE AND s.session_kind='PUBLIC' AND s.parent_session_id IS NULL",
                        Integer.class, tenantId, sessionId, options.path("turnId").asText()) == 1;
    }

    public Optional<Action> find(String tenantId, String sessionId, String id) {
        if (!JdbcManagedActionStore.ACTION_ID.matcher(id).matches()) {
            return Optional.empty();
        }
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns() + " FROM ma_session_record WHERE record_kind = 'ACTION' AND tenant_id = ? AND session_id = ? AND action_id = ?",
                        (r, row) ->
                                new Action(
                                        r.getString("action_id"),
                                        r.getString("state"),
                                        read(r.getString("options_json")),
                                        r.getString("decision_receipt_id"),
                                        r.getString("decision_digest")),
                        tenantId, sessionId, id)
                .stream()
                .findFirst();
    }

    public List<ScopedAction> listWithChildren(String tenant, String parent, Long before,
            String beforeSession, String beforeId, int limit) {
        List<Object> args = new ArrayList<>(List.of(tenant, parent, parent));
        String cursor = "";
        if (before != null) {
            cursor = " AND (r.gmt_create < ? OR r.gmt_create = ? AND (r.session_id < ?"
                    + " OR r.session_id = ? AND r.action_id < ?))";
            args.addAll(List.of(before, before, beforeSession, beforeSession, beforeId));
        }
        args.add(limit);
        return jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns("r")
                        + " FROM ma_session_record r JOIN ma_session s ON s.tenant_id=r.tenant_id"
                        + " AND s.session_id=r.session_id AND s.is_publication_retention_registered = 1"
                        + " WHERE r.tenant_id=? AND r.record_kind='ACTION'"
                        + " AND r.state='requested' AND s.deleted_at IS NULL AND (s.session_id=?"
                        + " OR s.parent_session_id=? AND s.public_child_agents_version=1)" + cursor
                        + " ORDER BY r.gmt_create DESC, r.session_id DESC, r.action_id DESC LIMIT ?",
                (row, index) -> new ScopedAction(row.getString("session_id"),
                        new Action(row.getString("action_id"), row.getString("state"),
                                read(row.getString("options_json")), row.getString("decision_receipt_id"),
                                row.getString("decision_digest"))), args.toArray());
    }

    public List<Action> list(
            String tenantId, String sessionId, Long before, String beforeId, int limit) {
        List<Object> args = new ArrayList<>(List.of(tenantId, sessionId));
        String cursor = "";
        if (before != null) {
            cursor = " AND (gmt_create < ? OR gmt_create = ? AND action_id < ?)";
            args.add(before);
            args.add(before);
            args.add(beforeId);
        }
        args.add(limit);
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.SESSION_RECORD.columns() + " FROM ma_session_record WHERE record_kind = 'ACTION' AND tenant_id = ? AND session_id = ? AND state = 'requested'"
                        + cursor
                        + " ORDER BY gmt_create DESC, action_id DESC LIMIT ?",
                (r, row) ->
                        new Action(
                                r.getString("action_id"),
                                r.getString("state"),
                                read(r.getString("options_json")),
                                r.getString("decision_receipt_id"),
                                r.getString("decision_digest")),
                args.toArray());
    }

    @Transactional
    public OperationAdmission admit(
            String tenantId,
            String sessionId,
            SessionPrincipal principal,
            String actorId,
            String actorDigest,
            String key,
            String requestDigest,
            String actionId,
            JsonNode body,
            long now) {
        // Serialize admission with journal projection and other Session commands.
        // The guard may have opened an older repeatable-read snapshot.
        String sessionStatus = jdbc.queryForObject(
                "SELECT status FROM ma_session WHERE tenant_id = ? AND session_id ="
                        + " ? AND session_kind = 'PUBLIC' FOR UPDATE",
                String.class,
                tenantId,
                sessionId);
        OwnerRow ownerRow = ownerRow(tenantId, sessionId);
        // The immutable owner arms answer before the replay; the mutable
        // Workspace role arm follows it, so a role revoked after admission
        // still resolves a retry to the caller's own operation. The owner
        // arm holds the caller to the ownership record's granularity (R13-4).
        // Owner identity compares the raw actor id, and the principal ownership
        // recheck stays on top of it (R13-4).
        boolean admitted = ownerIdentityAdmits(ownerRow, actorId)
                && ManagedSessionPrincipal.permits(jdbc, tenantId, sessionId, principal);
        List<String> replay =
                jdbc.query(
                        "SELECT operation_id FROM ma_operation WHERE scope_kind = 'SESSION' AND scope_id = ? AND target_id ="
                            + " ? AND tenant_id = ? AND session_id = ? AND operation_kind ="
                            + " 'ACTION_RESPONSE' AND actor_digest = ? AND idempotency_digest = ?"
                            + " AND idempotency_key = ?",
                        (r, row) -> r.getString(1),
                        ManagedSchemaKeys.identity(sessionId), ManagedSchemaKeys.identity(sessionId),
                        tenantId, sessionId, actorDigest, ManagedSchemaKeys.key(key), key);
        if (!replay.isEmpty()) {
            OperationRecord existing =
                    sessions.findOperation(tenantId, sessionId, replay.get(0)).orElseThrow();
            if (!existing.requestDigest().equals(requestDigest)) {
                throw new ManagedAgentException(
                        409,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            if ("FAILED".equals(existing.state())
                    && ("action_response_delivery_failed"
                                    .equals(existing.failureCode())
                            || "action_response_decision_expired"
                                    .equals(existing.failureCode()))) {
                // The delivery failed past its budget while the Action is
                // still waiting: the caller's retry re-admits the same
                // response under the same key, digest and row — a second
                // vote stays impossible — instead of returning the stale
                // failure receipt forever. Only the budget terminal is
                // re-admissible: a FAILED the Harness itself produced (a
                // definitive 400 invalid_action_response, or an ended
                // Action) keeps replaying its recorded terminal row, since
                // re-sending the identical body would only repeat a refusal
                // the Harness already made. The Session gate does apply:
                // on a Session that no longer accepts responses the replay
                // keeps returning the recorded failure instead of
                // re-admitting deliveries that can never land. The Action's
                // expiry applies too: a fresh admission would refuse it
                // 409 action_expired, and a resurrected PENDING row for an
                // expired Action could never complete — it would only wedge
                // lifecycle admission, which counts any open operation. A
                // decision-expired row can never satisfy that expiry guard
                // again — its Action's deadline has already passed — so for
                // it only the digest-match heal below applies.
                Response failedResponse = response(tenantId, sessionId,
                        existing.operationId());
                Optional<Action> action = failedResponse.actionId() == null
                        ? Optional.empty()
                        : find(tenantId, sessionId, failedResponse.actionId());
                String replayStorage = jdbc.queryForObject(
                        "SELECT workspace_storage_id FROM"
                                + " ma_session WHERE tenant_id = ?"
                                + " AND session_id = ?",
                        String.class, tenantId, sessionId);
                // A workspace migration holding the storage fence blocks a
                // resurrected delivery exactly like a fresh admission
                // (requireSessionOpen below): the fence is the migration's
                // own evidence that a new write must wait. The heal path
                // must not throw, though — a held fence falls through to the
                // recorded terminal failure, which keeps replaying with its
                // re-admissibility intact until the fence lifts (review
                // round 7, R7-4).
                if (action.isPresent()
                        && "requested".equals(action.get().state())
                        && now < action.get().options().path("expiresAt")
                                .asLong()
                        && "ACTIVE".equals(sessionStatus)
                        && (replayStorage == null
                                || WorkspaceMigrationAdmission.owner(jdbc,
                                        tenantId, replayStorage) == null)) {
                    // The resurrect re-arms a delivery, so the mutable
                    // actor gate is re-evaluated here: a Workspace role
                    // revoked after the first delivery failed must not
                    // re-admit the answer (review round 10, R10-1). The
                    // read-only replay below stays open to it.
                    if (!admitted && !workspaceOperatorAdmits(tenantId,
                            ownerRow, actorId)) {
                        throw forbidden();
                    }
                    // Re-arming a delivery certifies delivery exactly like
                    // a fresh admission, so the same execution-facts gate
                    // applies: a bound Session whose creator-keyed facts
                    // lapsed gets the fresh path's 409 instead of a
                    // PENDING row the arbiter can never reach (review
                    // round 12, R12-2). The read-only heal below arms no
                    // delivery and needs no gate.
                    if (ownerRow.workspaceId() != null
                            && !sessions.hasExecutionRegistryFacts(tenantId,
                                    sessionId)) {
                        throw new ManagedAgentException(409,
                                "workspace_unavailable",
                                "Hosted Workspace execution is not available.");
                    }
                    jdbc.update("UPDATE ma_operation SET state ="
                                    + " 'PENDING', phase = 'PENDING',"
                                    + " delivery_state ="
                                    + " 'PENDING', failure_code = NULL,"
                                    + " attempt_count = 0,"
                                    + " budget_exempt_attempt = 0,"
                                    + " claim_owner ="
                                    + " NULL, claim_until = NULL, receipt_id"
                                    + " = NULL, available_at = ?, gmt_modified"
                                    + " = ?, completed_at = NULL WHERE"
                                    + " tenant_id = ? AND session_id = ? AND"
                                    + " operation_id = ?",
                            now, now, tenantId, sessionId,
                            existing.operationId());
                    AgentActionParking.unparkActionTurns(jdbc, tenantId, sessionId, now);
                    return new OperationAdmission(
                            sessions.findOperation(tenantId, sessionId,
                                    existing.operationId()).orElseThrow(),
                            true);
                }
                // The projection shows the Action decided with THIS
                // response's own decision — the delivery did land and only
                // Java's record is wrong, so the replay settles the row in
                // place with the decision receipt instead of returning the
                // stale failure forever. The row is never resurrected to
                // PENDING, so a second vote stays impossible; a digest
                // mismatch (another actor's decision, an expired or
                // cancelled Action) keeps replaying the recorded failure.
                if (action.isPresent()
                        && "decided".equals(action.get().state())
                        && action.get().decisionDigest() != null
                        && action.get().decisionDigest().equals(
                                ManagedActionStore.decisionDigest(failedResponse.body()))) {
                    // The heal settles the row: same gate, same reason.
                    if (!admitted && !workspaceOperatorAdmits(tenantId,
                            ownerRow, actorId)) {
                        throw forbidden();
                    }
                    jdbc.update("UPDATE ma_operation SET state ="
                                    + " 'COMPLETED', phase = 'SETTLED',"
                                    + " admission_stage ="
                                    + " 'HARNESS_CONFIRMED', delivery_state ="
                                    + " 'CONFIRMED', receipt_id = ?,"
                                    + " failure_code = NULL,"
                                    + " decision_receipt_id = ?, claim_owner"
                                    + " = NULL, claim_until = NULL,"
                                    + " gmt_modified = ?, completed_at = ?"
                                    + " WHERE tenant_id = ? AND session_id ="
                                    + " ? AND operation_id = ? AND state ="
                                    + " 'FAILED' AND failure_code IN"
                                    + " ('action_response_delivery_failed',"
                                    + " 'action_response_decision_expired')",
                            "rcpt_" + UUID.randomUUID().toString()
                                    .replace("-", ""),
                            action.get().decisionReceiptId(),
                            now, now, tenantId, sessionId,
                            existing.operationId());
                    AgentActionParking.unparkActionTurns(jdbc, tenantId, sessionId, now);
                    return new OperationAdmission(
                            sessions.findOperation(tenantId, sessionId,
                                    existing.operationId()).orElseThrow(),
                            true);
                }
            }
            return new OperationAdmission(existing, true);
        }
        // A Shell answer runs a command, so the Workspace-operator arm does
        // not apply. Other Actions keep that arm.
        boolean shell = ownerRow != null && WorkspaceToolProfiles.isPublicShell(ownerRow.toolProfile());
        if (!admitted && (shell || !workspaceOperatorAdmits(tenantId, ownerRow, actorId))) {
            throw shell ? shellForbidden() : forbidden();
        }
        // Every bound admission certifies delivery exactly like the
        // submitter family: the recorded create-command actor must still
        // back execution, so a demoted creator moves an answer to 409
        // rather than letting it be queued where the arbiter can never
        // reach — whichever arm admitted the caller.
        if (ownerRow.workspaceId() != null
                && !sessions.hasExecutionRegistryFacts(tenantId, sessionId)) {
            throw new ManagedAgentException(409, "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
        WorkspaceMigrationAdmission.requireSessionOpenForAdmission(jdbc, tenantId, sessionId);
        if (!"ACTIVE".equals(sessionStatus)) {
            throw new ManagedAgentException(409, "session_inactive", "The Session does not accept responses.");
        }
        Action action =
                find(tenantId, sessionId, actionId)
                        .orElseThrow(
                                () ->
                                        new ManagedAgentException(
                                                404,
                                                "action_not_found",
                                                "The Action was not found."));
        JsonNode o = action.options();
        if (publicPlanExit(tenantId, sessionId, o)
                && (!admitted || !workspaceOperatorAdmits(tenantId, ownerRow, actorId))) {
            throw new ManagedAgentException(403, "action_forbidden",
                    "Only the Session owner with current OPERATOR access may approve a public plan.");
        }
        if (body.size() != 3
                || (ManagedUserQuestions.isQuestion(o) ? !validAnswers(o, body.path("answers"))
                        : !body.path("optionId").isTextual()
                                || !List.of("allow", "deny").contains(body.path("optionId").asText()))
                || !body.path("inputRevision").isIntegralNumber()
                || body.path("inputRevision").asLong() != o.path("inputRevision").asLong()
                || !body.path("policyRevision").equals(o.path("policyRevision"))) {
            throw new ManagedAgentException(
                    400,
                    "invalid_action_response",
                    "The response does not match the original Action.");
        }
        if (!"requested".equals(action.state())) {
            throw new ManagedAgentException(
                    409,
                    ManagedActionStore.endedCode(action.state()),
                    "The Action has already ended.");
        }
        if (now >= o.path("expiresAt").asLong()) {
            throw new ManagedAgentException(
                    409, "action_expired", "The Action has expired.");
        }
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String actionScope = ManagedSchemaKeys.key(scope, actionId, Long.toString(o.path("inputRevision").asLong()));
        String decision = ManagedActionStore.decisionDigest(body);
        List<String[]> reserved = jdbc.query(
                        "SELECT request_digest, result_operation_ref FROM ma_request_receipt WHERE"
                                + " namespace = 'ACTION_DECISION' AND tenant_id = ? AND"
                                + " scope_ref = ?",
                (r, row) -> new String[]{r.getString(1), r.getString(2)}, tenantId,
                ManagedSchemaKeys.identity(ManagedIdentityRefs.receiptScopeRef(tenantId, actionScope)));
        if (!reserved.isEmpty()) {
            if (!decision.equals(reserved.getFirst()[0])) {
                throw new ManagedAgentException(409, "action_already_resolved", "A different Action decision is already admitted.");
            }
            String original = jdbc.queryForObject("SELECT operation_id FROM ma_operation WHERE operation_ref = ?",
                    String.class, ManagedSchemaKeys.identity(reserved.getFirst()[1]));
            return new OperationAdmission(sessions.findOperation(tenantId, sessionId, original).orElseThrow(), true);
        }
        String op = "op_" + UUID.randomUUID().toString().replace("-", "");
        String operationRef = ManagedIdentityRefs.operationRef(OperationKind.ACTION_RESPONSE.name(),
                tenantId, "SESSION", sessionId, sessionId, op);
        jdbc.update(
                "INSERT INTO ma_operation (operation_ref, scope_kind, scope_id, target_kind, target_id, tenant_id, session_id, operation_id, operation_kind, actor_digest, idempotency_key, idempotency_digest, request_digest, request_json, phase, state, admission_stage, delivery_state, session_status_before, available_at, gmt_create, gmt_modified, action_id) VALUES (?, ?, ?, 'SESSION', ?, ?, ?, ?, 'ACTION_RESPONSE', ?, ?, ?, ?, ?, 'PENDING', 'PENDING', 'JAVA_DURABLE', 'PENDING', 'ACTIVE', ?, ?, ?, ?)",
                ManagedSchemaKeys.identity(operationRef), "SESSION", ManagedSchemaKeys.identity(sessionId), ManagedSchemaKeys.identity(sessionId), tenantId, sessionId, op,
                actorDigest, key, ManagedSchemaKeys.key(key), requestDigest, body.toString(), now, now, now, actionId);
        jdbc.update(
                "INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_id, scope_kind, scope_ref, scope_id, idempotency_key, idempotency_digest, request_digest, state, session_id, action_id, action_version, result_operation_ref, gmt_create, gmt_modified) VALUES (?, 'ACTION_DECISION', ?, 'SESSION', ?, ?, ?, ?, ?, 'ADMITTED', ?, ?, ?, ?, ?, ?)",
                ManagedSchemaKeys.receiptKey(ReceiptNamespace.ACTION_DECISION, tenantId, ReceiptScope.SESSION, actionScope, actionId),
                tenantId, ManagedSchemaKeys.identity(ManagedIdentityRefs.receiptScopeRef(tenantId, actionScope)), ManagedSchemaKeys.identity(actionScope), actionId, ManagedSchemaKeys.key(actionId), decision,
                sessionId, actionId, o.path("inputRevision").asLong(), ManagedSchemaKeys.identity(operationRef), now, now);
        AgentActionParking.unparkActionTurns(jdbc, tenantId, sessionId, now);

        return new OperationAdmission(
                sessions.findOperation(tenantId, sessionId, op).orElseThrow(), false);
    }

    public Optional<String> publicTurnId(String tenantId, String sessionId, String promptId) {
        return jdbc
                .query(
                        "SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id"
                                + " = ? AND prompt_id = ?",
                        (r, row) -> r.getString(1),
                        tenantId,
                        sessionId,
                        promptId)
                .stream()
                .findFirst();
    }

    public Response response(String tenantId, String sessionId, String op) {
        return jdbc.queryForObject(
                "SELECT action_id, request_json, failure_code, decision_receipt_id FROM"
                        + " ma_operation WHERE tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ? AND operation_kind = 'ACTION_RESPONSE'",
                (r, row) ->
                        new Response(
                                r.getString(1),
                                read(r.getString(2)),
                                r.getString(3),
                                r.getString(4)),
                tenantId,
                sessionId,
                op);
    }

    public List<OperationTarget> deliverable(long now) {
        return jdbc.query(
                "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE operation_kind = 'ACTION_RESPONSE' AND ((delivery_state = 'PENDING' AND available_at <= ?) OR (delivery_state = 'LEASED' AND claim_until < " + ManagedSchemaTime.SQL_NOW + ")) AND state IN ('PENDING', 'RUNNING') ORDER BY available_at LIMIT 50",
                (r, row) -> new OperationTarget(r.getString(1), r.getString(2), r.getString(3)),
                now);
    }

    public void settleEndedResponses(long now) {
        record EndedResponse(OperationTarget target, JsonNode body, String actionState,
                String decisionDigest, String decisionReceiptId) { }
        List<EndedResponse> ended = jdbc.query(
                        "SELECT o.tenant_id, o.session_id, o.operation_id, o.request_json,"
                            + " a.state, a.decision_digest, a.decision_receipt_id FROM ma_operation o JOIN"
                            + " ma_session_record a ON a.record_kind = 'ACTION' AND"
                            + " a.tenant_id = o.tenant_id AND"
                            + " a.session_id = o.session_id AND a.action_id = o.action_id WHERE"
                            + " o.operation_kind = 'ACTION_RESPONSE' AND o.delivery_state IN"
                            + " ('PENDING', 'LEASED') AND a.state <> 'requested' LIMIT 50",
                (r, row) -> new EndedResponse(
                        new OperationTarget(r.getString(1), r.getString(2), r.getString(3)),
                        read(r.getString(4)), r.getString(5), r.getString(6), r.getString(7)));
        for (EndedResponse response : ended) {
            OperationTarget target = response.target();
            boolean matched = "decided".equals(response.actionState())
                    && ManagedActionStore.decisionDigest(response.body()).equals(response.decisionDigest());
            jdbc.update(
                    "UPDATE ma_operation SET state = ?, phase = 'SETTLED', admission_stage = 'HARNESS_CONFIRMED', delivery_state = 'CONFIRMED', receipt_id = ?, failure_code = ?, decision_receipt_id = ?, claim_owner = NULL, claim_until = NULL, gmt_modified = ?, completed_at = ? WHERE tenant_id = ? AND session_id = ? AND operation_id = ? AND operation_kind = 'ACTION_RESPONSE' AND delivery_state IN ('PENDING', 'LEASED')",
                    matched ? "COMPLETED" : "FAILED",
                    "rcpt_" + UUID.randomUUID().toString().replace("-", ""),
                    matched ? null : ManagedActionStore.endedCode(response.actionState()),
                    matched ? response.decisionReceiptId() : null,
                    now, now, target.tenantId(), target.sessionId(), target.operationId());
        }
    }

    @Transactional
    public void complete(
            OperationRecord op,
            String owner,
            String errorCode,
            String decisionReceiptId,
            boolean harnessConfirmed,
            long now) {
        jdbc.update(
                "UPDATE ma_operation SET state = ?, phase = 'SETTLED', admission_stage = ?, delivery_state = 'CONFIRMED', receipt_id = ?, failure_code = ?, decision_receipt_id = ?, claim_owner = NULL, claim_until = NULL, gmt_modified = ?, completed_at = ? WHERE tenant_id = ? AND session_id = ? AND operation_id = ? AND delivery_state = 'LEASED' AND claim_owner = ? AND operation_kind = 'ACTION_RESPONSE' AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW,
                errorCode == null ? "COMPLETED" : "FAILED",
                harnessConfirmed ? "HARNESS_CONFIRMED" : "JAVA_DURABLE",
                "rcpt_" + UUID.randomUUID().toString().replace("-", ""),
                errorCode,
                decisionReceiptId,
                now,
                now,
                op.tenantId(),
                op.sessionId(),
                op.operationId(),
                owner,
                op.claimGeneration());
    }
}
