package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredTransaction;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Function;

/** A rebuildable index of committed native facts, never a second journal. */
@Repository
public class ManagedSessionHistoryStore {
    private static final String DIGEST_PATTERN = "[0-9a-f]{64}";
    static final int BUCKETS = 256;
    private static final int MAX_METADATA_BYTES = 64 * 1024;
    private static final int MAX_PAGE_BYTES = 8 * 1024 * 1024;
    static final Set<String> FAMILIES = Set.of("event", "event-id", "command", "command-id", "receipt", "checkpoint",
            "hook-activation", "domain-event", "extension-event", "extension", "opening-operation",
            "hook-once", "hook-occurrence", "hook-ordinal", "hook-definition", "child-continuation",
            "action", "domain", "event-kind", "event-correlation", "extension-domain");
    private static final List<String> CORRELATIONS = List.of("executionCallId", "turnId", "inputId", "messageId",
            "batchId", "attemptId", "requestId", "cleanupId", "kind", "target.turnId");
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public ManagedSessionHistoryStore(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    public record View(@Min(1) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER)
            @JsonDeserialize(using = Counter.class) long journalRevision,
            @Min(0) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER)
            @JsonDeserialize(using = Counter.class) long committedSequence,
            @Pattern(regexp = DIGEST_PATTERN) String lastCommitDigest) { }

    public record QueryRequest(@NotBlank @Size(max = 512) String workspaceId,
            @NotNull @Valid View view, @NotBlank String family, @NotNull @Size(max = 8192) String identity,
            @Min(0) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER)
            @JsonDeserialize(using = Counter.class) Long throughSequence,
            @Pattern(regexp = "first|latest") String mode,
            @Min(0) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER)
            @JsonDeserialize(using = Counter.class) Long afterSequence,
            @Min(1) @Max(256) @JsonDeserialize(using = PageSize.class) Integer limit) { }

    public record BackfillRequest(@NotBlank @Size(max = 512) String workspaceId,
            @NotNull @Valid View view, @Min(1) @Max(100)
            @JsonDeserialize(using = PageSize.class) Integer limit,
            Boolean repair, @Min(1) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER)
            @JsonDeserialize(using = Counter.class) Long expectedGeneration) { }

    public static final class Counter extends JsonDeserializer<Long> {
        @Override
        public Long deserialize(JsonParser parser, DeserializationContext context) throws IOException {
            if (!parser.hasToken(JsonToken.VALUE_NUMBER_INT)
                    || !parser.getNumberType().equals(JsonParser.NumberType.INT)
                        && !parser.getNumberType().equals(JsonParser.NumberType.LONG)) {
                throw JsonMappingException.from(parser, "History counters must use JSON integer tokens");
            }
            long value = parser.getLongValue();
            if (value < 0 || value > ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
                throw JsonMappingException.from(parser, "History counter is outside its safe bound");
            }
            return value;
        }
    }

    public static final class PageSize extends JsonDeserializer<Integer> {
        @Override
        public Integer deserialize(JsonParser parser, DeserializationContext context) throws IOException {
            Long value = new Counter().deserialize(parser, context);
            if (value < 1 || value > 256) {
                throw JsonMappingException.from(parser, "History page size is outside its bound");
            }
            return value.intValue();
        }
    }

    public record Fact(String family, String identity, long journalRevision, long sequence,
            int eventOrdinal, String recordDigest, JsonNode metadata) { }

    public record QueryResult(View view, long throughSequence, List<Fact> facts,
            long nextSequence, boolean hasMore, long generation) { }

    public record Coverage(View view, long indexedRevision, long indexedSequence,
            String lastCommitDigest, boolean complete, long generation) { }

    private record State(String workspaceId, long generation, long revision, long sequence, String digest, long[] counts) { }

    Coverage coverage(String tenant, String workspace, String session, View view) {
        State state = state(tenant, workspace, session, false);
        return new Coverage(view, state.revision(), state.sequence(), state.digest(), state.revision() >= view.journalRevision(), state.generation());
    }

    QueryResult query(String tenant, String workspace, String session, QueryRequest request,
            Function<Long, StoredTransaction> transactions, Function<String, StoredResource> resources) {
        validateView(request.view());
        require(FAMILIES.contains(request.family()) && request.identity() != null
                && ManagedSchemaKeys.identity(request.identity()).length <= 8192, "managed_session_history_invalid");
        long through = request.throughSequence() == null ? request.view().committedSequence() : request.throughSequence();
        int limit = request.limit() == null ? 100 : request.limit();
        boolean first = "first".equals(request.mode());
        require(through >= 0 && through <= request.view().committedSequence()
                && limit >= 1 && limit <= 256 && (request.mode() == null || first || "latest".equals(request.mode()))
                && (request.afterSequence() == null || request.afterSequence() >= 0
                        && request.afterSequence() <= through), "managed_session_history_invalid");
        State state = state(tenant, workspace, session, false);
        require(state.revision() >= request.view().journalRevision(), "managed_session_history_not_ready");
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String hash = key(request.family(), request.identity());
        requireBucket(scope, state, bucket(hash));
        String cursor = request.afterSequence() == null ? "" : first ? " AND source_sequence > ?" : " AND source_sequence < ?";
        var arguments = new ArrayList<Object>(List.of(scope, state.generation(), request.family(), hash, request.view().journalRevision(), through));
        if (request.afterSequence() != null) {
            arguments.add(request.afterSequence());
        }
        arguments.add(limit + 1);
        List<Fact> candidates = jdbc.query("SELECT family, identity_value, source_revision, source_sequence,"
                        + " event_ordinal, record_digest, metadata_json FROM ma_session_history_fact"
                        + " WHERE session_scope_key = ? AND index_generation = ? AND family = ? AND identity_hash = ?"
                        + " AND source_revision <= ? AND source_sequence <= ?" + cursor
                        + " ORDER BY source_sequence " + (first ? "ASC" : "DESC") + " LIMIT ?",
                (row, index) -> new Fact(row.getString("family"), row.getString("identity_value"),
                        row.getLong("source_revision"), row.getLong("source_sequence"), row.getInt("event_ordinal"),
                        row.getString("record_digest"), parse(row.getString("metadata_json"))), arguments.toArray());
        var selected = new ArrayList<Fact>();
        int bytes = 0;
        for (Fact fact : candidates) {
            require(fact.identity().equals(request.identity()), "managed_session_history_corrupt");
            require(fact.metadata() != null && fact.metadata().isObject(), "managed_session_history_corrupt");
            int size = encode(fact.metadata()).getBytes(StandardCharsets.UTF_8).length;
            require(size <= MAX_METADATA_BYTES, "managed_session_history_corrupt");
            if (selected.size() == limit) {
                break;
            }
            verifySource(scope, session, state, fact, transactions.apply(fact.journalRevision()), transactions, resources);
            Fact materialized = withRevision(scope, session, state, fact, transactions, resources);
            size = encode(materialized.metadata()).getBytes(StandardCharsets.UTF_8).length;
            require(size <= MAX_METADATA_BYTES, "managed_session_history_corrupt");
            if (bytes + size > MAX_PAGE_BYTES) {
                break;
            }
            selected.add(materialized);
            bytes += size;
        }
        long next = selected.isEmpty() ? request.afterSequence() == null ? 0 : request.afterSequence()
                : selected.getLast().sequence();
        require(state(tenant, workspace, session, false).generation() == state.generation(), "managed_session_history_not_ready");
        return new QueryResult(request.view(), through, List.copyOf(selected), next, candidates.size() > selected.size(), state.generation());
    }

    private void verifySource(String scope, String session, State state, Fact fact, StoredTransaction transaction,
            Function<Long, StoredTransaction> transactions, Function<String, StoredResource> resources) {
        List<JsonNode> records = records(transaction, scope, state.workspaceId(), session,
                transaction.journalRevision() > 1 ? transactions.apply(transaction.journalRevision() - 1) : null);
        require(transaction.journalRevision() == fact.journalRevision() && transaction.recordDigest().equals(fact.recordDigest())
                && fact.eventOrdinal() >= 0 && fact.eventOrdinal() < transaction.eventCount()
                && fact.sequence() == transaction.firstSequence() + fact.eventOrdinal(), "managed_session_history_corrupt");
        require(extract(session, transaction, records, resources, (recordKey, sequence) -> true).stream()
                .anyMatch(source -> source.family().equals(fact.family()) && source.identity().equals(fact.identity())
                        && source.sequence() == fact.sequence() && source.eventOrdinal() == fact.eventOrdinal()
                        && encode(source.metadata()).equals(encode(fact.metadata()))), "managed_session_history_corrupt");
    }

    /** Called in the canonical transaction, including server-authored commits. */
    void append(String tenant, String workspace, String session, StoredTransaction transaction,
            List<JsonNode> records, Function<String, StoredResource> resources) {
        State state = state(tenant, workspace, session, true);
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        boolean contiguous = transaction.journalRevision() == state.revision() + 1;
        if (transaction.journalRevision() <= state.revision()) {
            return;
        }
        if (contiguous) {
            require(transaction.firstSequence() == (state.revision() == 0 ? 0 : state.sequence() + 1)
                    && Objects.equals(transaction.previousCommitDigest(), state.digest()), "managed_session_journal_corrupt");
        }
        jdbc.update("DELETE FROM ma_session_history_fact WHERE session_scope_key = ? AND index_generation = ? AND source_revision = ?",
                scope, state.generation(), transaction.journalRevision());
        List<Fact> facts = extract(session, transaction, records, resources,
                (recordKey, sequence) -> contiguous && firstExtension(scope, recordKey, sequence, state));
        var keys = new HashSet<String>();
        for (Fact fact : facts) {
            String identityHash = key(fact.family(), fact.identity());
            require(keys.add(identityHash + ":" + fact.sequence()), "managed_session_journal_corrupt");
            String metadata = encode(fact.metadata());
            require(metadata.getBytes(StandardCharsets.UTF_8).length <= MAX_METADATA_BYTES, "managed_session_history_invalid");
            jdbc.update("INSERT INTO ma_session_history_fact (session_scope_key, index_generation, family, identity_hash,"
                            + " identity_bucket, identity_value, source_revision, source_sequence, event_ordinal,"
                            + " record_digest, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    scope, state.generation(), fact.family(), identityHash, bucket(identityHash), fact.identity(), fact.journalRevision(),
                    fact.sequence(), fact.eventOrdinal(), fact.recordDigest(), metadata);
            if (contiguous) {
                state.counts()[bucket(identityHash)]++;
            }
        }
        if (contiguous) {
            jdbc.update("UPDATE ma_session_history_state SET indexed_revision = ?, indexed_sequence = ?,"
                            + " last_commit_digest = ?, bucket_counts_json = ? WHERE session_scope_key = ?",
                    transaction.journalRevision(), transaction.lastSequence(), transaction.commitDigest(), encode(state.counts()), scope);
        }
    }

    long prepareBackfill(String tenant, String workspace, String session, BackfillRequest request) {
        View view = request.view();
        boolean repair = Boolean.TRUE.equals(request.repair());
        require(!repair || request.expectedGeneration() != null && request.expectedGeneration() > 0
                && request.expectedGeneration() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER, "managed_session_history_invalid");
        State state;
        try {
            state = state(tenant, workspace, session, true);
        } catch (ManagedAgentException error) {
            if (!"managed_session_history_corrupt".equals(error.getCode())) {
                throw error;
            }
            reset(tenant, workspace, session);
            state = state(tenant, workspace, session, true);
        }
        if (repair) {
            require(request.expectedGeneration() <= state.generation(), "managed_session_history_view_conflict");
            if (request.expectedGeneration() == state.generation()) {
                reset(tenant, workspace, session);
                state = state(tenant, workspace, session, true);
            }
        }
        pruneOldGenerations(tenant, session, state.generation());
        if (state.revision() >= view.journalRevision()) {
            String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
            long[] actual = new long[BUCKETS];
            jdbc.query("SELECT identity_bucket, COUNT(*) AS total FROM ma_session_history_fact"
                            + " WHERE session_scope_key = ? AND index_generation = ? AND source_revision <= ? GROUP BY identity_bucket",
                    row -> {
                        actual[row.getInt("identity_bucket")] = row.getLong("total");
                    }, scope, state.generation(), state.revision());
            if (!Arrays.equals(actual, state.counts())) {
                reset(tenant, workspace, session);
                return 0;
            }
        }
        return state.revision();
    }

    void reset(String tenant, String workspace, String session) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        var rows = jdbc.queryForList("SELECT index_generation FROM ma_session_history_state WHERE session_scope_key = ? FOR UPDATE",
                Long.class, scope);
        if (rows.isEmpty()) {
            state(tenant, workspace, session, true);
            return;
        }
        long generation = rows.getFirst();
        require(generation > 0 && generation < ManagedSessionStoreModels.MAX_SAFE_COUNTER, "managed_session_history_corrupt");
        jdbc.update("UPDATE ma_session_history_state SET tenant_id = ?, workspace_id = ?, session_id = ?,"
                        + " index_generation = ?, indexed_revision = 0, indexed_sequence = 0, last_commit_digest = NULL,"
                        + " bucket_counts_json = ? WHERE session_scope_key = ?",
                tenant, workspace, session, generation + 1, encode(new long[BUCKETS]), scope);
    }

    private void pruneOldGenerations(String tenant, String session, long generation) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        var rows = jdbc.queryForList("SELECT index_generation, family, identity_hash, source_sequence FROM ma_session_history_fact"
                        + " WHERE session_scope_key = ? AND index_generation < ? LIMIT 256", scope, generation);
        for (var row : rows) {
            jdbc.update("DELETE FROM ma_session_history_fact WHERE session_scope_key = ? AND index_generation = ?"
                            + " AND family = ? AND identity_hash = ? AND source_sequence = ?",
                    scope, row.get("index_generation"), row.get("family"), row.get("identity_hash"), row.get("source_sequence"));
        }
    }

    static List<JsonNode> records(StoredTransaction transaction, String scope, String workspace, String session) {
        require("identity".equals(transaction.recordEncoding()) && transaction.eventCount() >= 0
                && transaction.eventCount() <= ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS,
                "managed_session_journal_corrupt");
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(transaction.recordBytesBase64());
        } catch (IllegalArgumentException error) {
            throw failure("managed_session_journal_corrupt");
        }
        require(bytes.length == transaction.byteLength() && bytes.length <= MAX_PAGE_BYTES
                && DigestUtils.sha256Hex(bytes).equals(transaction.recordDigest()), "managed_session_journal_corrupt");
        String text = new String(bytes, StandardCharsets.UTF_8);
        require(Arrays.equals(bytes, text.getBytes(StandardCharsets.UTF_8)) && text.endsWith("\n"), "managed_session_journal_corrupt");
        var result = new ArrayList<JsonNode>();
        for (String line : text.substring(0, text.length() - 1).split("\n", -1)) {
            JsonNode record = ManagedExtensionRecordStore.parse(line);
            require(record != null, "managed_session_journal_corrupt");
            int maximum = Set.of("managed_session_commit_v1", "managed_session_header_v1")
                    .contains(record.path("subtype").asText()) ? 64 * 1024 : ManagedSessionStoreModels.MAX_EVENT_BYTES;
            require(line.getBytes(StandardCharsets.UTF_8).length <= maximum, "managed_session_journal_corrupt");
            result.add(record);
        }
        require(result.size() == (transaction.eventCount() == 0 ? 2 : transaction.eventCount() + 1),
                "managed_session_journal_corrupt");
        try {
            validateFrame(transaction, result, scope, workspace, session);
        } catch (RuntimeBrokerException invalidFrame) {
            throw failure("managed_session_journal_corrupt");
        }
        return List.copyOf(result);
    }

    static List<JsonNode> records(StoredTransaction transaction, String scope, String workspace, String session,
            StoredTransaction previous) {
        List<JsonNode> records = records(transaction, scope, workspace, session);
        if (transaction.journalRevision() > 1) {
            require(previous != null, "managed_session_journal_corrupt");
            List<JsonNode> prefix = records(previous, scope, workspace, session);
            require(previous.journalRevision() == transaction.journalRevision() - 1
                    && previous.lastSequence() + 1 == transaction.firstSequence()
                    && Objects.equals(previous.commitDigest(), transaction.previousCommitDigest())
                    && prefix.getLast().path("uuid").equals(records.getFirst().path("parentUuid")),
                    "managed_session_journal_corrupt");
        }
        return records;
    }

    private static void validateFrame(StoredTransaction transaction, List<JsonNode> records,
            String scope, String workspace, String session) {
        var uuids = new HashSet<String>();
        for (int index = 0; index < records.size(); index++) {
            JsonNode record = records.get(index);
            require(record.isObject() && session.equals(record.path("sessionId").asText())
                    && "system".equals(record.path("type").asText())
                    && record.path("uuid").isTextual() && !record.path("uuid").asText().isEmpty()
                    && uuids.add(record.path("uuid").asText())
                    && (index == 0 || records.get(index - 1).path("uuid").equals(record.path("parentUuid"))),
                    "managed_session_journal_corrupt");
        }
        if (transaction.eventCount() == 0) {
            JsonNode engine = records.getFirst();
            JsonNode header = records.getLast();
            JsonNode value = header.path("managedSession");
            require(transaction.journalRevision() == 1 && "session.create".equals(transaction.operation())
                    && transaction.firstSequence() == 0 && transaction.lastSequence() == 0
                    && transaction.eventsDigest() == null && transaction.previousCommitDigest() == null
                    && transaction.commitDigest() == null && Objects.equals(transaction.contentDigest(), transaction.recordDigest())
                    && "session_execution_engine".equals(engine.path("subtype").asText())
                    && engine.path("parentUuid").isNull()
                    && CsiNativeActivationProof.number(engine.path("systemPayload").path("version")) == 1
                    && "managed".equals(engine.path("systemPayload").path("engine").asText())
                    && "managed_session_header_v1".equals(header.path("subtype").asText())
                    && CsiNativeActivationProof.number(value.path("formatVersion")) == 1 && "managed".equals(value.path("engine").asText())
                    && Set.of("managed-session/1", "managed-session/2").contains(value.path("minimumReader").asText()),
                    "managed_session_journal_corrupt");
            requireScope(value.path("sessionKey"), scope, workspace, session);
            return;
        }
        require(transaction.journalRevision() > 1 && transaction.firstSequence() > 0
                && transaction.lastSequence() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && transaction.lastSequence() == transaction.firstSequence() + transaction.eventCount() - 1,
                "managed_session_journal_corrupt");
        var events = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode();
        for (int index = 0; index < transaction.eventCount(); index++) {
            JsonNode record = records.get(index);
            JsonNode event = record.path("managedSession");
            require("managed_session_event_v1".equals(record.path("subtype").asText())
                    && CsiNativeActivationProof.number(event.path("v")) == 1
                    && CsiNativeActivationProof.number(event.path("sequence")) == transaction.firstSequence() + index,
                    "managed_session_journal_corrupt");
            requireScope(event.path("sessionKey"), scope, workspace, session);
            events.add(event);
        }
        JsonNode markerRecord = records.getLast();
        JsonNode marker = markerRecord.path("managedSession");
        require("managed_session_commit_v1".equals(markerRecord.path("subtype").asText()) && marker.isObject()
                && marker.size() == 9 && transaction.transactionId().equals(marker.path("transactionId").asText())
                && transaction.commandId().equals(marker.path("commandId").asText())
                && transaction.operation().equals(marker.path("operation").asText())
                && transaction.contentDigest().equals(marker.path("contentDigest").asText())
                && transaction.firstSequence() == CsiNativeActivationProof.number(marker.path("firstSequence"))
                && transaction.lastSequence() == CsiNativeActivationProof.number(marker.path("lastSequence"))
                && transaction.eventCount() == CsiNativeActivationProof.number(marker.path("eventCount"))
                && Objects.equals(transaction.previousCommitDigest(), marker.path("previousCommitDigest").isNull()
                        ? null : marker.path("previousCommitDigest").asText())
                && Objects.equals(transaction.eventsDigest(), marker.path("eventsDigest").asText())
                && DigestUtils.sha256Hex(CsiNativeActivationProof.utf8(CsiNativeActivationProof.canonical(events)))
                        .equals(transaction.eventsDigest())
                && DigestUtils.sha256Hex(CsiNativeActivationProof.utf8(CsiNativeActivationProof.canonical(marker)))
                        .equals(transaction.commitDigest()), "managed_session_journal_corrupt");
    }

    private static void requireScope(JsonNode key, String scope, String workspace, String session) {
        require(key.isObject() && key.size() == 3 && key.path("tenantId").isTextual()
                && workspace.equals(key.path("workspaceId").asText()) && session.equals(key.path("sessionId").asText()),
                "managed_session_journal_corrupt");
        try {
            require(scope.equals(ManagedSessionStore.sessionScopeKey(key.path("tenantId").asText(), session)),
                    "managed_session_journal_corrupt");
        } catch (IllegalArgumentException invalidIdentity) {
            throw failure("managed_session_journal_corrupt");
        }
    }

    static List<Fact> extract(String session, StoredTransaction transaction,
            List<JsonNode> records, Function<String, StoredResource> resources, BiPredicate<String, Long> firstExtension) {
        var result = new ArrayList<Fact>();
        if (transaction.eventCount() == 0) {
            require(transaction.journalRevision() == 1 && transaction.firstSequence() == 0
                    && transaction.lastSequence() == 0 && "session.create".equals(transaction.operation())
                    && transaction.commitDigest() == null, "managed_session_journal_corrupt");
            return result;
        }
        ObjectNode command = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("transactionId", transaction.transactionId())
                .put("operation", transaction.operation()).put("commandId", transaction.commandId())
                .put("contentDigest", transaction.contentDigest()).put("firstSequence", transaction.firstSequence())
                .put("lastSequence", transaction.lastSequence());
        result.add(fact("command", transaction.operation() + "\u0000" + transaction.commandId(), transaction,
                transaction.firstSequence(), 0, command));
        if (records.stream().limit(transaction.eventCount()).map(record -> record.path("managedSession"))
                .anyMatch(event -> "operation.replayed".equals(event.path("kind").asText())
                        || "domain.committed".equals(event.path("kind").asText())
                            && ManagedExtensionProjection.RECORD_BODIES.containsKey(event.path("payload").path("domain").asText()))) {
            result.add(fact("command-id", transaction.commandId(), transaction, transaction.firstSequence(), 0, command));
        }
        for (int ordinal = 0; ordinal < transaction.eventCount(); ordinal++) {
            JsonNode event = records.get(ordinal).path("managedSession");
            long sequence = transaction.firstSequence() + ordinal;
            require("managed_session_event_v1".equals(records.get(ordinal).path("subtype").asText())
                    && event.path("sequence").asLong(-1) == sequence, "managed_session_journal_corrupt");
            JsonNode payload = event.path("payload");
            String kind = event.path("kind").asText();
            ObjectNode metadata = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("kind", kind);
            result.add(fact("event", Long.toString(sequence), transaction, sequence, ordinal, metadata));
            result.add(fact("event-id", event.path("eventId").asText(), transaction, sequence, ordinal, metadata));
            result.add(fact("event-kind", kind, transaction, sequence, ordinal, metadata));
            for (String correlation : CORRELATIONS) {
                JsonNode value = correlation.equals("kind") ? event.path("kind")
                        : correlation.equals("target.turnId") ? payload.path("target").path("turnId") : payload.path(correlation);
                if (value.isValueNode() && !value.isNull()) {
                    String scalar = value.isNumber() ? CsiNativeActivationProof.canonical(value) : value.asText();
                    result.add(fact("event-correlation", correlationKey(kind, correlation, scalar), transaction, sequence, ordinal, metadata));
                }
            }
            String family = switch (kind) {
                case "tool.receipt" -> "receipt";
                case "checkpoint.committed" -> "checkpoint";
                case "action.changed" -> "action";
                default -> null;
            };
            String field = switch (kind) {
                case "tool.receipt" -> "executionCallId";
                case "checkpoint.committed" -> "checkpointId";
                case "action.changed" -> "requestId";
                default -> null;
            };
            if (family != null) {
                result.add(fact(family, payload.path(field).asText(), transaction, sequence, ordinal, metadata));
            }
            if ("activation.changed".equals(kind) && "hook_operation".equals(payload.path("subject").path("type").asText())) {
                result.add(fact("hook-activation", payload.path("activationId").asText(), transaction, sequence, ordinal, metadata));
            }
            if (!"domain.committed".equals(kind)) {
                continue;
            }
            String domain = payload.path("domain").asText();
            ObjectNode committed = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("domain", domain);
            committed.set("recordRef", payload.path("recordRef"));
            result.add(fact("domain", domain, transaction, sequence, ordinal, committed));
            result.add(fact("domain-event", Long.toString(sequence), transaction, sequence, ordinal, committed));
            var bodyParser = ManagedExtensionProjection.RECORD_BODIES.get(domain);
            if (bodyParser == null) {
                continue;
            }
            StoredResource resource = resources.apply(payload.path("recordRef").path("resourceId").asText());
            JsonNode ref = payload.path("recordRef");
            require(resource != null && resource.bytes() != null && resource.bytes().length == resource.byteLength()
                    && DigestUtils.sha256Hex(resource.bytes()).equals(resource.digest())
                    && resource.resourceId().equals(ref.path("resourceId").asText())
                    && resource.kind().equals(ref.path("kind").asText())
                    && resource.schemaVersion() == ref.path("schemaVersion").asInt(-1)
                    && resource.byteLength() == ref.path("byteLength").asLong(-1)
                    && resource.digest().equals(ref.path("digest").asText()), "managed_session_journal_corrupt");
            JsonNode body = ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
            require(body != null, "managed_session_journal_corrupt");
            try {
                bodyParser.require().accept(body);
            } catch (ManagedExtensionRecords.InvalidRecordException error) {
                throw failure("managed_session_journal_corrupt");
            }
            String recordId = bodyParser.recordId().apply(body);
            String recordKey = ManagedExtensionProjection.recordKey(session, domain, recordId);
            ObjectNode extension = committed.deepCopy().put("recordId", recordId).put("recordKey", recordKey)
                    .put("operationId", payload.path("operationId").asText());
            if (bodyParser.taskKindOf().apply(body) != null) {
                extension.put("taskId", ManagedExtensionProjection.taskId(recordKey));
            }
            boolean first = firstExtension.test(recordKey, sequence);
            result.add(fact("extension", recordKey, transaction, sequence, ordinal, extension));
            result.add(fact("extension-event", Long.toString(sequence), transaction, sequence, ordinal, extension));
            if (!first) {
                continue;
            }
            result.add(fact("opening-operation", payload.path("operationId").asText(), transaction, sequence, ordinal, extension));
            result.add(fact("extension-domain", domain, transaction, sequence, ordinal, extension));
            if (domain.equals("hook_execution")) {
                if (!body.path("onceKey").isNull()) {
                    result.add(fact("hook-once", body.path("onceKey").asText(), transaction, sequence, ordinal, extension));
                }
                ObjectNode occurrence = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("registrationId", body.path("registrationId").asText())
                        .put("eventName", body.path("eventName").asText());
                occurrence.set("planRef", body.path("planRef"));
                result.add(fact("hook-occurrence", body.path("occurrenceId").asText(), transaction, sequence, ordinal, occurrence));
                result.add(fact("hook-ordinal", body.path("occurrenceId").asText() + "\u0000" + body.path("ordinal").asLong(), transaction, sequence, ordinal, extension));
            }
            if (domain.equals("hook_registration")) {
                JsonNode pin = body.path("run").path("definition");
                result.add(fact("hook-definition", pin.path("definitionId").asText() + "\u0000" + pin.path("definitionRevision").asLong(),
                        transaction, sequence, ordinal, com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("definitionDigest", pin.path("definitionDigest").asText())));
            }
            if (domain.equals("child_run") && body.path("predecessorChildRunId").isTextual()) {
                result.add(fact("child-continuation", body.path("predecessorChildRunId").asText(), transaction, sequence, ordinal,
                        com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("childRunId", body.path("childRunId").asText())));
            }
        }
        return result;
    }

    private boolean firstExtension(String scope, String recordKey, long sequence, State basis) {
        requireBucket(scope, basis, bucket(key("extension", recordKey)));
        return jdbc.query("SELECT source_sequence FROM ma_session_history_fact WHERE session_scope_key = ?"
                        + " AND index_generation = ? AND family = 'extension' AND identity_hash = ?"
                        + " AND source_revision <= ? AND source_sequence < ? LIMIT 1",
                (row, index) -> row.getLong(1), scope, basis.generation(), key("extension", recordKey), basis.revision(), sequence).isEmpty();
    }

    private Fact withRevision(String scope, String session, State state, Fact fact,
            Function<Long, StoredTransaction> transactions, Function<String, StoredResource> resources) {
        if (!Set.of("domain", "domain-event", "extension", "extension-event").contains(fact.family())) {
            return fact;
        }
        boolean extension = fact.family().startsWith("extension");
        String family = extension ? "extension" : "domain";
        String identity = fact.metadata().path(extension ? "recordKey" : "domain").asText();
        String hash = key(family, identity);
        requireBucket(scope, state, bucket(hash));
        Long revision = jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_fact WHERE session_scope_key = ?"
                        + " AND index_generation = ? AND family = ? AND identity_hash = ?"
                        + " AND source_revision <= ? AND source_sequence <= ?", Long.class,
                scope, state.generation(), family, hash, fact.journalRevision(), fact.sequence());
        if (revision == null || revision <= 0) {
            throw failure("managed_session_history_corrupt");
        }
        ObjectNode metadata = ((ObjectNode) fact.metadata()).deepCopy().put("revision", revision.longValue());
        if (extension) {
            List<Fact> first = jdbc.query("SELECT family, identity_value, source_revision, source_sequence,"
                            + " event_ordinal, record_digest, metadata_json FROM ma_session_history_fact WHERE session_scope_key = ?"
                            + " AND index_generation = ? AND family = 'extension' AND identity_hash = ?"
                            + " AND source_revision <= ? ORDER BY source_sequence LIMIT 1",
                    (row, index) -> new Fact(row.getString("family"), row.getString("identity_value"),
                            row.getLong("source_revision"), row.getLong("source_sequence"), row.getInt("event_ordinal"),
                            row.getString("record_digest"), parse(row.getString("metadata_json"))), scope, state.generation(), hash, fact.journalRevision());
            require(!first.isEmpty(), "managed_session_history_corrupt");
            verifySource(scope, session, state, first.getFirst(), transactions.apply(first.getFirst().journalRevision()), transactions, resources);
            metadata.put("operationId", first.getFirst().metadata().path("operationId").asText());
        }
        return new Fact(fact.family(), fact.identity(), fact.journalRevision(), fact.sequence(), fact.eventOrdinal(), fact.recordDigest(), metadata);
    }

    private State state(String tenant, String workspace, String session, boolean lock) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        var rows = jdbc.query(
                "SELECT tenant_id, workspace_id, session_id, index_generation, indexed_revision, indexed_sequence,"
                        + " last_commit_digest, bucket_counts_json FROM ma_session_history_state WHERE session_scope_key = ?"
                        + (lock ? " FOR UPDATE" : ""),
                (row, index) -> {
                    require(tenant.equals(row.getString("tenant_id")) && session.equals(row.getString("session_id")), "managed_session_history_corrupt");
                    long generation = row.getLong("index_generation");
                    require(generation > 0 && generation <= ManagedSessionStoreModels.MAX_SAFE_COUNTER, "managed_session_history_corrupt");
                    return new State(row.getString("workspace_id"), generation, row.getLong("indexed_revision"),
                            row.getLong("indexed_sequence"), row.getString("last_commit_digest"), counts(row.getString("bucket_counts_json")));
                }, scope);
        if (rows.isEmpty()) {
            Long previous = jdbc.queryForObject("SELECT MAX(index_generation) FROM ma_session_history_fact WHERE session_scope_key = ?",
                    Long.class, scope);
            long generation = previous == null ? 1 : previous + 1;
            require(generation > 0 && generation <= ManagedSessionStoreModels.MAX_SAFE_COUNTER, "managed_session_history_corrupt");
            if (!lock) {
                return new State(workspace, generation, 0, 0, null, new long[BUCKETS]);
            }
            jdbc.update("INSERT INTO ma_session_history_state (session_scope_key, tenant_id, workspace_id, session_id,"
                            + " index_generation, indexed_revision, indexed_sequence, last_commit_digest, bucket_counts_json) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?)",
                    scope, tenant, workspace, session, generation, encode(new long[BUCKETS]));
            return new State(workspace, generation, 0, 0, null, new long[BUCKETS]);
        }
        State state = rows.getFirst();
        require(workspace.equals(state.workspaceId()), "managed_session_history_corrupt");
        return state;
    }

    private void requireBucket(String scope, State state, int bucket) {
        Long actual = jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_fact WHERE session_scope_key = ?"
                        + " AND index_generation = ? AND identity_bucket = ? AND source_revision <= ?",
                Long.class, scope, state.generation(), bucket, state.revision());
        require(actual != null && actual == state.counts()[bucket], "managed_session_history_corrupt");
    }

    private long[] counts(String value) {
        return counts(parse(value));
    }

    static long[] counts(JsonNode values) {
        if (values == null || !values.isArray() || values.size() != BUCKETS) {
            throw failure("managed_session_history_corrupt");
        }
        long[] counts = new long[BUCKETS];
        for (int index = 0; index < BUCKETS; index++) {
            require(values.get(index).isIntegralNumber() && values.get(index).canConvertToLong()
                    && values.get(index).longValue() >= 0, "managed_session_history_corrupt");
            counts[index] = values.get(index).longValue();
        }
        return counts;
    }

    private static Fact fact(String family, String identity, StoredTransaction transaction, long sequence, int ordinal, JsonNode metadata) {
        return new Fact(family, identity, transaction.journalRevision(), sequence, ordinal, transaction.recordDigest(), metadata);
    }

    private String encode(JsonNode value) {
        return value.toString();
    }

    private String encode(long[] value) {
        return Arrays.toString(value);
    }

    private JsonNode parse(String value) {
        try {
            return json.readTree(value);
        } catch (IOException | IllegalArgumentException error) {
            throw failure("managed_session_history_corrupt");
        }
    }

    static void validateView(View view) {
        require(view != null && view.journalRevision() > 0 && view.journalRevision() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && view.committedSequence() >= 0 && view.committedSequence() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && (view.lastCommitDigest() == null || view.lastCommitDigest().matches(DIGEST_PATTERN)),
                "managed_session_history_invalid");
    }

    static String key(String family, String identity) {
        return ManagedSchemaKeys.key(family, identity);
    }

    public String correlationIdentity(String kind, String field, String value) {
        return correlationKey(kind, field, value);
    }

    private static String correlationKey(String kind, String field, String value) {
        return CsiNativeActivationProof.canonical(com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode()
                .add(kind).add(field).add(value));
    }

    static int bucket(String hash) {
        return Integer.parseInt(hash.substring(0, 2), 16);
    }

    private static void require(boolean valid, String code) {
        if (!valid) {
            throw failure(code);
        }
    }

    private static ManagedAgentException failure(String code) {
        return new ManagedAgentException(code.endsWith("invalid") ? HttpStatus.BAD_REQUEST : HttpStatus.CONFLICT,
                code, "Managed Session history view is unavailable: " + code);
    }
}
