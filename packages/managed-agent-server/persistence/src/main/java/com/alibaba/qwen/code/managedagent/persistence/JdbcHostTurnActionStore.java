package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionExecutor;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionInvocation;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionReceipt;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionResult;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionSpec;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * Durable store and Broker execution coordinator for Turn-scoped host actions
 * on {@code hosted-workspace-external-files/1} Sessions.
 */
@Repository
public class JdbcHostTurnActionStore implements HostTurnActionStore {
    private static final TypeReference<List<Map<String, Object>>> SPEC_LIST_TYPE =
            new TypeReference<>() {
            };
    private static final TypeReference<Map<String, Object>> MAP_TYPE =
            new TypeReference<>() {
            };

    private final JdbcTemplate jdbc;
    private final TransactionTemplate requiredTx;
    private final TransactionTemplate independentTx;
    private final ObjectMapper json;
    private final Clock clock;
    private final ObjectProvider<HostTurnActionExecutor> executors;
    private final ManagedAgentSettings settings;
    private final ConcurrentHashMap<String, ReentrantLock> callLocks = new ConcurrentHashMap<>();

    public JdbcHostTurnActionStore(
            @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager transactionManager,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            @Qualifier("managedAgentClock") Clock clock,
            ObjectProvider<HostTurnActionExecutor> executors,
            ManagedAgentSettings settings) {
        this.jdbc = jdbc;
        this.requiredTx = new TransactionTemplate(transactionManager);
        TransactionTemplate requiresNew = new TransactionTemplate(transactionManager);
        requiresNew.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.independentTx = requiresNew;
        this.json = json;
        this.clock = clock;
        this.executors = executors;
        this.settings = settings;
    }

    @Override
    public boolean isAvailable() {
        return settings.getRuntimeBroker().isEnabled() && executors.getIfAvailable() != null;
    }

    @Override
    public <T> T inTransaction(Supplier<T> work) {
        return requiredTx.execute(status -> work.get());
    }

    @Override
    public void saveForTurn(String tenantId, String sessionId, String turnId, List<HostTurnActionSpec> specs) {
        List<HostTurnActionSpec> validated = validateSpecsForAdmission(specs);
        if (validated.isEmpty()) {
            return;
        }
        List<String> profiles = jdbc.query(
                "SELECT tool_profile FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                (row, index) -> row.getString(1),
                tenantId,
                sessionId);
        if (profiles.size() != 1 || !WorkspaceToolProfiles.EXTERNAL_FILES.equals(profiles.getFirst())) {
            throw new ManagedAgentException(409, "host_actions_profile_unsupported",
                    "Turn-scoped host actions are supported only on hosted-workspace-external-files/1 Sessions.");
        }
        String serialized = serializeSpecs(validated);
        if (serialized.getBytes(StandardCharsets.UTF_8).length > HostTurnActionSpec.MAX_TOTAL_BYTES) {
            throw new ManagedAgentException(400, "invalid_host_actions",
                    "Serialized host actions exceed the Turn byte limit.");
        }
        int updated = jdbc.update(
                "UPDATE ma_turn SET host_actions_json = ? WHERE tenant_id = ? AND session_id = ?"
                        + " AND turn_id = ? AND host_actions_json IS NULL",
                serialized,
                tenantId,
                sessionId,
                turnId);
        if (updated != 1) {
            throw new ManagedAgentException(409, "host_actions_unavailable",
                    "Turn host actions could not be recorded.");
        }
    }

    public static List<HostTurnActionSpec> validateSpecsForAdmission(List<HostTurnActionSpec> specs) {
        try {
            return HostTurnActionSpec.validateList(specs);
        } catch (IllegalArgumentException invalid) {
            throw new ManagedAgentException(400, "invalid_host_actions", invalid.getMessage());
        }
    }

    @Override
    public List<Map<String, Object>> wireActionsForPrompt(String tenantId, String sessionId, String promptId) {
        List<String> rows = jdbc.query(
                "SELECT host_actions_json FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND prompt_id = ?",
                (row, index) -> row.getString(1),
                tenantId,
                sessionId,
                promptId);
        if (rows.isEmpty() || rows.getFirst() == null) {
            return null;
        }
        List<HostTurnActionSpec> specs = parseSpecs(rows.getFirst());
        List<Map<String, Object>> wire = new ArrayList<>(specs.size());
        for (HostTurnActionSpec spec : specs) {
            wire.add(spec.wireDeclaration());
        }
        return Collections.unmodifiableList(wire);
    }

