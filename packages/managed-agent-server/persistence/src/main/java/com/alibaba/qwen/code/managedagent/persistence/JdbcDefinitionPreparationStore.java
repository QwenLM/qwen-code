package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation.PreparedBundle;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition;
import com.alibaba.qwen.code.managedagent.repository.ManagedDefinitionPreparationStore;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.io.IOException;
import java.util.List;
import java.util.Optional;

@Repository
public class JdbcDefinitionPreparationStore implements ManagedDefinitionPreparationStore {
    private static final ReceiptNamespace NAMESPACE = ReceiptNamespace.SOURCE_DEFINITION_PREPARATION;
    private static final TypeReference<List<PreparedBundle>> BUNDLES = new TypeReference<>() {
    };
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public JdbcDefinitionPreparationStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    public Preparation begin(String tenantId, String scopeId, String operationKey,
            String requestDigest, byte[] actorKey, long now) {
        var existing = find(tenantId, scopeId, operationKey, requestDigest);
        if (existing.isPresent()) {
            return existing.get();
        }
        try {
            ManagedReceipts.insert(jdbc, NAMESPACE, tenantId, ReceiptScope.ACTOR, scopeId,
                    operationKey, requestDigest, "prepareDefinition", actorKey,
                    null, null, State.PENDING.name(), null, null, now);
        } catch (DuplicateKeyException race) {
            return find(tenantId, scopeId, operationKey, requestDigest)
                    .orElseThrow(() -> conflict("definition_preparation_conflict", race));
        }
        return new Preparation(State.PENDING, null, null, List.of());
    }

    @Override
    public void resolve(String tenantId, String scopeId, String operationKey,
            ManagedAgentDefinitionSource.Definition input, String resultJson, long now) {
        int updated = jdbc.update("UPDATE ma_request_receipt SET state = ?,"
                + " result_json = ?, gmt_modified = ? WHERE receipt_key = ?"
                + " AND namespace = ? AND state = ?",
                State.RESOLVED.name(), resultJson, now, receiptKey(tenantId, scopeId, operationKey),
                NAMESPACE.name(), State.PENDING.name());
        requireSingleTransition(updated);
    }

    @Override
    public void complete(String tenantId, String scopeId, String operationKey,
            AgentDefinition definition, List<PreparedBundle> bundles, String resultJson, long now) {
        int updated = jdbc.update("UPDATE ma_request_receipt SET state = ?, operation = ?,"
                + " result_json = ?, agent_id = ?, agent_revision = ?, gmt_modified = ?"
                + " WHERE receipt_key = ? AND namespace = ? AND state IN (?, ?)",
                State.PREPARED.name(), "prepareDefinition", resultJson, definition.id(),
                Long.parseLong(definition.revision()), now, receiptKey(tenantId, scopeId, operationKey),
                NAMESPACE.name(), State.PENDING.name(), State.RESOLVED.name());
        requireSingleTransition(updated);
    }

    @Override
    public Optional<Preparation> find(String tenantId, String scopeId, String operationKey,
            String requestDigest) {
        var receipt = ManagedReceipts.find(jdbc, NAMESPACE, tenantId, ReceiptScope.ACTOR,
                scopeId, operationKey, false);
        if (receipt == null) {
            return Optional.empty();
        }
        if (!requestDigest.equals(receipt.requestDigest())) {
            throw conflict("idempotency_conflict", null);
        }
        State state = State.valueOf(receipt.state());
        if (state == State.PENDING) {
            return Optional.of(new Preparation(state, null, null, List.of()));
        }
        try {
            ManagedAgentDefinitionSource.Definition input = null;
            AgentDefinition definition = null;
            List<PreparedBundle> bundles = null;
            var result = json.readTree(receipt.resultJson());
            if (result == null || result.isNull()) {
                throw new ManagedAgentException(409, "definition_preparation_incomplete",
                        "The saved preparation result is missing.");
            }
            if (state == State.RESOLVED || result.hasNonNull("input")) {
                input = convert(result, "input", ManagedAgentDefinitionSource.Definition.class);
            }
            if (state == State.PREPARED) {
                definition = convert(result, "definition", AgentDefinition.class);
                bundles = json.readValue(json.treeAsTokens(result.get("bundles")), BUNDLES);
                if (bundles == null) {
                    throw new ManagedAgentException(409, "definition_preparation_incomplete",
                            "The saved bundle plan is missing.");
                }
            }
            return Optional.of(new Preparation(state, input, definition, bundles));
        } catch (IOException error) {
            throw new IllegalStateException("The saved definition preparation is invalid", error);
        }
    }

    private <T> T convert(JsonNode result, String field,
            Class<T> type) throws JsonProcessingException {
        var node = result.get(field);
        if (node == null) {
            throw new ManagedAgentException(409, "definition_preparation_incomplete",
                    "The saved " + field + " is missing.");
        }
        return json.treeToValue(node, type);
    }

    private static void requireSingleTransition(int updated) {
        if (updated != 1) {
            throw conflict("definition_preparation_conflict", null);
        }
    }

    private static String receiptKey(String tenantId, String scopeId, String operationKey) {
        return ManagedSchemaKeys.receiptKey(NAMESPACE, tenantId, ReceiptScope.ACTOR,
                scopeId, operationKey);
    }

    private static ManagedAgentException conflict(String code, Throwable cause) {
        return new ManagedAgentException(409, code,
                "Another definition preparation changed the original command.", cause);
    }
}
