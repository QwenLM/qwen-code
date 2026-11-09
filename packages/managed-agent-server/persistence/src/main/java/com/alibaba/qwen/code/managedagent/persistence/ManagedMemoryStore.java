package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Admission;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Store;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Repository
public class ManagedMemoryStore implements MemoryRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final Clock clock;
    private final ManagedAgentSettings settings;
    private final JdbcManagedSessionStore sessions;
    private final TransactionTemplate transaction;

    public ManagedMemoryStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            @Qualifier("managedAgentClock") Clock clock, ManagedAgentSettings settings,
            JdbcManagedSessionStore sessions,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.settings = settings;
        this.sessions = sessions;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
    }

    @Override
    public void requireEnabled() {
        if (!settings.isMemoryEnabled() || !settings.getSessionStore().isEnabled()) {
            throw new ManagedAgentException(503, "memory_disabled", "Personal memory is disabled.");
        }
    }

    @Override
    public List<Store> list(String tenant, String actor) {
        byte[] owner = owner(tenant, actor);
        requireEnabled();
        return jdbc.query("SELECT memory_store_id,gmt_create FROM ma_memory_store"
                        + " WHERE owner_key=? AND tenant_id=? AND owner_actor_key=?",
                (row, index) -> new Store(ManagedSchemaRows.identity(row, "memory_store_id"), row.getLong("gmt_create")),
                ManagedSchemaKeys.key(tenant, actor), tenant, owner);
    }

    @Override
    public Store create(String tenant, String actor) {
        var existing = list(tenant, actor);
        if (!existing.isEmpty()) {
            return existing.getFirst();
        }
        Store result = new Store("memstore_" + UUID.randomUUID(), clock.millis());
        try {
            transaction.executeWithoutResult(status -> jdbc.update("INSERT INTO ma_memory_store"
                            + " (store_key,owner_key,tenant_id,memory_store_id,owner_actor_key,namespace,gmt_create) VALUES (?,?,?,?,?,?,?)",
                    ManagedSchemaKeys.key(tenant, result.id()), ManagedSchemaKeys.key(tenant, actor),
                    tenant, result.id(), owner(tenant, actor), "managed_" + UUID.randomUUID(), result.createdAt()));
            return result;
        } catch (DuplicateKeyException duplicate) {
            var recorded = list(tenant, actor);
            if (recorded.size() == 1) {
                return recorded.getFirst();
            }
            throw new ManagedAgentException(409, "memory_conflict", "MemoryStore creation conflicted.");
        }
    }

    public static void bind(JdbcTemplate jdbc, String tenant, String actor, String session, String store) {
        if (store == null) {
            return;
        }
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Memory binding requires the Session creation transaction.");
        }
        if (!MemoryModels.text(store, 512) || jdbc.queryForObject("SELECT COUNT(*) FROM ma_memory_store"
                + " WHERE store_key=? AND tenant_id=? AND memory_store_id=? AND owner_actor_key=?",
                Integer.class, ManagedSchemaKeys.key(tenant, store), tenant, store, owner(tenant, actor)) != 1) {
            throw unavailable();
        }
        if (jdbc.update("UPDATE ma_session SET memory_store_id=?,owner_only=1 WHERE tenant_id=? AND session_id=?"
                + " AND memory_store_id IS NULL AND COALESCE(owner_actor_key,creator_actor_key)=?",
                store, tenant, session, owner(tenant, actor)) != 1) {
            throw new ManagedAgentException(409, "memory_binding_conflict", "The Session memory binding is immutable.");
        }
    }

    @Override
    public Admission admit(String tenant, String session, String writerToken, Query request) {
        request.validate();
        return transaction.execute(status -> {
            sessions.authorizeOrdinary(tenant, session, writerToken, new AuthorizeLifecycleRequest(
                    request.workspaceId(), request.writerId(), request.writerGeneration(), null));
            var bindings = jdbc.query("SELECT m.memory_store_id,m.namespace FROM ma_session s JOIN ma_memory_store m"
                            + " ON m.tenant_id=s.tenant_id AND m.memory_store_id=s.memory_store_id"
                            + " AND m.owner_actor_key=COALESCE(s.owner_actor_key,s.creator_actor_key)"
                            + " WHERE s.tenant_id=? AND s.session_id=? AND s.owner_only=1",
                    (row, index) -> Map.entry(ManagedSchemaRows.identity(row, "memory_store_id"), row.getString("namespace")), tenant, session);
            if (bindings.isEmpty() && jdbc.queryForObject("SELECT COUNT(*) FROM ma_session"
                    + " WHERE tenant_id=? AND session_id=? AND memory_store_id IS NOT NULL", Integer.class, tenant, session) != 0) {
                throw unavailable();
            }
            if ("binding".equals(request.operation())) {
                String bound = bindings.isEmpty() || !settings.isMemoryEnabled() ? null : bindings.getFirst().getKey();
                return new Admission(tenant, session, bound, null, null, null, request, Result.binding(bound));
            }
            requireEnabled();
            if (bindings.size() != 1) {
                throw unavailable();
            }
            String store = bindings.getFirst().getKey();
            String namespace = bindings.getFirst().getValue();
            String key = ManagedSchemaKeys.key("recall".equals(request.operation()) ? "recall" : "tool",
                    request.inputId(), request.callId());
            String digest = ManagedSchemaKeys.key(store, request.operation(), request.inputId(), request.callId(),
                    value(request.query()), value(request.content()), value(request.memoryId()), value(request.expectedContent()));
            var prior = ManagedReceipts.find(jdbc, ReceiptNamespace.MEMORY, tenant, ReceiptScope.SESSION, session, key, true);
            if (prior != null) {
                if (!digest.equals(prior.requestDigest())) {
                    throw new ManagedAgentException(409, "idempotency_conflict", "Memory operation arguments changed.");
                }
                Result replay = prior.resultJson() == null ? Result.status(write(request) ? "unknown" : "unavailable")
                        : decode(prior.resultJson());
                return new Admission(tenant, session, store, namespace, key, digest, request, replay);
            }
            requireInput(tenant, session, request.inputId());
            Result refused = ("get".equals(request.operation()) || "forget".equals(request.operation()))
                    && !ownsEntry(tenant, store, request.memoryId())
                    ? Result.status("forget".equals(request.operation()) ? "not_deleted" : "unavailable") : null;
            ManagedReceipts.insert(jdbc, ReceiptNamespace.MEMORY, tenant, ReceiptScope.SESSION, session, key, digest,
                    request.operation(), null, session, null, "DISPATCHED", null, null, clock.millis());
            Admission admitted = new Admission(tenant, session, store, namespace, key, digest, request, null);
            if (refused != null) {
                save(admitted, refused);
                return new Admission(tenant, session, store, namespace, key, digest, request, refused);
            }
            return admitted;
        });
    }

    @Override
    public Result complete(Admission admitted, Result result) {
        return transaction.execute(status -> {
            var receipt = ManagedReceipts.find(jdbc, ReceiptNamespace.MEMORY, admitted.tenantId(), ReceiptScope.SESSION,
                    admitted.sessionId(), admitted.key(), true);
            if (receipt == null || !receipt.requestDigest().equals(admitted.digest())) {
                throw new IllegalStateException("Memory receipt disappeared or changed.");
            }
            if (receipt.resultJson() != null) {
                return decode(receipt.resultJson());
            }
            Result saved = result;
            if ("stored".equals(result.status())) {
                if (!MemoryModels.identifier(result.memoryId())) {
                    saved = Result.status("unknown");
                } else {
                    String key = ManagedSchemaKeys.key(admitted.tenantId(), admitted.storeId(), result.memoryId());
                    jdbc.update("INSERT INTO ma_memory_entry (entry_key,tenant_id,memory_store_id,memory_id,gmt_create,gmt_modified)"
                                    + " VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE entry_key=entry_key",
                            key, admitted.tenantId(), admitted.storeId(), result.memoryId(), clock.millis(), clock.millis());
                    if (!ownsEntry(admitted.tenantId(), admitted.storeId(), result.memoryId())) {
                        saved = Result.status("unknown");
                    }
                }
            } else if ("deleted".equals(result.status())) {
                jdbc.update("UPDATE ma_memory_entry SET is_deleted=1,gmt_modified=? WHERE entry_key=?"
                                + " AND tenant_id=? AND memory_store_id=? AND memory_id=?",
                        clock.millis(), ManagedSchemaKeys.key(admitted.tenantId(), admitted.storeId(), admitted.query().memoryId()),
                        admitted.tenantId(), admitted.storeId(), admitted.query().memoryId());
            } else if (result.items() != null) {
                saved = Result.items(result.items().stream()
                        .filter(item -> ownsEntry(admitted.tenantId(), admitted.storeId(), item.memoryId())).toList());
            }
            save(admitted, saved);
            return saved;
        });
    }

    private void requireInput(String tenant, String session, String input) {
        int separator = input.lastIndexOf(':');
        Integer count;
        if (input.startsWith("umsg_") && separator > 0) {
            long revision;
            try {
                revision = Long.parseLong(input.substring(separator + 1));
            }
            catch (NumberFormatException invalid) {
                throw MemoryModels.invalid();
            }
            count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_user_message WHERE tenant_id=? AND session_id=?"
                            + " AND message_id=? AND revision=? AND state IN ('claimed','consumed')",
                    Integer.class, tenant, session, input.substring(0, separator), revision);
        } else {
            count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id=? AND session_id=? AND prompt_id=?",
                    Integer.class, tenant, session, input);
        }
        if (count == null || count != 1) {
            throw new ManagedAgentException(409, "memory_input_unavailable", "Memory requires an accepted user input.");
        }
    }

    private boolean ownsEntry(String tenant, String store, String id) {
        return id != null && jdbc.queryForObject("SELECT COUNT(*) FROM ma_memory_entry WHERE entry_key=?"
                        + " AND tenant_id=? AND memory_store_id=? AND memory_id=? AND is_deleted=0",
                Integer.class, ManagedSchemaKeys.key(tenant, store, id), tenant, store, id) == 1;
    }

    private void save(Admission admitted, Result result) {
        try {
            jdbc.update("UPDATE ma_request_receipt SET state='COMPLETED',result_json=?,gmt_modified=? WHERE receipt_key=?"
                            + " AND request_digest=? AND result_json IS NULL", json.writeValueAsString(result), clock.millis(),
                    ManagedSchemaKeys.receiptKey(ReceiptNamespace.MEMORY, admitted.tenantId(), ReceiptScope.SESSION,
                            admitted.sessionId(), admitted.key()), admitted.digest());
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Cannot persist memory result.", error);
        }
    }

    private Result decode(String value) {
        try {
            return json.readValue(value, Result.class);
        }
        catch (JsonProcessingException error) {
            throw new IllegalStateException("Invalid stored memory result.", error);
        }
    }

    private static boolean write(Query query) { return "remember".equals(query.operation()) || "forget".equals(query.operation()); }
    private static String value(String value) { return value == null ? "" : value; }
    private static byte[] owner(String tenant, String actor) {
        if (!MemoryModels.text(actor, 512)) {
            throw new ManagedAgentException(401, "actor_required", "A trusted actor is required.");
        }
        return ManagedWorkspaceRegistry.actorKey(tenant, actor);
    }
    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(404, "memory_store_not_found", "MemoryStore was not found.");
    }
}