    @Override
    public Map<String, Object> executeFromBroker(String harnessSessionId, Map<String, Object> requestBody) {
        HostTurnActionExecutor executor = executors.getIfAvailable();
        if (executor == null) {
            throw new RuntimeBrokerException(503, "host_action_executor_unavailable",
                    "No HostTurnActionExecutor is registered on the host.", false);
        }
        String tenantId = requiredId(requestBody, "tenantId", 36);
        String workspaceId = requiredId(requestBody, "workspaceId", 512);
        String promptId = requiredId(requestBody, "promptId", 64);
        String callId = requiredId(requestBody, "callId", 63);
        String actionName = requiredId(requestBody, "actionName", 64);
        String argsDigest = requiredId(requestBody, "argsDigest", 80);
        Object rawArgs = requestBody.get("arguments");
        if (!(rawArgs instanceof Map<?, ?> rawMap)) {
            throw new RuntimeBrokerException(400, "runtime_request_invalid",
                    "Host action arguments must be an object.", false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> untypedArgs = (Map<String, Object>) rawMap;

        String writerId = optionalString(requestBody, "writerId");
        Long writerGeneration = optionalPositiveLong(requestBody, "writerGeneration");
        verifySessionWriterFence(tenantId, workspaceId, harnessSessionId, writerId, writerGeneration);

        record TurnBinding(String turnId, String status, String toolProfile, String sessionStatus,
                Long deletedAt, String hostActionsJson) {
        }
        List<TurnBinding> turns = jdbc.query(
                "SELECT t.turn_id, t.status, s.tool_profile, s.status AS session_status, s.deleted_at,"
                        + " t.host_actions_json FROM ma_turn t JOIN ma_session s"
                        + " ON s.tenant_id = t.tenant_id AND s.session_id = t.session_id"
                        + " WHERE t.tenant_id = ? AND t.session_id = ? AND t.prompt_id = ? AND s.workspace_id = ?",
                (row, index) -> new TurnBinding(
                        row.getString("turn_id"),
                        row.getString("status"),
                        row.getString("tool_profile"),
                        row.getString("session_status"),
                        AgentStoreRows.nullableLong(row, "deleted_at"),
                        row.getString("host_actions_json")),
                tenantId,
                harnessSessionId,
                promptId,
                workspaceId);
        if (turns.size() != 1) {
            throw new RuntimeBrokerException(404, "host_action_turn_not_found",
                    "The Turn is not bound to this Session.", false);
        }
        TurnBinding turn = turns.getFirst();
        if (turn.deletedAt() != null || !"ACTIVE".equals(turn.sessionStatus())
                || !WorkspaceToolProfiles.EXTERNAL_FILES.equals(turn.toolProfile())) {
            throw new RuntimeBrokerException(409, "host_action_profile_unsupported",
                    "Session does not admit external Files host actions.", false);
        }
        if (!List.of("ACCEPTED", "RUNNING").contains(turn.status())) {
            throw new RuntimeBrokerException(409, "host_action_turn_inactive",
                    "The Turn is no longer active.", false);
        }
        if (turn.hostActionsJson() == null) {
            throw new RuntimeBrokerException(403, "host_action_not_authorized",
                    "No host actions were authorized for this Turn.", false);
        }
        HostTurnActionSpec authorized = parseSpecs(turn.hostActionsJson()).stream()
                .filter(candidate -> candidate.name().equals(actionName))
                .findFirst()
                .orElseThrow(() -> new RuntimeBrokerException(403, "host_action_not_authorized",
                        "Host action is not authorized for this Turn: " + actionName, false));

        Map<String, Object> validatedArgs;
        try {
            validatedArgs = authorized.validateArguments(untypedArgs);
        } catch (IllegalArgumentException invalid) {
            throw new RuntimeBrokerException(400, "host_action_arguments_invalid",
                    invalid.getMessage(), false);
        }
        String computedArgsDigest = "sha256:" + DigestUtils.sha256Hex(canonicalBytes(validatedArgs));
        if (!computedArgsDigest.equals(argsDigest)) {
            throw new RuntimeBrokerException(409, "runtime_idempotency_conflict",
                    "Host action arguments differ from argsDigest.", false);
        }

        String idempotencyKey = turn.turnId() + ":" + callId;
        BrokerValues.requireIdempotencyKey(idempotencyKey, "idempotencyKey");
        Map<String, Object> requestIdentity = new LinkedHashMap<>();
        requestIdentity.put("promptId", promptId);
        requestIdentity.put("callId", callId);
        requestIdentity.put("actionName", actionName);
        requestIdentity.put("argsDigest", computedArgsDigest);
        String requestDigest = "sha256:" + DigestUtils.sha256Hex(canonicalBytes(requestIdentity));

        String lockKey = tenantId + "\0" + harnessSessionId + "\0" + idempotencyKey;
        ReentrantLock lock = callLocks.computeIfAbsent(lockKey, ignored -> new ReentrantLock());
        lock.lock();
        try {
            ManagedReceipts.Receipt existing = ManagedReceipts.find(
                    jdbc, ReceiptNamespace.HOST_TURN_ACTION, tenantId,
                    ReceiptScope.SESSION, harnessSessionId, idempotencyKey, false);
            if (existing != null) {
                if (!requestDigest.equals(existing.requestDigest())
                        || !actionName.equals(existing.operation())) {
                    throw new RuntimeBrokerException(409, "runtime_idempotency_conflict",
                            "Host action retry conflicts with the recorded call identity.", false);
                }
                if (("COMPLETED".equals(existing.state()) || "FAILED".equals(existing.state()))
                        && existing.resultJson() != null) {
                    return wireResponse(harnessSessionId, readStoredEnvelope(existing.resultJson()), true);
                }
            } else {
                long now = clock.millis();
                independentTx.executeWithoutResult(status -> ManagedReceipts.insert(
                        jdbc,
                        ReceiptNamespace.HOST_TURN_ACTION,
                        tenantId,
                        ReceiptScope.SESSION,
                        harnessSessionId,
                        idempotencyKey,
                        requestDigest,
                        actionName,
                        null,
                        harnessSessionId,
                        turn.turnId(),
                        "PENDING",
                        null,
                        true,
                        now));
            }

            HostTurnActionInvocation invocation = new HostTurnActionInvocation(
                    tenantId,
                    harnessSessionId,
                    turn.turnId(),
                    promptId,
                    callId,
                    actionName,
                    authorized.contextRef(),
                    validatedArgs);
            HostTurnActionResult outcome;
            try {
                outcome = Objects.requireNonNull(executor.execute(invocation),
                        "HostTurnActionExecutor returned null");
            } catch (Exception failure) {
                String message = StringUtils.defaultIfBlank(failure.getMessage(),
                        "Host action execution failed.");
                outcome = HostTurnActionResult.error(StringUtils.truncate(message, 1024));
            }

            Map<String, Object> stored = new LinkedHashMap<>();
            stored.put("turnId", turn.turnId());
            stored.put("promptId", promptId);
            stored.put("callId", callId);
            stored.put("actionName", actionName);
            stored.put("isError", outcome.isError());
            if (outcome.text() != null) {
                stored.put("text", outcome.text());
            }
            stored.put("output", outcome.output());
            String resultJson = writeJson(stored);
            if (resultJson.getBytes(StandardCharsets.UTF_8).length > HostTurnActionResult.MAX_RESULT_BYTES) {
                throw new RuntimeBrokerException(502, "host_action_result_too_large",
                        "Host action result exceeds the inline Session limit.", false);
            }
            String finalState = outcome.isError() ? "FAILED" : "COMPLETED";
            long settledAt = clock.millis();
            String receiptKey = ManagedSchemaKeys.receiptKey(
                    ReceiptNamespace.HOST_TURN_ACTION, tenantId,
                    ReceiptScope.SESSION, harnessSessionId, idempotencyKey);
            independentTx.executeWithoutResult(status -> jdbc.update(
                    "UPDATE ma_request_receipt SET state = ?, result_json = ?, gmt_modified = ?"
                            + " WHERE receipt_key = ? AND namespace = ? AND tenant_id = ?",
                    finalState,
                    resultJson,
                    settledAt,
                    receiptKey,
                    ReceiptNamespace.HOST_TURN_ACTION.name(),
                    tenantId));
            return wireResponse(harnessSessionId, stored, false);
        } finally {
            lock.unlock();
            if (!lock.hasQueuedThreads()) {
                callLocks.remove(lockKey, lock);
            }
        }
    }

    @Override
    public List<HostTurnActionReceipt> listReceipts(String tenantId, String sessionId, String turnId) {
        List<String> prompts = jdbc.query(
                "SELECT prompt_id FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND turn_id = ?",
                (row, index) -> row.getString(1),
                tenantId,
                sessionId,
                turnId);
        if (prompts.size() != 1) {
            throw new ManagedAgentException(404, "turn_not_found", "The Turn was not found.");
        }
        String fallbackPromptId = prompts.getFirst();
        return jdbc.query(
                "SELECT idempotency_key, operation, state, result_json, turn_id, gmt_create, gmt_modified"
                        + " FROM ma_request_receipt WHERE namespace = ? AND tenant_id = ? AND session_id = ?"
                        + " ORDER BY gmt_create ASC, id ASC",
                (row, index) -> {
                    String rowTurnId = ManagedSchemaRows.identity(row, "turn_id");
                    if (!turnId.equals(rowTurnId)) {
                        return null;
                    }
                    String key = ManagedSchemaRows.identity(row, "idempotency_key");
                    String prefix = turnId + ":";
                    String callId = key != null && key.startsWith(prefix)
                            ? key.substring(prefix.length()) : Objects.toString(key, "");
                    String resultJson = row.getString("result_json");
                    HostTurnActionResult parsedResult = null;
                    String promptId = fallbackPromptId;
                    if (resultJson != null) {
                        Map<String, Object> stored = readStoredEnvelope(resultJson);
                        if (stored.get("promptId") instanceof String savedPrompt) {
                            promptId = savedPrompt;
                        }
                        boolean isError = Boolean.TRUE.equals(stored.get("isError"));
                        String text = stored.get("text") instanceof String s ? s : null;
                        @SuppressWarnings("unchecked")
                        Map<String, Object> output = stored.get("output") instanceof Map<?, ?> m
                                ? (Map<String, Object>) m : Map.of();
                        parsedResult = new HostTurnActionResult(isError, text, output);
                    }
                    return new HostTurnActionReceipt(
                            sessionId,
                            turnId,
                            promptId,
                            callId,
                            row.getString("operation"),
                            row.getString("state"),
                            parsedResult,
                            row.getLong("gmt_create"),
                            row.getLong("gmt_modified"));
                },
                ReceiptNamespace.HOST_TURN_ACTION.name(),
                tenantId,
                sessionId).stream().filter(Objects::nonNull).toList();
    }

    private void verifySessionWriterFence(String tenantId, String workspaceId, String sessionId,
            String writerId, Long writerGeneration) {
        record HeadRow(String state, String writerId, long writerGeneration, long leaseUntil) {
        }
        List<HeadRow> heads = jdbc.query(
                "SELECT state, writer_id, writer_generation, writer_lease_until FROM ma_session_head"
                        + " WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'"
                        + " AND (workspace_id IS NULL OR workspace_id = ?)",
                (row, index) -> new HeadRow(
                        row.getString("state"),
                        row.getString("writer_id"),
                        row.getLong("writer_generation"),
                        row.getLong("writer_lease_until")),
                tenantId,
                sessionId,
                workspaceId);
        if (heads.isEmpty()) {
            return;
        }
        HeadRow head = heads.getFirst();
        long now = clock.millis();
        if (writerId == null || writerGeneration == null
                || !"ACTIVE".equals(head.state())
                || !writerId.equals(head.writerId())
                || writerGeneration.longValue() != head.writerGeneration()
                || head.leaseUntil() <= now) {
            throw new RuntimeBrokerException(409, "managed_session_writer_conflict",
                    "Session writer lease does not hold authority for host action execution.", false);
        }
    }

    private static Map<String, Object> wireResponse(String sessionId, Map<String, Object> stored, boolean replayed) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("protocolVersion", 1);
        response.put("harnessSessionId", sessionId);
        response.put("turnId", stored.get("turnId"));
        response.put("promptId", stored.get("promptId"));
        response.put("callId", stored.get("callId"));
        response.put("actionName", stored.get("actionName"));
        response.put("isError", Boolean.TRUE.equals(stored.get("isError")));
        if (stored.get("text") != null) {
            response.put("text", stored.get("text"));
        }
        response.put("output", stored.get("output") instanceof Map<?, ?> map ? map : Map.of());
        response.put("replayed", replayed);
        return response;
    }

    private String serializeSpecs(List<HostTurnActionSpec> specs) {
        List<Map<String, Object>> values = new ArrayList<>(specs.size());
        for (HostTurnActionSpec spec : specs) {
            values.add(spec.semanticValue());
        }
        return writeJson(values);
    }

    private List<HostTurnActionSpec> parseSpecs(String rawJson) {
        try {
            List<Map<String, Object>> list = json.readValue(rawJson, SPEC_LIST_TYPE);
            List<HostTurnActionSpec> specs = new ArrayList<>(list.size());
            for (Map<String, Object> item : list) {
                @SuppressWarnings("unchecked")
                Map<String, Object> schema = (Map<String, Object>) item.get("inputSchema");
                specs.add(new HostTurnActionSpec(
                        (String) item.get("name"),
                        (String) item.get("description"),
                        schema,
                        (String) item.get("contextRef")));
            }
            return Collections.unmodifiableList(specs);
        } catch (JsonProcessingException | RuntimeException corrupt) {
            throw new IllegalStateException("Stored Turn host actions are invalid", corrupt);
        }
    }

    private Map<String, Object> readStoredEnvelope(String rawJson) {
        try {
            return json.readValue(rawJson, MAP_TYPE);
        } catch (JsonProcessingException corrupt) {
            throw new IllegalStateException("Stored host action receipt is invalid", corrupt);
        }
    }

    private String writeJson(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException failure) {
            throw new IllegalArgumentException("Value cannot be serialized as JSON", failure);
        }
    }

