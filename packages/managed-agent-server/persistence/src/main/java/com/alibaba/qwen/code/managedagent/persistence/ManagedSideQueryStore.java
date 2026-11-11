package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.*;
import com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.*;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedSideQueries;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

@Repository
@Transactional(transactionManager = "managedAgentTransactionManager")
public class ManagedSideQueryStore implements ManagedSideQueries {
    private static final Set<String> INPUT_KINDS = Set.of("managed-side-query-input", "managed-side-query-chunk");
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final AgentStoreRows sessions;
    private final AgentSessionQueries sessionQueries;
    private final JournalStoreRows journal;
    private final ManagedWorkspaceRegistry workspaces;
    private final ManagedSessionModelConfigs models;
    private final ToolPublicationRetentionStore retention;

    public ManagedSideQueryStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json, HarnessRules rules,
            ManagedWorkspaceRegistry workspaces, ManagedSessionModelConfigs models,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.json = json;
        this.sessions = new AgentStoreRows(rules, jdbc, json);
        this.sessionQueries = new AgentSessionQueries(sessions, null, jdbc, List.of());
        this.journal = new JournalStoreRows(StorageReadPolicy.inProcess(), jdbc);
        this.workspaces = workspaces;
        this.models = models;
        this.retention = new ToolPublicationRetentionStore(jdbc, manager);
    }

    @Override
    public Context context(String tenant, String actor, String session) {
        SessionRecord visible = authorize(tenant, actor, session, false);
        Prefix prefix;
        try {
            prefix = prefix(tenant, session);
        } catch (ManagedAgentException unavailable) {
            if (!"side_query_history_unavailable".equals(unavailable.getCode())) {
                throw unavailable;
            }
            return new Context(ManagedSchemaKeys.key("side-query-actor", tenant, actor), null, -1,
                    SideQueryConversation.state(jdbc, tenant, session).path("mainInputBoundary").asLong(-1),
                    false, false, unavailable.getCode(), null, null);
        }
        Query recap = latestRecap(tenant, actor, session);
        boolean available = "ACTIVE".equals(visible.status()) && models.digest(tenant, session) != null
                && canExecute(visible, actor);
        return new Context(ManagedSchemaKeys.key("side-query-actor", tenant, actor), prefix.contentVersion(),
                prefix.completedUserTurnCount(), prefix.mainInputBoundary(),
                prefix.completedUserTurnCount() >= (recap == null ? 3 : recap.source().completedUserTurnCount() + 2),
                available, available ? null : "side_query_unavailable", recap == null ? null : recap.source().contentVersion(),
                recap == null ? null : recap.source().completedUserTurnCount());
    }

    @Override
    public Admission admit(String tenant, String actor, String session, Create request, boolean generationAvailable) {
        validate(request);
        authorize(tenant, actor, session, false);
        String scope = actorScope(tenant, actor, session);
        String digest = ManagedSchemaKeys.key(encode(request));
        var previous = ManagedReceipts.find(jdbc, ReceiptNamespace.SIDE_QUERY, tenant,
                ReceiptScope.ACTOR, scope, request.idempotencyKey(), false);
        if (previous != null) {
            if (!digest.equals(previous.requestDigest())) {
                throw error(409, "idempotency_conflict");
            }
            Row replay = read(tenant, session, previous.resultJson(), false);
            requireActor(replay, actor);
            return new Admission(replay.query(), true, false);
        }
        authorize(tenant, actor, session, true);
        String modelDigest = models.digest(tenant, session);
        if (modelDigest == null) {
            throw error(409, "explicit_model_config_required");
        }
        Prefix source = prefix(tenant, session);
        String automaticKey = "automatic:" + source.contentVersion();
        boolean automatic = "automatic".equals(request.trigger());
        if (automatic) {
            Context context = context(tenant, actor, session);
            if (!Objects.equals(source.contentVersion(), request.expectedContentVersion())
                    || !Objects.equals(source.mainInputBoundary(), request.expectedMainInputBoundary())
                    || !context.automaticEligible() || mainBusy(tenant, session)) {
                throw error(409, "side_query_context_changed");
            }
            var attempt = ManagedReceipts.find(jdbc, ReceiptNamespace.SIDE_QUERY, tenant,
                    ReceiptScope.ACTOR, scope, automaticKey, false);
            if (attempt != null) {
                Query query = read(tenant, session, attempt.resultJson(), false).query();
                receipt(tenant, actor, session, scope, request.idempotencyKey(), digest, query.queryId());
                return new Admission(query, true, false);
            }
        }
        Query reuse = "recap".equals(request.kind()) ? reusableRecap(tenant, actor, session, source, modelDigest) : null;
        if (reuse != null) {
            receipt(tenant, actor, session, scope, request.idempotencyKey(), digest, reuse.queryId());
            if (automatic) {
                receipt(tenant, actor, session, scope, automaticKey, source.contentVersion(), reuse.queryId());
            }
            return new Admission(reuse, false, false);
        }
        if (!generationAvailable) {
            throw error(503, "side_query_unavailable");
        }
        if (!jdbc.queryForList("SELECT query_key FROM ma_side_query WHERE actor_scope_key=? AND kind=?"
                        + " AND state IN ('preparing','running')", scope, request.kind()).isEmpty()) {
            throw error(409, "side_query_active");
        }
        long now = now();
        String id = UUID.randomUUID().toString();
        String lease = retention.read(tenant, session).id;
        List<Pair> pairs = "btw".equals(request.kind()) ? privateHistory(tenant, actor, session) : List.of();
        jdbc.update("INSERT INTO ma_side_query (query_key,query_id,tenant_id,session_id,session_scope_key,actor_id,"
                        + "actor_scope_key,kind,trigger_kind,question,state,source_json,private_history_json,model_config_digest,"
                        + "processing_version,read_lease_id,read_deadline_at,deadline_at,gmt_create,gmt_modified)"
                        + " VALUES (?,?,?,?,?,?,?,?,?,?,'preparing',?,?,?,?,?,?,?,?,?)",
                queryKey(tenant, id), id, tenant, session, SideQueryConversation.scope(tenant, session), actor,
                scope, request.kind(), request.trigger() == null ? "manual" : request.trigger(), request.question(),
                encode(source), encode(pairs), modelDigest, ManagedSideQueryModels.PROCESSING_VERSION, lease,
                now + ToolPublicationRetentionStore.READ_BUDGET_MILLIS, now + ManagedSideQueryModels.DEADLINE_MILLIS, now, now);
        receipt(tenant, actor, session, scope, request.idempotencyKey(), digest, id);
        if (automatic) {
            receipt(tenant, actor, session, scope, automaticKey, source.contentVersion(), id);
        }
        return new Admission(read(tenant, session, id, false).query(), false, true);
    }

    @Override
    public Query get(String tenant, String actor, String session, String id) {
        authorize(tenant, actor, session, false);
        Row row = read(tenant, session, id, false);
        requireActor(row, actor);
        return row.query();
    }

    @Override
    public Page list(String tenant, String actor, String session, String cursor, int limit) {
        authorize(tenant, actor, session, false);
        if (limit < 1 || limit > 100) {
            throw error(400, "invalid_side_query_request");
        }
        long before = Long.MAX_VALUE;
        String beforeId = "~";
        if (cursor != null) {
            Query boundary = get(tenant, actor, session, cursor);
            before = boundary.createdAt();
            beforeId = boundary.queryId();
        }
        var ids = jdbc.queryForList("SELECT query_id FROM ma_side_query WHERE actor_scope_key=?"
                        + " AND (gmt_create<? OR (gmt_create=? AND query_id<?)) ORDER BY gmt_create DESC,query_id DESC LIMIT ?",
                String.class, actorScope(tenant, actor, session), before, before, beforeId, limit + 1);
        boolean more = ids.size() > limit;
        if (more) {
            ids = ids.subList(0, limit);
        }
        List<Query> items = ids.stream().map(id -> {
            Row row = read(tenant, session, id, false);
            requireActor(row, actor);
            return row.query();
        }).toList();
        return new Page(items, more ? items.getLast().queryId() : null);
    }

    @Override
    public Query cancel(String tenant, String actor, String session, String id) {
        authorize(tenant, actor, session, false);
        Row row = read(tenant, session, id, true);
        requireActor(row, actor);
        return terminal(row, "cancelled", "cancelled", row.query().text(), null, null);
    }

    @Override
    public Claim claim(String tenant, String session, String id, String instance, String boot) {
        lockRoot(tenant, session);
        Row row = read(tenant, session, id, true);
        authorize(tenant, row.actor(), session, true);
        if (!"preparing".equals(row.query().status()) || row.claimHash() != null
                || row.readDeadline() <= now()) {
            throw error(409, "side_query_claim_conflict");
        }
        String token = UUID.randomUUID() + ":" + UUID.randomUUID();
        long generation = row.generation() + 1;
        jdbc.update("UPDATE ma_side_query SET claim_instance_id=?,claim_boot_id=?,claim_generation=?,claim_token_hash=?"
                + " WHERE query_key=?", instance, boot, generation, ManagedSchemaKeys.key(token), queryKey(tenant, id));
        return new Claim(instance, boot, generation, token);
    }

    private JdbcJournalPacks packs;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSessionResources(
            com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings settings,
            org.springframework.beans.factory.ObjectProvider<
                    com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore> objects) {
        if (settings != null) {
            this.packs = new JdbcJournalPacks(jdbc, objects.getIfAvailable(), settings);
        }
    }

    @Override
    public FrozenInput frozen(String tenant, String session, String id, Claim claim) {
        Row row = checked(tenant, session, id, claim, true);
        String workspace = jdbc.queryForObject("SELECT workspace_id FROM ma_session_head WHERE tenant_id=? AND session_id=?"
                + " AND head_kind='MANAGED_SESSION'", String.class, tenant, session);
        return new FrozenInput(id, tenant, session, workspace,
                row.query().kind(), row.query().question(), row.query().source(), decode(row.history(), new TypeReference<List<Pair>>() {}),
                ManagedSideQueryModels.PROCESSING_VERSION, row.modelDigest(), row.query().deadlineAt(), row.inputId(), row.inputDigest());
    }

    @Override
    public TransactionPage transactions(String tenant, String session, String id, Claim claim, long after, int limit) {
        Row row = checked(tenant, session, id, claim, true);
        if (after < 0 || after > row.query().source().journalRevision() || limit < 1 || limit > 100) {
            throw error(400, "invalid_side_query_request");
        }
        var candidates = jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns()
                        + " FROM ma_session_journal_tx WHERE tenant_id=? AND session_id=? AND journal_revision>?"
                        + " AND journal_revision<=? ORDER BY journal_revision LIMIT ?", journal.transactionMapper,
                tenant, session, after, row.query().source().journalRevision(), limit);
        var transactions = new ArrayList<StoredTransaction>();
        long bytes = 0;
        long next = after;
        for (var transaction : candidates) {
            if (transaction.journalRevision() != next + 1) {
                throw error(409, "side_query_history_unavailable");
            }
            if (bytes + transaction.byteLength() > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES && !transactions.isEmpty()) {
                break;
            }
            if (transaction.recordBytes() == null) {
                byte[] resolved = packs == null ? null : packs.resolveBytes(tenant, session,
                        transaction.journalRevision(), transaction.recordDigest(),
                        transaction.byteLength());
                if (resolved == null) {
                    throw error(409, "side_query_history_unavailable");
                }
                transaction = journal.withRecordBytes(transaction, resolved);
            }
            transactions.add(journal.storedTransaction(transaction));
            bytes += transaction.byteLength();
            next++;
        }
        if (next < row.query().source().journalRevision() && transactions.isEmpty()) {
            throw error(409, "side_query_history_unavailable");
        }
        return new TransactionPage(transactions, next, next < row.query().source().journalRevision());
    }

    @Override
    public StoredResource resource(String tenant, String session, String id, Claim claim, String resourceId) {
        Row row = checked(tenant, session, id, claim, true);
        String scope = SideQueryConversation.scope(tenant, session);
        String key = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, resourceId);
        boolean own = !jdbc.queryForList("SELECT resource_key FROM ma_resource_ref WHERE session_scope_key=?"
                + " AND resource_key=? AND owner_kind='SIDE_QUERY' AND owner_key=? AND owner_revision=?", scope,
                key, queryKey(tenant, id), claim.generation()).isEmpty();
        boolean source = !jdbc.queryForList("SELECT resource_key FROM ma_resource_ref WHERE session_scope_key=?"
                + " AND resource_key=? AND owner_kind='JOURNAL' AND owner_revision<=?", scope, key,
                row.query().source().journalRevision()).isEmpty();
        if (!own && !source) {
            throw error(404, "side_query_resource_not_found");
        }
        return loadResource(tenant, session, resourceId);
    }

    @Override
    public SessionModelConfig modelConfig(String tenant, String session, String id, Claim claim) {
        Row row = checked(tenant, session, id, claim, true);
        return models.read(tenant, session, row.modelDigest());
    }

    @Override
    public void stage(String tenant, String session, String id, Claim claim, CommitResource resource) {
        checked(tenant, session, id, claim, true);
        if (resource == null || !INPUT_KINDS.contains(resource.kind()) || resource.schemaVersion() != 1
                || resource.resourceId() == null || resource.resourceId().isBlank() || resource.resourceId().length() > 512
                || resource.byteLength() < 0 || resource.byteLength() > ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES) {
            throw error(400, "invalid_side_query_resource");
        }
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(resource.bytesBase64());
        } catch (RuntimeException invalid) {
            throw error(400, "invalid_side_query_resource");
        }
        if (bytes.length != resource.byteLength() || !JournalStoreRows.sha256(bytes).equals(resource.digest())) {
            throw error(400, "invalid_side_query_resource");
        }
        String scope = SideQueryConversation.scope(tenant, session);
        String key = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, resource.resourceId());
        var existing = jdbc.queryForList("SELECT resource_key FROM ma_resource WHERE resource_key=? FOR UPDATE", key);
        if (existing.isEmpty()) {
            var totals = jdbc.queryForMap("SELECT COUNT(*) AS resource_count,COALESCE(SUM(r.byte_length),0) AS total_bytes"
                            + " FROM ma_resource_ref f JOIN ma_resource r ON r.resource_key=f.resource_key"
                            + " WHERE f.session_scope_key=? AND f.owner_kind='SIDE_QUERY' AND f.owner_key=? AND f.owner_revision=?",
                    scope, queryKey(tenant, id), claim.generation());
            if (((Number) totals.get("resource_count")).longValue() >= 1024
                    || ((Number) totals.get("total_bytes")).longValue() + bytes.length
                        > ManagedSessionStoreModels.MAX_MODEL_REQUEST_BYTES + ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES) {
                throw error(413, "side_query_input_too_large");
            }
            jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,session_id,resource_id,kind,"
                            + "schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create)"
                            + " VALUES (?,?,?,?,?,?,?,?,?,'MYSQL_INLINE',?,'REFERENCED',?)", key, scope, tenant,
                    session, resource.resourceId(), resource.kind(), resource.schemaVersion(), resource.byteLength(), resource.digest(), bytes, now());
        } else {
            if (jdbc.queryForList("SELECT resource_key FROM ma_resource_ref WHERE session_scope_key=?"
                            + " AND owner_kind='SIDE_QUERY' AND owner_key=? AND owner_revision=? AND resource_key=?",
                    scope, queryKey(tenant, id), claim.generation(), key).isEmpty()) {
                throw error(409, "side_query_resource_conflict");
            }
            StoredResource stored = loadResource(tenant, session, resource.resourceId());
            if (!stored.digest().equals(resource.digest()) || !stored.kind().equals(resource.kind())) {
                throw error(409, "side_query_resource_conflict");
            }
        }
        if (jdbc.queryForList("SELECT resource_key FROM ma_resource_ref WHERE session_scope_key=? AND owner_kind='SIDE_QUERY'"
                        + " AND owner_key=? AND owner_revision=? AND resource_key=?", scope, queryKey(tenant, id), claim.generation(), key).isEmpty()) {
            jdbc.update("INSERT INTO ma_resource_ref (session_scope_key,owner_kind,owner_key,owner_revision,resource_key,"
                            + "tenant_id,session_id,resource_id,gmt_create) VALUES (?,'SIDE_QUERY',?,?,?,?,?,?,?)",
                    scope, queryKey(tenant, id), claim.generation(), key, tenant, session, resource.resourceId(), now());
        }
    }

    @Override
    public Query publishInput(String tenant, String session, String id, Claim claim, InputPublication input) {
        Row row = checked(tenant, session, id, claim, true);
        if (row.ready() || input == null || input.resourceIds() == null || input.resourceIds().size() > 1024
                || !input.resourceIds().contains(input.resourceId())) {
            throw error(409, "side_query_input_conflict");
        }
        String scope = SideQueryConversation.scope(tenant, session);
        for (String resourceId : input.resourceIds()) {
            var owned = jdbc.queryForList("SELECT resource_key FROM ma_resource_ref WHERE session_scope_key=?"
                            + " AND owner_kind='SIDE_QUERY' AND owner_key=? AND owner_revision=? AND resource_id=?",
                    scope, queryKey(tenant, id), claim.generation(), resourceId);
            if (owned.size() != 1) {
                throw error(409, "side_query_input_conflict");
            }
        }
        StoredResource manifest = loadResource(tenant, session, input.resourceId());
        if (!"managed-side-query-input".equals(manifest.kind()) || !manifest.digest().equals(input.digest())) {
            throw error(409, "side_query_input_conflict");
        }
        verifyInputClosure(tenant, session, input, manifest);
        verifyPrefix(tenant, session, row.query().source());
        jdbc.update("UPDATE ma_side_query SET input_resource_id=?,input_digest=?,is_input_ready=1,"
                        + "result_revision=result_revision+1,gmt_modified=? WHERE query_key=?", input.resourceId(),
                input.digest(), now(), queryKey(tenant, id));
        releaseLease(row);
        return read(tenant, session, id, false).query();
    }

    @Override
    public boolean start(String tenant, String session, String id, Claim claim) {
        Row row = checked(tenant, session, id, claim, false);
        if (!row.ready() || !"preparing".equals(row.query().status())) {
            return false;
        }
        return jdbc.update("UPDATE ma_side_query SET state='running',result_revision=result_revision+1,gmt_modified=?"
                + " WHERE query_key=? AND state='preparing' AND is_input_ready=1", now(), queryKey(tenant, id)) == 1;
    }

    @Override
    public boolean active(String tenant, String session, String id, Claim claim) {
        lockRoot(tenant, session);
        Row row = read(tenant, session, id, true);
        requireClaim(row, claim);
        if (row.query().terminal()) {
            return false;
        }
        checked(tenant, session, id, claim, false);
        return true;
    }

    @Override
    public Query snapshot(String tenant, String session, String id, Claim claim, ResultUpdate result) {
        Row row = checked(tenant, session, id, claim, false);
        if (row.query().terminal()) {
            return row.query();
        }
        if (result == null || result.status() == null || !Set.of("running", "completed", "failed", "cancelled", "interrupted").contains(result.status())
                || result.text() != null && result.text().getBytes(StandardCharsets.UTF_8).length > 1024 * 1024
                || result.outcome() != null && result.outcome().length() > 64
                || result.errorCode() != null && result.errorCode().length() > 128) {
            throw error(400, "invalid_side_query_result");
        }
        if ("completed".equals(result.status()) && !("success".equals(result.outcome()) && result.text() != null && !result.text().isBlank())
                && !"insufficient_context".equals(result.outcome())) {
            throw error(400, "invalid_side_query_result");
        }
        if ("completed".equals(result.status()) && !"running".equals(row.query().status())
                && !("recap".equals(row.query().kind()) && "insufficient_context".equals(result.outcome()))) {
            throw error(409, "side_query_state_conflict");
        }
        if (!"running".equals(result.status())) {
            return terminal(row, result.status(), result.outcome(), result.text(), result.usage(), result.errorCode());
        }
        if (!"running".equals(row.query().status())) {
            throw error(409, "side_query_state_conflict");
        }
        long now = now();
        if (now - row.query().updatedAt() >= 1000) {
            jdbc.update("UPDATE ma_side_query SET answer_text=?,usage_json=?,result_revision=result_revision+1,gmt_modified=?"
                    + " WHERE query_key=?", result.text(), result.usage() == null ? null : encode(result.usage()), now, row.key());
        }
        return read(tenant, session, id, false).query();
    }

    @Override
    public Query interrupt(String tenant, String session, String id, String reason) {
        lockRoot(tenant, session);
        Row row = read(tenant, session, id, true);
        return terminal(row, "interrupted", "interrupted", row.query().text(), null, reason);
    }

    @Override
    public int reconcileExpired() {
        var expired = jdbc.query("SELECT tenant_id,session_id,query_id FROM ma_side_query WHERE state IN ('preparing','running')"
                        + " AND (deadline_at<=? OR (state='preparing' AND is_input_ready=0 AND read_deadline_at<=?)"
                        + " OR NOT EXISTS (SELECT 1 FROM ma_session s WHERE s.tenant_id=ma_side_query.tenant_id"
                        + " AND s.session_id=ma_side_query.session_id AND s.status='ACTIVE' AND s.retired_at IS NULL)) LIMIT 32",
                (row, index) -> List.of(row.getString(1), row.getString(2), row.getString(3)), now(), now());
        int changed = 0;
        for (var identity : expired) {
            interrupt(identity.get(0), identity.get(1), identity.get(2), "side_query_expired");
            changed++;
        }
        return changed;
    }

    private Row checked(String tenant, String session, String id, Claim claim, boolean preparationRead) {
        lockRoot(tenant, session);
        Row row = read(tenant, session, id, true);
        requireClaim(row, claim);
        if (row.query().terminal()) {
            throw error(409, "side_query_terminal");
        }
        authorize(tenant, row.actor(), session, true);
        if (row.query().deadlineAt() <= now()) {
            throw error(409, "side_query_expired");
        }
        if (preparationRead) {
            if (!"preparing".equals(row.query().status())) {
                throw error(409, "side_query_state_conflict");
            }
            if (!row.ready()) {
                var leases = jdbc.queryForList("SELECT l.lease_id FROM ma_read_lease l JOIN ma_session s"
                                + " ON s.tenant_key=l.tenant_key AND s.session_key=l.session_key WHERE l.lease_id=?"
                                + " AND s.tenant_id=? AND s.session_id=? AND s.retired_at IS NULL"
                                + " AND s.retirement_generation=l.retirement_generation AND l.expires_at>?",
                        row.lease(), tenant, session, now());
                if (row.readDeadline() <= now() || leases.size() != 1) {
                    throw error(409, "side_query_read_expired");
                }
            }
        }
        return row;
    }

    private Query terminal(Row row, String state, String outcome, String text, Map<String, Object> usage, String errorCode) {
        if (row.query().terminal()) {
            return row.query();
        }
        jdbc.update("UPDATE ma_side_query SET state=?,outcome=?,answer_text=?,usage_json=?,error_code=?,"
                        + "result_revision=result_revision+1,gmt_modified=? WHERE query_key=?", state, outcome, text,
                usage == null ? null : encode(usage), errorCode, now(), row.key());
        releaseInput(jdbc, row.tenant(), row.query().sessionId(), row.key(), row.lease());
        return read(row.tenant(), row.query().sessionId(), row.query().queryId(), false).query();
    }

    static void cancelSession(JdbcTemplate jdbc, String tenant, String session) {
        var active = jdbc.query("SELECT query_key,read_lease_id FROM ma_side_query WHERE tenant_id=? AND session_id=?"
                        + " AND state IN ('preparing','running') FOR UPDATE",
                (row, index) -> new String[] {row.getString(1), row.getString(2)}, tenant, session);
        for (String[] row : active) {
            jdbc.update("UPDATE ma_side_query SET state='cancelled',outcome='session_closed',result_revision=result_revision+1,"
                    + "gmt_modified=? WHERE query_key=?", ToolPublicationRetentionStore.now(jdbc), row[0]);
            releaseInput(jdbc, tenant, session, row[0], row[1]);
        }
    }

    private static void releaseInput(JdbcTemplate jdbc, String tenant, String session, String key, String lease) {
        String scope = SideQueryConversation.scope(tenant, session);
        ManagedProjectionResourceCollector.release(jdbc, scope, "SIDE_QUERY", key);
        jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key=? AND owner_kind='SIDE_QUERY' AND owner_key=?", scope, key);
        if (lease != null) {
            jdbc.update("DELETE FROM ma_read_lease WHERE lease_id=?", lease);
        }
        jdbc.update("UPDATE ma_side_query SET read_lease_id=NULL,input_resource_id=NULL,input_digest=NULL,is_input_ready=0,"
                + "private_history_json='[]' WHERE query_key=?", key);
    }

    private void releaseLease(Row row) {
        if (row.lease() != null) {
            jdbc.update("DELETE FROM ma_read_lease WHERE lease_id=?", row.lease());
            jdbc.update("UPDATE ma_side_query SET read_lease_id=NULL WHERE query_key=?", row.key());
        }
    }

    private SessionRecord authorize(String tenant, String actor, String session, boolean execute) {
        SessionRecord visible = sessions.requireLegacySessionForUpdate(tenant, session);
        if ("DELETED".equals(visible.status()) || visible.deletedAt() != null) {
            throw error(404, "session_not_found");
        }
        com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.requireSessionVisibility(visible, actor, workspaces);
        if (visible.workspace() != null ? !workspaces.canRead(tenant, actor, visible.workspace().getWorkspaceId())
                : !workspaces.isSessionOwner(tenant, actor, session)) {
            throw error(404, "session_not_found");
        }
        if (execute && (!"ACTIVE".equals(visible.status()) || !canExecute(visible, actor) || lifecyclePending(tenant, session))) {
            throw error(403, "side_query_execution_forbidden");
        }
        return visible;
    }

    private boolean canExecute(SessionRecord session, String actor) {
        return session.workspace() == null ? workspaces.isSessionOwner(session.tenantId(), actor, session.sessionId())
                : workspaces.accessOf(session.tenantId(), actor, session.workspace().getWorkspaceId()).canCreate()
                    && sessionQueries.hasExecutionRegistryFacts(session.tenantId(), session.sessionId())
                    && ("qwen-code".equals(session.agentId()) || session.agentDefinitionDigest() != null)
                    && com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONTEXT_CONFIG_REF
                            .equals(session.workspace().getContextConfigRef());
    }

    private boolean lifecyclePending(String tenant, String session) {
        return !jdbc.queryForList("SELECT receipt_key FROM ma_request_receipt WHERE tenant_id=? AND session_id=?"
                        + " AND namespace='SESSION_COMMAND' AND state='PENDING'"
                        + " AND operation IN ('CLOSE_SESSION','ARCHIVE_SESSION','DELETE_SESSION') LIMIT 1", tenant, session).isEmpty();
    }

    private void lockRoot(String tenant, String session) {
        sessions.requireLegacySessionForUpdate(tenant, session);
    }

    private Prefix prefix(String tenant, String session) {
        var heads = jdbc.queryForList("SELECT journal_revision,committed_sequence,last_commit_digest,storage_version FROM ma_session_head"
                + " WHERE tenant_id=? AND session_id=? AND head_kind='MANAGED_SESSION' FOR UPDATE", tenant, session);
        if (heads.size() != 1) {
            throw error(409, "side_query_history_unavailable");
        }
        var head = heads.getFirst();
        int storageVersion = ((Number) head.get("storage_version")).intValue();
        if (storageVersion < 1 || storageVersion
                > com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedStorageVersions.SUPPORTED) {
            throw error(409, "side_query_history_unavailable");
        }
        return SideQueryConversation.capture(jdbc, tenant, session, ((Number) head.get("journal_revision")).longValue(),
                ((Number) head.get("committed_sequence")).longValue(), (String) head.get("last_commit_digest"), packs);
    }

    private void verifyPrefix(String tenant, String session, Prefix prefix) {
        if (prefix.journalRevision() == 0) {
            return;
        }
        var committed = jdbc.queryForList("SELECT last_sequence,commit_digest FROM ma_session_journal_tx"
                + " WHERE tenant_id=? AND session_id=? AND journal_revision=?", tenant, session, prefix.journalRevision());
        if (committed.size() != 1 || ((Number) committed.getFirst().get("last_sequence")).longValue() != prefix.committedSequence()
                || !Objects.equals(committed.getFirst().get("commit_digest"), prefix.lastCommitDigest())) {
            throw error(409, "side_query_history_unavailable");
        }
    }

    private boolean mainBusy(String tenant, String session) {
        return !jdbc.queryForList("SELECT turn_id FROM ma_turn WHERE tenant_id=? AND session_id=?"
                        + " AND status IN ('ACCEPTED','RUNNING','CANCELLING','RECOVERY_BLOCKED') LIMIT 1", tenant, session).isEmpty()
                || !jdbc.queryForList("SELECT message_id FROM ma_user_message WHERE tenant_id=? AND session_id=?"
                        + " AND state IN ('queued','claimed','recovery_blocked') LIMIT 1", tenant, session).isEmpty();
    }

    private Query latestRecap(String tenant, String actor, String session) {
        var ids = jdbc.queryForList("SELECT query_id FROM ma_side_query WHERE actor_scope_key=? AND kind='recap'"
                        + " AND state='completed' AND outcome='success' ORDER BY gmt_create DESC,query_id DESC LIMIT 1",
                String.class, actorScope(tenant, actor, session));
        return ids.isEmpty() ? null : read(tenant, session, ids.getFirst(), false).query();
    }

    private Query reusableRecap(String tenant, String actor, String session, Prefix prefix, String digest) {
        var ids = jdbc.queryForList("SELECT query_id FROM ma_side_query WHERE actor_scope_key=? AND kind='recap'"
                        + " AND model_config_digest=? AND processing_version=? AND (state IN ('preparing','running')"
                        + " OR (state='completed' AND outcome='success')) ORDER BY gmt_create DESC,query_id DESC LIMIT 32",
                String.class, actorScope(tenant, actor, session), digest, ManagedSideQueryModels.PROCESSING_VERSION);
        for (String id : ids) {
            Query query = read(tenant, session, id, false).query();
            if (query.source().contentVersion().equals(prefix.contentVersion())) {
                return query;
            }
        }
        return null;
    }

    private List<Pair> privateHistory(String tenant, String actor, String session) {
        var pairs = jdbc.query("SELECT question,answer_text FROM ma_side_query WHERE actor_scope_key=?"
                        + " AND tenant_id=? AND session_id=? AND actor_id=? AND kind='btw'"
                        + " AND state='completed' AND outcome='success' ORDER BY gmt_create DESC,query_id DESC LIMIT 20",
                (row, index) -> new Pair(row.getString(1), row.getString(2)), actorScope(tenant, actor, session), tenant, session, actor);
        Collections.reverse(pairs);
        return pairs;
    }

    private void receipt(String tenant, String actor, String session, String scope, String key, String digest, String query) {
        ManagedReceipts.insert(jdbc, ReceiptNamespace.SIDE_QUERY, tenant, ReceiptScope.ACTOR, scope, key,
                digest, "SIDE_QUERY", ManagedSchemaKeys.identity(actor), session, null, "COMPLETED", null, null, now());
        jdbc.update("UPDATE ma_request_receipt SET result_json=? WHERE receipt_key=?", query,
                ManagedSchemaKeys.receiptKey(ReceiptNamespace.SIDE_QUERY, tenant, ReceiptScope.ACTOR, scope, key));
    }

    private StoredResource loadResource(String tenant, String session, String id) {
        var rows = jdbc.query("SELECT kind,schema_version,byte_length,sha256,inline_bytes,storage_kind,state"
                        + " FROM ma_resource WHERE tenant_id=? AND session_id=? AND resource_id=?",
                (row, index) -> {
                    byte[] bytes = row.getBytes(5);
                    if (!"MYSQL_INLINE".equals(row.getString(6)) || !"REFERENCED".equals(row.getString(7))
                            || bytes == null || bytes.length != row.getLong(3) || !JournalStoreRows.sha256(bytes).equals(row.getString(4))) {
                        throw error(409, "side_query_resource_unavailable");
                    }
                    return new StoredResource(id, row.getString(1), row.getInt(2), row.getLong(3), row.getString(4), bytes);
                }, tenant, session, id);
        if (rows.size() != 1) {
            throw error(404, "side_query_resource_not_found");
        }
        return rows.getFirst();
    }

    private void verifyInputClosure(String tenant, String session, InputPublication input, StoredResource manifest) {
        try {
            var root = json.readTree(manifest.bytes());
            if (root == null || !root.isObject()) {
                throw error(409, "side_query_input_conflict");
            }
            var required = new java.util.HashSet<String>();
            required.add(manifest.resourceId());
            if ("qwen-side-query-input/1".equals(root.path("format").asText())) {
                var parts = root.path("parts");
                if (!parts.isArray() || parts.isEmpty() || parts.size() > 1023
                        || root.path("byteLength").asLong() > ManagedSessionStoreModels.MAX_MODEL_REQUEST_BYTES) {
                    throw error(409, "side_query_input_conflict");
                }
                var bytes = new java.io.ByteArrayOutputStream();
                for (var ref : parts) {
                    String id = ref.path("resourceId").asText();
                    if (!input.resourceIds().contains(id)) {
                        throw error(409, "side_query_input_conflict");
                    }
                    StoredResource part = loadResource(tenant, session, id);
                    if (!"managed-side-query-chunk".equals(part.kind()) || ref.path("schemaVersion").asInt() != part.schemaVersion()
                            || ref.path("byteLength").asLong() != part.byteLength() || !ref.path("digest").asText().equals(part.digest())
                            || !ref.path("kind").asText().equals(part.kind())
                            || bytes.size() + part.bytes().length > ManagedSessionStoreModels.MAX_MODEL_REQUEST_BYTES) {
                        throw error(409, "side_query_input_conflict");
                    }
                    required.add(id);
                    bytes.writeBytes(part.bytes());
                }
                if (root.path("byteLength").asLong() != bytes.size()
                        || !root.path("digest").asText().equals(JournalStoreRows.sha256(bytes.toByteArray()))) {
                    throw error(409, "side_query_input_conflict");
                }
            }
            if (!required.equals(new java.util.HashSet<>(input.resourceIds()))) {
                throw error(409, "side_query_input_conflict");
            }
        } catch (java.io.IOException invalid) {
            throw error(409, "side_query_input_conflict");
        }
    }

    private Row read(String tenant, String session, String id, boolean lock) {
        var rows = jdbc.query("SELECT " + ManagedSchemaProjection.SIDE_QUERY.columns()
                        + " FROM ma_side_query WHERE query_key=? AND tenant_id=? AND session_id=? AND query_id=?"
                        + (lock ? " FOR UPDATE" : ""), (row, index) -> {
                    Query query = new Query(id, session, row.getString("kind"), row.getString("trigger_kind"), row.getString("question"),
                            row.getString("state"), row.getString("outcome"), decode(row.getString("source_json"), Prefix.class),
                            row.getLong("result_revision"), row.getString("answer_text"), row.getString("usage_json") == null ? null
                            : decode(row.getString("usage_json"), new TypeReference<Map<String, Object>>() {}), row.getString("error_code"),
                            row.getLong("gmt_create"), row.getLong("gmt_modified"), row.getLong("deadline_at"));
                    return new Row(row.getString("query_key"), tenant, row.getString("actor_id"), query,
                            row.getString("claim_instance_id"), row.getString("claim_boot_id"), row.getLong("claim_generation"),
                            row.getString("claim_token_hash"), row.getString("read_lease_id"), row.getLong("read_deadline_at"),
                            row.getString("model_config_digest"), row.getString("private_history_json"), row.getBoolean("is_input_ready"),
                            row.getString("input_resource_id"), row.getString("input_digest"));
                }, queryKey(tenant, id), tenant, session, id);
        if (rows.size() != 1) {
            throw error(404, "side_query_not_found");
        }
        return rows.getFirst();
    }

    private static void requireActor(Row row, String actor) {
        if (!actor.equals(row.actor())) {
            throw error(404, "side_query_not_found");
        }
    }

    private static void requireClaim(Row row, Claim claim) {
        if (claim == null || !Objects.equals(row.instance(), claim.instanceId()) || !Objects.equals(row.boot(), claim.bootId())
                || row.generation() != claim.generation() || claim.token() == null
                || !Objects.equals(row.claimHash(), ManagedSchemaKeys.key(claim.token()))) {
            throw error(409, "side_query_claim_conflict");
        }
    }

    private static void validate(Create request) {
        if (request == null || request.kind() == null || !Set.of("btw", "recap").contains(request.kind())
                || request.idempotencyKey() == null || request.idempotencyKey().isBlank() || request.idempotencyKey().length() > 512
                || request.idempotencyKey().startsWith("automatic:")
                || request.trigger() != null && !Set.of("manual", "automatic").contains(request.trigger())
                || "btw".equals(request.kind()) && (request.question() == null || request.question().isBlank() || request.question().length() > 4096
                        || "automatic".equals(request.trigger()))
                || "recap".equals(request.kind()) && request.question() != null) {
            throw error(400, "invalid_side_query_request");
        }
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (java.io.IOException invalid) {
            throw new IllegalStateException(invalid);
        }
    }

    private <T> T decode(String value, Class<T> type) {
        try {
            return json.readValue(value, type);
        } catch (java.io.IOException invalid) {
            throw new IllegalStateException(invalid);
        }
    }

    private <T> T decode(String value, TypeReference<T> type) {
        try {
            return json.readValue(value, type);
        } catch (java.io.IOException invalid) {
            throw new IllegalStateException(invalid);
        }
    }

    private long now() {
        return ToolPublicationRetentionStore.now(jdbc);
    }

    private static String queryKey(String tenant, String query) {
        return ManagedSchemaKeys.key(tenant, query);
    }

    private static String actorScope(String tenant, String actor, String session) {
        return ManagedSchemaKeys.key(tenant, session, actor);
    }

    private static ManagedAgentException error(int status, String code) {
        return new ManagedAgentException(status, code, "The side query request could not be completed.");
    }

    private record Row(String key, String tenant, String actor, Query query, String instance, String boot,
            long generation, String claimHash, String lease, long readDeadline, String modelDigest,
            String history, boolean ready, String inputId, String inputDigest) {}
}
