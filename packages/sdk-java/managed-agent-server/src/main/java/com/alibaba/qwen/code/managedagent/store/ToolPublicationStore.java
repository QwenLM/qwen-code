package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.text;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Reserves publication capacity and fences producer grants against the Session owner. */
public final class ToolPublicationStore {
    public record Capacity(long executionBytes, long sessionBytes, long tenantBytes,
            long activeCaptures) {
        public Capacity {
            require(executionBytes > 0 && executionBytes <= ToolPublicationContract.MAX_CAPTURE_BYTES,
                    "Invalid execution capacity");
            for (long value : new long[] {sessionBytes, tenantBytes, activeCaptures}) {
                require(value > 0 && value <= ToolPublicationContract.MAX_COUNT,
                        "Invalid publication capacity");
            }
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ManagedSessionStore sessions;
    private final ToolExecutionRepository executions;
    private final RuntimeBindingRepository bindings;
    private final Capacity capacity;
    // While false, authorization keeps scanning the journal: a rolling fleet
    // with a pre-V36 binary can commit without maintaining the head columns.
    private final boolean journalHeadAuthorization;

    public ToolPublicationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedSessionStore sessions, ToolExecutionRepository executions,
            RuntimeBindingRepository bindings, Capacity capacity,
            boolean journalHeadAuthorization) {
        this.jdbc = Objects.requireNonNull(jdbc);
        this.transactions = new TransactionTemplate(manager);
        this.sessions = Objects.requireNonNull(sessions);
        this.executions = Objects.requireNonNull(executions);
        this.bindings = Objects.requireNonNull(bindings);
        this.capacity = Objects.requireNonNull(capacity);
        this.journalHeadAuthorization = journalHeadAuthorization;
    }

    // For the configuration-wiring test.
    public boolean journalHeadAuthorization() {
        return journalHeadAuthorization;
    }

    public JsonNode apply(JsonNode input, String writerToken, String publicationToken) {
        JsonNode request = ToolPublicationContract.parse("request", input);
        String operation = text(request, "operation");
        String hash = ("reserve".equals(operation) || "renew".equals(operation))
                ? ToolPublicationContract.tokenHash(publicationToken) : null;
        return transactions.execute(status -> applyLocked(request, writerToken, hash));
    }

    /** Rechecks the saved grant and original execution before installing it on a worker. */
    public JsonNode verifyDispatch(ToolExecutionRecord execution,
            String publicationId, String publicationToken) {
        RuntimeBindingRecord runtime = bindings.findById(execution.getBindingId());
        require(runtime != null, "Original Runtime binding is missing");
        var runtimeScope = runtime.getRequest().getScope();
        String tenant = runtimeScope.getTenantId();
        String workspace = runtimeScope.getWorkspaceId();
        String session = execution.getHarnessSessionId();
        String scope = hash(JSON.createArrayNode().add(tenant).add(workspace)
                .add(session).toString());
        return transactions.execute(status -> {
            String tenantKey = hash(tenant);
            jdbc.update("INSERT INTO qwen_tool_publication_tenant (tenant_key, tenant_id)"
                    + " VALUES (?, ?) ON DUPLICATE KEY UPDATE tenant_key = tenant_key",
                    tenantKey, tenant);
            String saved = jdbc.queryForObject("SELECT tenant_id FROM qwen_tool_publication_tenant"
                    + " WHERE tenant_key = ? FOR UPDATE", String.class, tenantKey);
            require(tenant.equals(saved), "Publication tenant conflicts");
            JsonNode binding = producerBindingLocked(scope, publicationId, publicationToken);
            require(publicationId.equals(text(binding, "publicationId"))
                    && execution.getExecutionCallId().equals(text(binding, "executionCallId"))
                    && execution.getRequestDigest().equals(text(binding, "requestDigest"))
                    && execution.getReference().get("argsDigest").equals(
                            text(binding.path("reference"), "argsDigest")),
                    "Original publication execution conflicts");
            return binding;
        });
    }

    JsonNode producerBindingLocked(String scope, String publicationId, String publicationToken) {
        String suppliedHash = ToolPublicationContract.tokenHash(publicationToken);
        List<Row> rows = jdbc.query("SELECT * FROM qwen_tool_publication WHERE scope_key = ?"
                        + " AND publication_id = ?",
                (r, index) -> new Row(r.getString("tenant_id"), r.getString("workspace_id"),
                        r.getString("session_id"), r.getString("binding_json"), r.getString("binding_digest"),
                        r.getString("token_hash"), r.getString("state"), r.getObject("expires_at", Long.class),
                        r.getLong("capture_bytes")), scope, publicationId);
        require(rows.size() == 1, "Publication does not exist");
        Row row = rows.get(0);
        JsonNode binding = ToolPublicationContract.parseBytes("binding",
                row.binding().getBytes(StandardCharsets.UTF_8));
        require(ToolPublicationContract.bindingDigest(binding).equals(row.digest())
                && equalHash(suppliedHash, row.tokenHash()) && "OPEN".equals(row.state()),
                "Publication grant conflicts");
        long nowEpoch = ToolPublicationRetentionStore.now(jdbc);
        require(row.expiresAt() != null && row.expiresAt() > nowEpoch,
                "Publication grant expired");
        JsonNode key = binding.get("sessionKey");
        ToolPublicationRetentionStore.requireLive(jdbc, row.tenant(), row.session());
        require(row.tenant().equals(text(key, "tenantId"))
                && row.workspace().equals(text(key, "workspaceId"))
                && row.session().equals(text(key, "sessionId")), "Publication scope conflicts");
        var head = jdbc.queryForMap("SELECT workspace_id, state, writer_id, writer_generation,"
                        + " CASE WHEN writer_lease_until > CURRENT_TIMESTAMP(6) THEN 1 ELSE 0 END AS writer_live,"
                        + " recovery_status, activation_epoch, journal_revision,"
                        + " activation_id, activation_phase, activation_event_epoch, activation_expires_at,"
                        + " activation_head_revision"
                        + " FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                row.tenant(), row.session());
        require(row.workspace().equals(head.get("workspace_id")) && "ACTIVE".equals(head.get("state"))
                && text(binding, "writerId").equals(head.get("writer_id"))
                && ((Number) head.get("writer_generation")).longValue() == binding.get("writerGeneration").longValue()
                && ((Number) head.get("writer_live")).intValue() == 1 && "READY".equals(head.get("recovery_status"))
                && ((Number) head.get("activation_epoch")).longValue() == binding.get("activationEpoch").longValue(),
                "Original Session owner is fenced");
        // The stamp says which journal revision the columns were written
        // from; a pre-V36 binary's commit bumps journal_revision without
        // touching it, so a stale head is detected and rescanned instead of
        // trusted.
        if (journalHeadAuthorization
                && (head.get("activation_phase") != null || head.get("activation_id") != null)
                && head.get("activation_head_revision") instanceof Number stamped
                && stamped.longValue() == ((Number) head.get("journal_revision")).longValue()) {
            // The head carries the last committed activation.changed payload.
            require("active".equals(head.get("activation_phase"))
                    && text(binding, "activationId").equals(head.get("activation_id"))
                    && head.get("activation_event_epoch") instanceof Number epoch
                    && epoch.longValue() == binding.get("activationEpoch").longValue()
                    && head.get("activation_expires_at") instanceof Number expires
                    && expires.longValue() > nowEpoch, "Original activation is fenced");
        } else {
            requireLegacyActivation(row.tenant(), row.session(), binding,
                    ((Number) head.get("journal_revision")).longValue(),
                    nowEpoch, head);
        }
        requireExecution(binding, true);
        var current = jdbc.queryForMap("SELECT token_hash, state, expires_at, binding_digest"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                scope, publicationId);
        require(equalHash(suppliedHash, (String) current.get("token_hash"))
                && "OPEN".equals(current.get("state"))
                && row.digest().equals(current.get("binding_digest"))
                && ((Number) current.get("expires_at")).longValue() > nowEpoch,
                "Publication grant changed");
        return binding;
    }

    /**
     * Authorizes against the journal scan for heads whose activation columns
     * predate migration V36, then backfills the head so later checks are
     * answered from the head row.
     */
    private void requireLegacyActivation(String tenant, String session,
            JsonNode binding, long journalRevision, long nowEpoch,
            java.util.Map<String, Object> head) {
        JsonNode found = null;
        for (long revision = journalRevision; revision > 0 && found == null; revision--) {
            // The locking head read can see a newer revision than this transaction's snapshot.
            byte[] record = jdbc.queryForObject("SELECT record_bytes FROM qwen_managed_session_journal_tx"
                    + " WHERE tenant_id = ? AND session_id = ? AND journal_revision = ? FOR UPDATE",
                    byte[].class, tenant, session, revision);
            String[] lines = new String(record, StandardCharsets.UTF_8).split("\n");
            for (int index = lines.length - 1; index >= 0; index--) {
                JsonNode event = ToolPublicationContract.readJson(lines[index].getBytes(StandardCharsets.UTF_8));
                if (!"managed_session_event_v1".equals(text(event, "subtype"))
                        || !"activation.changed".equals(text(event.path("managedSession"), "kind"))) {
                    continue;
                }
                // The promoted payload becomes durable trusted state, so the
                // line must pass the same scope check the other readers
                // enforce before it may backfill the head.
                JsonNode managed = event.path("managedSession");
                require(managed.path("sessionKey").equals(binding.get("sessionKey"))
                        && managed.path("v").asInt() == 1,
                        "Journal event scope conflicts");
                found = managed.path("payload");
                break;
            }
        }
        require(found != null, "Original activation is missing");
        Long expiresAt = ManagedExtensionRecords.millisLenient(
                found.path("expiresAt"));
        require("active".equals(text(found, "phase"))
                && text(binding, "activationId").equals(text(found, "activationId"))
                && binding.get("activationEpoch").longValue() == found.path("epoch").asLong()
                && expiresAt != null && expiresAt > nowEpoch,
                "Original activation is fenced");
        backfillActivation(tenant, session, text(found, "activationId"),
                text(found, "phase"), found.path("epoch").asLong(),
                expiresAt, journalRevision,
                new HeadActivation((String) head.get("activation_id"),
                        (String) head.get("activation_phase"),
                        asLong(head.get("activation_event_epoch")),
                        asLong(head.get("activation_expires_at")),
                        asLong(head.get("activation_head_revision"))));
    }

    /** The head row's current activation columns, for a no-op backfill. */
    private record HeadActivation(String id, String phase, Long eventEpoch,
            Long expiresAt, Long headRevision) {
        boolean current(String otherId, String otherPhase, long otherEpoch,
                Long otherExpiresAt, long otherRevision) {
            return Objects.equals(id, otherId) && Objects.equals(phase, otherPhase)
                    && eventEpoch != null && eventEpoch == otherEpoch
                    && Objects.equals(expiresAt, otherExpiresAt)
                    && headRevision != null && headRevision == otherRevision;
        }
    }

    private static Long asLong(Object value) {
        return value instanceof Number number ? number.longValue() : null;
    }

    /**
     * Backfills the head's activation columns from a journal scan; a head
     * already holding exactly these values is not rewritten. Both callers
     * reach this only after requiring an `active` phase and the binding's
     * contract-validated id, so the values always fit the columns.
     */
    private void backfillActivation(String tenant, String session,
            String activationId, String phase, long epoch, Long expiresAt,
            long journalRevision, HeadActivation current) {
        if (current.current(activationId, phase, epoch, expiresAt,
                journalRevision)) {
            return;
        }
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?,"
                        + " activation_head_revision = ? WHERE tenant_id = ?"
                        + " AND session_id = ?",
                activationId, phase, epoch, expiresAt, journalRevision,
                tenant, session);
    }

    private JsonNode applyLocked(JsonNode request, String writerToken, String tokenHash) {
        JsonNode key = request.get("sessionKey");
        String tenant = text(key, "tenantId");
        String workspace = text(key, "workspaceId");
        String session = text(key, "sessionId");
        String tenantKey = hash(tenant);
        String scope = hash(JSON.createArrayNode().add(tenant).add(workspace).add(session).toString());
        // Every mutation uses this order, including no-start capacity release.
        jdbc.update("INSERT INTO qwen_tool_publication_tenant (tenant_key, tenant_id) VALUES (?, ?)"
                + " ON DUPLICATE KEY UPDATE tenant_key = tenant_key", tenantKey, tenant);
        String savedTenant = jdbc.queryForObject("SELECT tenant_id FROM qwen_tool_publication_tenant"
                + " WHERE tenant_key = ? FOR UPDATE", String.class, tenantKey);
        require(tenant.equals(savedTenant), "Tenant key conflicts");
        JsonNode owner = request.get("owner");
        var writer = sessions.lockPublicationWriter(tenant, workspace, session,
                text(owner, "writerId"), owner.get("writerGeneration").longValue(), writerToken);
        String operation = text(request, "operation");
        JsonNode candidate = request.get("binding");
        String id = candidate == null ? text(request, "publicationId") : text(candidate, "publicationId");
        List<Row> rows = jdbc.query("SELECT * FROM qwen_tool_publication"
                        + " WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                (r, index) -> new Row(r.getString("tenant_id"), r.getString("workspace_id"),
                        r.getString("session_id"), r.getString("binding_json"),
                        r.getString("binding_digest"), r.getString("token_hash"),
                        r.getString("state"), r.getObject("expires_at", Long.class),
                        r.getLong("capture_bytes")), scope, id);
        Row row = rows.isEmpty() ? null : rows.get(0);
        if (row != null) {
            require(tenant.equals(row.tenant()) && workspace.equals(row.workspace())
                    && session.equals(row.session()), "Publication scope conflicts");
        }
        if ("reserve".equals(operation)) {
            long bytes = request.get("captureBytes").longValue();
            String digest = ToolPublicationContract.bindingDigest(candidate);
            if (row != null) {
                require(digest.equals(row.digest()) && bytes == row.captureBytes()
                        && equalHash(tokenHash, row.tokenHash()), "Reservation replay conflicts");
                require("OPEN".equals(row.state()), "Reservation is fenced");
                requireEvidence(candidate, writerToken, writer, false);
                require(row.expiresAt() > writer.now(), "Reservation expired; renew explicitly");
                return grant(id, row);
            }
            long expires = requireEvidence(candidate, writerToken, writer, true);
            require(bytes <= capacity.executionBytes(), "Execution capture capacity exceeded");
            long allocation = bytes + ToolPublicationContract.PRODUCER_BYTES
                    + ToolPublicationContract.ADMISSION_BYTES;
            jdbc.update("UPDATE qwen_tool_publication SET state = 'FENCED', expires_at = NULL,"
                    + " capture_held_bytes = capture_used_bytes, producer_held_bytes = producer_used_bytes,"
                    + " admission_held_bytes = CASE WHEN producer_phase IN ('FINISHED', 'REFERENCED')"
                    + " THEN admission_held_bytes ELSE admission_used_bytes END"
                    + " WHERE tenant_key = ? AND state = 'OPEN' AND expires_at <= ?", tenantKey, writer.now());
            var totals = jdbc.queryForMap("SELECT COALESCE(SUM(capture_held_bytes + producer_held_bytes"
                    + " + admission_held_bytes), 0) AS reserved,"
                    + " COALESCE(SUM(CASE WHEN state = 'OPEN' AND producer_phase IN ('OPEN', 'FINISHING')"
                    + " THEN 1 ELSE 0 END), 0) AS captures"
                    + " FROM qwen_tool_publication WHERE tenant_key = ? AND state <> 'NOT_STARTED'", tenantKey);
            long reserved = ((Number) totals.get("reserved")).longValue();
            long count = ((Number) totals.get("captures")).longValue();
            Long sessionReserved = jdbc.queryForObject("SELECT COALESCE(SUM(capture_held_bytes + producer_held_bytes"
                    + " + admission_held_bytes), 0) FROM qwen_tool_publication"
                    + " WHERE scope_key = ? AND state <> 'NOT_STARTED'", Long.class, scope);
            require(reserved <= capacity.tenantBytes() - allocation
                    && sessionReserved <= capacity.sessionBytes() - allocation
                    && count < capacity.activeCaptures(), "Publication capacity exhausted");
            jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id,"
                            + " session_id, publication_id, execution_key, capture_id, binding_json, binding_digest,"
                            + " token_hash, state, expires_at, capture_bytes, producer_bytes, admission_bytes,"
                            + " capture_held_bytes, producer_held_bytes, admission_held_bytes, write_evidence)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, TRUE)",
                    scope, tenantKey, tenant, workspace, session, id, hash(text(candidate, "executionCallId")),
                    text(candidate, "captureId"), candidate.toString(), digest, tokenHash, expires, bytes,
                    ToolPublicationContract.PRODUCER_BYTES, ToolPublicationContract.ADMISSION_BYTES,
                    bytes, ToolPublicationContract.PRODUCER_BYTES, ToolPublicationContract.ADMISSION_BYTES);
            return grant(id, new Row(tenant, workspace, session, candidate.toString(), digest, tokenHash,
                    "OPEN", expires, bytes));
        }
        require(row != null, "Publication does not exist");
        JsonNode binding = ToolPublicationContract.parseBytes("binding", row.binding().getBytes(StandardCharsets.UTF_8));
        require(ToolPublicationContract.bindingDigest(binding).equals(row.digest()), "Stored binding is corrupt");
        if ("renew".equals(operation)) {
            require("OPEN".equals(row.state()) && equalHash(tokenHash, row.tokenHash()), "Publication is fenced");
            require(text(owner, "writerId").equals(text(binding, "writerId"))
                    && owner.get("writerGeneration").longValue() == binding.get("writerGeneration").longValue(),
                    "Original writer is fenced");
            long expires = requireEvidence(binding, writerToken, writer, false);
            jdbc.update("UPDATE qwen_tool_publication SET expires_at = ? WHERE scope_key = ? AND publication_id = ?",
                    expires, scope, id);
            return grant(id, row.withState("OPEN", expires));
        }
        String state = "FENCED";
        if ("close_not_started".equals(operation)) {
            ToolExecutionRecord execution = requireExecution(binding, false);
            require(execution.isSettled() && ("not_started".equals(execution.getExecutionStatus())
                    || "cancelled".equals(execution.getExecutionStatus()) && execution.getDispatchGeneration() == 0),
                    "Execution has no authoritative not-started proof");
            Long published = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_object"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, id);
            Long attempted = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_operation"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, id);
            require(published == 0 && attempted == 0 && "OPEN".equals(jdbc.queryForObject(
                    "SELECT producer_phase FROM qwen_tool_publication WHERE scope_key = ?"
                            + " AND publication_id = ?", String.class, scope, id)),
                    "Publication has accepted producer work");
            state = "NOT_STARTED";
        } else if ("NOT_STARTED".equals(row.state())) {
            state = row.state();
        }
        jdbc.update("UPDATE qwen_tool_publication SET state = ?, expires_at = NULL,"
                + " capture_held_bytes = CASE WHEN ? = 'NOT_STARTED' THEN 0 ELSE capture_used_bytes END,"
                + " producer_held_bytes = CASE WHEN ? = 'NOT_STARTED' THEN 0 ELSE producer_used_bytes END,"
                + " admission_held_bytes = CASE WHEN ? = 'NOT_STARTED' THEN 0"
                + " WHEN producer_phase IN ('FINISHED', 'REFERENCED') THEN admission_held_bytes"
                + " ELSE admission_used_bytes END"
                + " WHERE scope_key = ? AND publication_id = ?", state, state, state, state, scope, id);
        return grant(id, row.withState(state, null));
    }

    private long requireEvidence(JsonNode b, String writerToken, ManagedSessionStore.PublicationWriter writer,
            boolean preparing) {
        JsonNode key = b.get("sessionKey");
        require("READY".equals(writer.recoveryStatus()), "Session recovery is blocked");
        require(writer.activationEpoch() == b.get("activationEpoch").longValue()
                && writer.checkpointId() != null, "Checkpoint or activation changed");
        boolean headActivation = journalHeadAuthorization
                && (writer.activationPhase() != null
                        || writer.activationId() != null)
                && writer.activationHeadRevision() != null
                && writer.activationHeadRevision() == writer.journalRevision();
        long intentSequence = b.get("intentSequence").longValue();
        JsonNode activation = null;
        JsonNode intent;
        long activationExpiresAt;
        if (headActivation) {
            // The locked head carries the last committed activation.changed.
            // It answers before the intent read so a fenced activation pays
            // no journal statement at all.
            require("active".equals(writer.activationPhase())
                    && text(b, "activationId").equals(writer.activationId())
                    && writer.activationEventEpoch() != null
                    && b.get("activationEpoch").longValue() == writer.activationEventEpoch()
                    && writer.activationExpiresAt() != null
                    && writer.activationExpiresAt() > writer.now(), "Activation is not active");
            activationExpiresAt = writer.activationExpiresAt();
            // The binding names the intent's sequence, so its revision is
            // read directly instead of walking the journal down to it.
            intent = readIntent(b, key, writerToken, intentSequence,
                    writer);
        } else {
            intent = null;
            for (long revision = writer.journalRevision(); revision > 0
                    && (activation == null || intent == null); revision--) {
                var page = sessions.transactions(text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"),
                        writerToken, revision - 1, 1);
                require(page.transactions().size() == 1 && page.transactions().get(0).journalRevision() == revision,
                        "Committed journal evidence is missing");
                byte[] bytes = Base64.getDecoder().decode(page.transactions().get(0).recordBytesBase64());
                String records = new String(bytes, StandardCharsets.UTF_8);
                String[] lines = records.split("\n");
                for (int i = lines.length - 1; i >= 0; i--) {
                    JsonNode record = ToolPublicationContract.readJson(lines[i].getBytes(StandardCharsets.UTF_8));
                    if (!"managed_session_event_v1".equals(text(record, "subtype"))) {
                        continue;
                    }
                    JsonNode event = record.path("managedSession");
                    require(event.path("sessionKey").equals(key) && event.path("v").asInt() == 1,
                            "Journal event scope conflicts");
                    if (activation == null && "activation.changed".equals(text(event, "kind"))) {
                        activation = event.path("payload");
                    }
                    if (event.path("sequence").asLong() == intentSequence) {
                        require("tool.intent".equals(text(event, "kind")), "Intent sequence conflicts");
                        require(page.transactions().get(0).writerGeneration() == b.get("writerGeneration").longValue(),
                                "Original intent writer conflicts");
                        require(intent == null, "Intent sequence conflicts");
                        intent = event;
                    }
                }
            }
            require(activation != null && intent != null, "Committed publication evidence is missing");
            Long expiresAt = ManagedExtensionRecords.millisLenient(
                    activation.path("expiresAt"));
            require("active".equals(text(activation, "phase"))
                    && text(b, "activationId").equals(text(activation, "activationId"))
                    && b.get("activationEpoch").longValue() == activation.path("epoch").asLong()
                    && expiresAt != null && expiresAt > writer.now(), "Activation is not active");
            activationExpiresAt = expiresAt;
            // Backfill the locked head so later checks read it instead of
            // rescanning the journal, like requireLegacyActivation does.
            backfillActivation(text(key, "tenantId"), text(key, "sessionId"),
                    text(activation, "activationId"), text(activation, "phase"),
                    activation.path("epoch").asLong(), expiresAt,
                    writer.journalRevision(),
                    new HeadActivation(writer.activationId(),
                            writer.activationPhase(),
                            writer.activationEventEpoch(),
                            writer.activationExpiresAt(),
                            writer.activationHeadRevision()));
        }
        JsonNode payload = intent.path("payload");
        require(text(b, "executionCallId").equals(text(payload, "executionCallId"))
                && b.get("argsRef").equals(payload.path("argsRef"))
                && "runtime".equals(text(payload, "outcomeSource"))
                && "activation".equals(text(intent.path("subject"), "type"))
                && text(b, "activationId").equals(text(intent.path("subject"), "activationId"))
                && b.get("activationEpoch").longValue() == intent.path("subject").path("epoch").asLong(),
                "Original intent conflicts");
        requireCheckpoint(b, readResource(b, b.get("checkpointRef"), writerToken), writer);
        if (!writer.checkpointId().equals(text(b.get("checkpointRef"), "resourceId"))) {
            var current = sessions.readResource(text(key, "tenantId"), text(key, "workspaceId"),
                    text(key, "sessionId"), writer.checkpointId(), writerToken);
            require("managed-checkpoint".equals(current.kind()) && current.schemaVersion() == 1
                    && current.byteLength() <= ToolPublicationContract.MAX_BODY_BYTES, "Current checkpoint is invalid");
            requireCheckpoint(b, ToolPublicationContract.readJson(current.bytes()), writer);
        }
        JsonNode args = readResource(b, b.get("argsRef"), writerToken);
        require(text(key, "sessionId").equals(text(args, "harnessSessionId"))
                && text(b.get("reference"), "sessionId").equals(text(args, "runtimeSessionId")),
                "Argument resource scope conflicts");
        ToolPublicationContract.requirePayload(b, text(args, "payloadJson"));
        ToolExecutionRecord execution = requireExecution(b, true);
        if (preparing) {
            require(execution.getState() == ToolExecutionRecord.State.PREPARED && execution.getDispatchGeneration() == 0,
                    "Publication must be reserved before dispatch");
        }
        return Math.min(writer.leaseUntil(), activationExpiresAt);
    }

    /**
     * Reads the tool.intent event at the revision its sequence belongs to,
     * keeping the scan's fail-closed checks: the located revision's page
     * must be exactly that revision, and the revisions above it up to the
     * locked head must be gap-free.
     */
    private JsonNode readIntent(JsonNode b, JsonNode key, String writerToken,
            long intentSequence,
            ManagedSessionStore.PublicationWriter writer) {
        long headRevision = writer.journalRevision();
        String tenant = text(key, "tenantId");
        String session = text(key, "sessionId");
        List<Long> revisions = jdbc.queryForList(
                "SELECT journal_revision FROM qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND first_sequence <= ? AND last_sequence >= ?"
                        + " AND journal_revision <= ?",
                Long.class, tenant, session, intentSequence, intentSequence,
                headRevision);
        // An ambiguous range or a hole inside the committed span means
        // server-side journal damage: the session store's corruption fault
        // (500). A sequence beyond the committed span means the binding
        // names evidence that was never committed — a client request fault.
        if (revisions.size() > 1) {
            throw ManagedSessionStore.journalCorrupt();
        }
        if (revisions.isEmpty()) {
            if (intentSequence > writer.committedSequence()) {
                // The binding names evidence that was never committed —
                // the requester's fault, not the journal's.
                throw new IllegalArgumentException(
                        "Committed publication evidence is missing");
            }
            throw ManagedSessionStore.journalCorrupt();
        }
        long revision = revisions.get(0);
        // The legacy walk proved the chain contiguous down from the head
        // and sane (the byte-length tripwire); the same proof here is one
        // indexed count with the same bounds.
        Long above = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_session_journal_tx WHERE tenant_id = ?"
                        + " AND session_id = ? AND journal_revision > ?"
                        + " AND journal_revision <= ?"
                        + " AND byte_length >= 1 AND byte_length <= ?",
                Long.class, tenant, session, revision, headRevision,
                ManagedSessionStoreModels.MAX_TRANSACTION_BYTES);
        if (above == null || above != headRevision - revision) {
            throw ManagedSessionStore.journalCorrupt();
        }
        var page = sessions.transactions(tenant, text(key, "workspaceId"),
                session, writerToken, revision - 1, 1);
        if (page.transactions().size() != 1
                || page.transactions().get(0).journalRevision() != revision) {
            throw ManagedSessionStore.journalCorrupt();
        }
        byte[] bytes = Base64.getDecoder().decode(
                page.transactions().get(0).recordBytesBase64());
        JsonNode intent = null;
        int offset = 0;
        while (offset < bytes.length) {
            int end = offset;
            while (end < bytes.length && bytes[end] != '\n') {
                end++;
            }
            JsonNode record = ToolPublicationContract.readJson(bytes, offset,
                    end - offset);
            offset = end + 1;
            if (!"managed_session_event_v1".equals(text(record, "subtype"))) {
                continue;
            }
            JsonNode event = record.path("managedSession");
            require(event.path("sessionKey").equals(key)
                    && event.path("v").asInt() == 1,
                    "Journal event scope conflicts");
            if (event.path("sequence").asLong() == intentSequence) {
                require("tool.intent".equals(text(event, "kind")),
                        "Intent sequence conflicts");
                require(page.transactions().get(0).writerGeneration()
                        == b.get("writerGeneration").longValue(),
                        "Original intent writer conflicts");
                require(intent == null, "Intent sequence conflicts");
                intent = event;
            }
        }
        require(intent != null, "Committed publication evidence is missing");
        return intent;
    }

    private static void requireCheckpoint(JsonNode b, JsonNode checkpoint, ManagedSessionStore.PublicationWriter writer) {
        JsonNode key = b.get("sessionKey");
        long intentSequence = b.get("intentSequence").longValue();
        JsonNode identity = checkpoint.path("identity");
        require(identity.path("sessionKey").equals(key)
                && text(b, "turnId").equals(text(identity, "turnId"))
                && text(b.get("reference"), "promptId").equals(text(identity, "promptId"))
                && "managed".equals(text(identity, "engine")) && identity.path("schemaVersion").asInt() == 1
                && text(b, "activationId").equals(text(identity, "activationId"))
                && identity.path("coveredSequence").asLong() >= intentSequence
                && identity.path("coveredSequence").asLong() <= writer.committedSequence()
                && "await_runtime".equals(text(checkpoint.path("continuation"), "phase")),
                "Checkpoint does not authorize dispatch");
        JsonNode item = null;
        for (JsonNode value : checkpoint.path("tools").path("items")) {
            if (text(b, "executionCallId").equals(text(value, "executionCallId"))) {
                require(item == null, "Duplicate checkpoint execution");
                item = value;
            }
        }
        require(item != null && "run_shell_command".equals(text(item, "toolName"))
                && "in_progress".equals(text(item, "state"))
                && "runtime".equals(text(item, "outcomeSource"))
                && text(b, "modelCallId").equals(text(item, "functionCallId"))
                && text(b.path("reference"), "argsDigest")
                        .equals("sha256:" + text(item, "inputDigest")),
                "Checkpoint execution identity conflicts");
    }

    private JsonNode readResource(JsonNode b, JsonNode ref, String writerToken) {
        JsonNode key = b.get("sessionKey");
        var resource = sessions.readResource(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), text(ref, "resourceId"), writerToken);
        require(resource.kind().equals(text(ref, "kind")) && resource.schemaVersion() == ref.get("schemaVersion").intValue()
                && resource.byteLength() == ref.get("byteLength").longValue()
                && resource.digest().equals(text(ref, "digest")), "Publication resource reference conflicts");
        return ToolPublicationContract.readJson(resource.bytes());
    }

    private ToolExecutionRecord requireExecution(JsonNode b, boolean live) {
        ToolExecutionRecord execution = executions.findByExecutionCallId(text(b, "executionCallId"));
        RuntimeBindingRecord runtime = bindings.findById(text(b, "runtimeBindingId"));
        JsonNode key = b.get("sessionKey");
        JsonNode ref = b.get("reference");
        require(execution != null && runtime != null, "Original Broker records are missing");
        var scope = runtime.getRequest().getScope();
        require(scope.getTenantId().equals(text(key, "tenantId"))
                && scope.getWorkspaceId().equals(text(key, "workspaceId"))
                && runtime.getGeneration() == Long.parseLong(text(b, "bindingGeneration"))
                && execution.getBindingId().equals(runtime.getBindingId())
                && execution.getRuntimeGeneration() == runtime.getGeneration()
                && execution.getHarnessSessionId().equals(text(key, "sessionId"))
                && execution.getRuntimeSessionId().equals(text(ref, "sessionId"))
                && execution.getTurnId().equals(text(ref, "promptId"))
                && execution.getToolCallId().equals(text(ref, "callId"))
                && "deferred_v3".equals(execution.getReference().get("dispatchMode"))
                && text(b, "publicationId").equals(execution.getReference().get("publicationId"))
                && text(ref, "argsDigest").equals(execution.getReference().get("argsDigest"))
                && execution.getRequestDigest().equals(text(b, "requestDigest")), "Broker execution identity conflicts");
        if (live) {
            require(runtime.getState() == RuntimeBindingRecord.State.READY && !runtime.isDrainRequested()
                    && !execution.isSettled(),
                    "Runtime cannot authorize publication");
        }
        return execution;
    }

    private static JsonNode grant(String id, Row row) {
        ObjectNode grant = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL)
                .put("publicationId", id).put("bindingDigest", row.digest()).put("state", row.state())
                .put("captureBytes", row.captureBytes()).put("producerBytes", ToolPublicationContract.PRODUCER_BYTES)
                .put("admissionBytes", ToolPublicationContract.ADMISSION_BYTES);
        if (row.expiresAt() == null) {
            grant.putNull("expiresAt");
        } else {
            grant.put("expiresAt", row.expiresAt());
        }
        return ToolPublicationContract.parse("grant", grant);
    }

    private static String hash(String text) {
        return ToolPublicationContract.sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    private static boolean equalHash(String left, String right) {
        return MessageDigest.isEqual(left.getBytes(StandardCharsets.US_ASCII), right.getBytes(StandardCharsets.US_ASCII));
    }

    private record Row(String tenant, String workspace, String session, String binding,
            String digest, String tokenHash, String state, Long expiresAt, long captureBytes) {
        Row withState(String next, Long expiry) {
            return new Row(tenant, workspace, session, binding, digest, tokenHash, next, expiry, captureBytes);
        }
    }
}