    private byte[] canonicalBytes(Object value) {
        try {
            return json.writeValueAsBytes(canonicalize(value));
        } catch (JsonProcessingException failure) {
            throw new IllegalArgumentException("Value cannot be canonicalized", failure);
        }
    }

    private static Object canonicalize(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                sorted.put(String.valueOf(entry.getKey()), canonicalize(entry.getValue()));
            }
            return sorted;
        }
        if (value instanceof List<?> list) {
            List<Object> ordered = new ArrayList<>(list.size());
            for (Object item : list) {
                ordered.add(canonicalize(item));
            }
            return ordered;
        }
        return value;
    }

    private static String requiredId(Map<String, Object> body, String key, int maxLength) {
        Object value = body.get(key);
        if (!(value instanceof String text) || text.isBlank() || text.length() > maxLength
                || text.indexOf('\0') >= 0) {
            throw new RuntimeBrokerException(400, "runtime_request_invalid",
                    key + " is required and must be valid.", false);
        }
        return text;
    }

    private static String optionalString(Map<String, Object> body, String key) {
        Object value = body.get(key);
        if (value == null) {
            return null;
        }
        if (!(value instanceof String text) || text.isBlank() || text.length() > 512 || text.indexOf('\0') >= 0) {
            throw new RuntimeBrokerException(400, "runtime_request_invalid",
                    key + " must be a valid non-empty string.", false);
        }
        return text;
    }

    private static Long optionalPositiveLong(Map<String, Object> body, String key) {
        Object value = body.get(key);
        if (value == null) {
            return null;
        }
        if (!(value instanceof Number num) || num.doubleValue() != Math.rint(num.doubleValue())
                || num.longValue() < 1) {
            throw new RuntimeBrokerException(400, "runtime_request_invalid",
                    key + " must be a positive integer.", false);
        }
        return num.longValue();
    }
}
