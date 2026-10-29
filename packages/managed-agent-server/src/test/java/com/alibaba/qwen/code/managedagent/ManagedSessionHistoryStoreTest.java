package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionHistoryStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionHistoryStore.BackfillRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionHistoryStore.QueryRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionHistoryStore.View;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSessionHistoryStoreTest {
    protected static final String TENANT = "tenant-history";
    protected static final String WORKSPACE = "workspace-history";
    protected static final String SESSION = "session-history";
    protected static final String TOKEN = "extension-writer-token-0123456789";
    private static final ObjectMapper JSON = new ObjectMapper();
    protected FaultJdbc jdbc;
    protected ManagedSessionStore sessions;
    protected TransactionTemplate tx;
    protected ExtensionRecordJournal journal;
    private String lastPhysicalUuid;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:history-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=3000");
        return source;
    }

    @BeforeEach
    void setup() throws IOException {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new FaultJdbc(source);
        sessions = new ManagedSessionStore(jdbc);
        tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        journal = new ExtensionRecordJournal(sessions, TENANT, WORKSPACE, SESSION);
        tx.executeWithoutResult(status -> journal.acquire());
        var definition = new CommitResource("history-definition", "managed-definition", 1, 2,
                ExtensionRecordJournal.sha256("{}"), "e30=");
        var root = new CommitResource("history-root", "managed-root", 1, 2,
                ExtensionRecordJournal.sha256("{}"), "e30=");
        ObjectNode engine = (ObjectNode) JSON.readTree(ExtensionRecordJournal.line(SESSION, "session_execution_engine", JSON.createObjectNode()));
        engine.remove("managedSession");
        engine.putObject("systemPayload").put("version", 1).put("engine", "managed");
        ObjectNode header = JSON.createObjectNode().put("formatVersion", 1).put("minimumReader", "managed-session/1")
                .put("engine", "managed").put("createdBy", "history-test");
        header.putObject("sessionKey").put("tenantId", TENANT).put("workspaceId", WORKSPACE).put("sessionId", SESSION);
        ObjectNode definitionRef = JSON.valueToTree(definition);
        definitionRef.remove("bytesBase64");
        ObjectNode rootRef = JSON.valueToTree(root);
        rootRef.remove("bytesBase64");
        header.set("definitionRef", definitionRef);
        header.set("rootSnapshotRef", rootRef);
        String records = engine + "\n" + ExtensionRecordJournal.line(SESSION, "managed_session_header_v1", header);
        CommitTransactionRequest genesis = canonicalRequest(journal.genesis(records, List.of(definition, root)));
        tx.executeWithoutResult(status -> commitCanonical(genesis));
    }

    @Test
    void genesisHasACompleteEmptyEventView() {
        View view = view();
        assertThat(view.journalRevision()).isEqualTo(1);
        assertThat(query(view, "event-id", "missing", "first", null, 1).facts()).isEmpty();
        assertThat(backfill(view, 1).complete()).isTrue();
    }

    @Test
    void keepsFrozenVersionsOriginalCommandAndOpeningIdentity() throws IOException {
        commitMonitor("first", 0);
        View first = view();
        var landed = query(first, "event-id", "monitor_run:1", "first", null, 1).facts().getFirst();
        assertThat(landed.sequence()).isEqualTo(1);
        var point = query(first, "event", "1", "first", null, 1).facts().getFirst();
        assertThat(point.journalRevision()).isEqualTo(landed.journalRevision());
        assertThat(point.eventOrdinal()).isEqualTo(landed.eventOrdinal());
        assertThat(point.recordDigest()).isEqualTo(landed.recordDigest());
        assertThat(point.metadata()).isEqualTo(landed.metadata());
        var extension = query(first, "extension-event", "1", "first", null, 1).facts().getFirst();
        String recordKey = extension.metadata().path("recordKey").asText();
        assertThat(extension.metadata().path("revision").asLong()).isEqualTo(1);
        commitMonitor("second", 1);
        View latest = view();
        assertThat(query(first, "event", "2", "first", null, 1).facts()).isEmpty();
        assertThat(query(latest, "event", "2", "first", null, 1).facts().getFirst().sequence()).isEqualTo(2);
        assertThat(query(first, "extension", recordKey, "latest", null, 1).facts().getFirst().metadata().path("revision").asLong()).isEqualTo(1);
        var current = query(latest, "extension", recordKey, "latest", null, 1).facts().getFirst();
        assertThat(current.metadata().path("revision").asLong()).isEqualTo(2);
        assertThat(current.metadata().path("operationId").asText()).isEqualTo("first");
        var identities = query(latest, "extension-domain", "monitor_run", "first", null, 100).facts();
        assertThat(identities).hasSize(1);
        assertThat(identities.getFirst().metadata().path("recordKey").asText()).isEqualTo(recordKey);
        assertThat(query(latest, "opening-operation", "second", "first", null, 1).facts()).isEmpty();
        var command = query(latest, "command", ExtensionRecordJournal.OPERATION + "\u0000first", "first", null, 1).facts().getFirst();
        assertThat(command.metadata().path("commandId").asText()).isEqualTo("first");
        assertThat(command.journalRevision()).isEqualTo(first.journalRevision());
        assertThat(command.recordDigest()).isEqualTo(landed.recordDigest());
        assertThat(query(latest, "command-id", "first", "first", null, 1).facts().getFirst().metadata().path("operation").asText())
                .isEqualTo(ExtensionRecordJournal.OPERATION);
    }

    @Test
    void pagesBothDirectionsWithoutReturningFactsPastTheReadPrefix() throws IOException {
        commitMonitor("first", 0);
        View first = view();
        commitMonitor("second", 1);
        View current = view();
        var ascending = query(current, "event-kind", "domain.committed", "first", null, 1);
        assertThat(ascending.hasMore()).isTrue();
        assertThat(ascending.nextSequence()).isEqualTo(1);
        assertThat(query(current, "event-kind", "domain.committed", "first", ascending.nextSequence(), 1).facts().getFirst().sequence()).isEqualTo(2);
        var descending = query(current, "event-kind", "domain.committed", "latest", null, 1);
        assertThat(descending.facts().getFirst().sequence()).isEqualTo(2);
        assertThat(query(current, "event-kind", "domain.committed", "latest", descending.nextSequence(), 1).facts().getFirst().sequence()).isEqualTo(1);
        assertThat(query(first, "event-id", "monitor_run:2", "first", null, 1).facts()).isEmpty();
    }

    @Test
    void sourcePagesStayInsideTheirReadHeadWhenAConcurrentCommitLands() throws IOException {
        commitMonitor("first", 0);
        View first = view();
        jdbc.beforeTransactionPage = () -> {
            var writer = new TransactionTemplate(tx.getTransactionManager());
            writer.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            writer.executeWithoutResult(status -> {
                try {
                    commitMonitor("second", 1);
                } catch (IOException error) {
                    throw new UncheckedIOException(error);
                }
            });
        };
        assertThat(query(first, "event", "1", "first", null, 1).facts().getFirst().sequence()).isEqualTo(1);
        assertThat(jdbc.beforeTransactionPage).isNull();
        assertThat(view().committedSequence()).isEqualTo(2);
        assertThat(query(first, "event", "2", "first", null, 1).facts()).isEmpty();
        assertThat(query(view(), "event", "2", "first", null, 1).facts().getFirst().sequence()).isEqualTo(2);
    }

    @Test
    void indexFailureRollsBackTheCanonicalCommitAndHead() throws IOException {
        View before = view();
        jdbc.failFacts = true;
        assertThatThrownBy(() -> commitMonitor("failed", 0)).isInstanceOf(IllegalStateException.class);
        jdbc.failFacts = false;
        assertThat(view()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_fact", Long.class)).isZero();
        commitMonitor("retry", 0);
        assertThat(view().committedSequence()).isEqualTo(1);
    }

    @Test
    void missingDerivedFactsAreCorruptionAndRebuildRatherThanNegativeAnswers() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        jdbc.update("DELETE FROM ma_session_history_fact WHERE family = 'event-id'");
        assertThatThrownBy(() -> query(view, "event-id", "monitor_run:1", "first", null, 1))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_history_corrupt"));
        assertThat(backfill(view, 1).complete()).isFalse();
        assertThat(backfill(view, 1).complete()).isTrue();
        assertThat(query(view, "event-id", "monitor_run:1", "first", null, 1).facts()).hasSize(1);
    }

    @Test
    void sameCountMetadataCorruptionRequiresExplicitIdempotentRepair() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        long generation = backfill(view, 100).generation();
        jdbc.update("UPDATE ma_session_history_fact SET metadata_json = ? WHERE family = 'event'", "{\"kind\":\"forged\"}");
        assertThatThrownBy(() -> query(view, "event", "1", "first", null, 1))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_history_corrupt"));
        assertThat(backfill(view, 100).generation()).isEqualTo(generation);
        var first = repair(view, 1, generation);
        assertThat(first.generation()).isEqualTo(generation + 1);
        assertThat(first.complete()).isFalse();
        assertThatThrownBy(() -> query(view, "event", "1", "first", null, 1))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_history_not_ready"));
        var retried = repair(view, 1, generation);
        assertThat(retried.generation()).isEqualTo(first.generation());
        assertThat(retried.complete()).isTrue();
        var result = query(view, "event", "1", "first", null, 1);
        assertThat(result.generation()).isEqualTo(first.generation());
        assertThat(result.facts().getFirst().metadata().path("kind").asText()).isEqualTo("domain.committed");
        assertThatThrownBy(() -> repair(view, 1, first.generation() + 1))
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void sourceOrdinalAndDigestMustMatchTheCanonicalTransaction() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        String digest = query(view, "event", "1", "first", null, 1).facts().getFirst().recordDigest();
        jdbc.update("UPDATE ma_session_history_fact SET event_ordinal = 1 WHERE family = 'event'");
        assertThatThrownBy(() -> query(view, "event", "1", "first", null, 1)).isInstanceOf(ManagedAgentException.class);
        jdbc.update("UPDATE ma_session_history_fact SET event_ordinal = 0, record_digest = ? WHERE family = 'event'", "0".repeat(64));
        assertThatThrownBy(() -> query(view, "event", "1", "first", null, 1)).isInstanceOf(ManagedAgentException.class);
        jdbc.update("UPDATE ma_session_history_fact SET record_digest = ? WHERE family = 'event'", digest);
        assertThat(query(view, "event", "1", "first", null, 1).facts()).hasSize(1);
        String key = query(view, "extension-event", "1", "first", null, 1).facts().getFirst().metadata().path("recordKey").asText();
        commitMonitor("second", 1);
        JsonNode metadata = JSON.readTree(jdbc.queryForObject("SELECT metadata_json FROM ma_session_history_fact"
                + " WHERE family = 'extension' AND source_sequence = 1", String.class));
        ((com.fasterxml.jackson.databind.node.ObjectNode) metadata).put("operationId", "forged");
        jdbc.update("UPDATE ma_session_history_fact SET metadata_json = ? WHERE family = 'extension' AND source_sequence = 1", metadata.toString());
        assertThatThrownBy(() -> query(view(), "extension", key, "latest", null, 1)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void repairReclaimsAtMost256OldFactsPerPage() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        long generation = backfill(view, 100).generation();
        for (int index = 0; index < 300; index++) {
            jdbc.update("INSERT INTO ma_session_history_fact (session_scope_key, index_generation, family, identity_hash,"
                            + " identity_bucket, identity_value, source_revision, source_sequence, event_ordinal, record_digest, metadata_json)"
                            + " SELECT session_scope_key, index_generation, 'stale', ?, identity_bucket, identity_value,"
                            + " source_revision, source_sequence, event_ordinal, record_digest, metadata_json FROM ma_session_history_fact"
                            + " WHERE family = 'event' AND index_generation = ?", String.format("%064x", index), generation);
        }
        long before = jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_fact WHERE index_generation = ?", Long.class, generation);
        assertThat(repair(view, 1, generation).generation()).isEqualTo(generation + 1);
        long remaining = jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_fact WHERE index_generation = ?", Long.class, generation);
        assertThat(before - remaining).isEqualTo(256);
        assertThat(remaining).isPositive();
        assertThat(repair(view, 1, generation).complete()).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_fact WHERE index_generation = ?", Long.class, generation)).isZero();
        assertThat(query(view, "event", "1", "first", null, 1).facts()).hasSize(1);
    }

    @Test
    void concurrentRepairsOfOneGenerationAdvanceRatherThanRestart() throws Exception {
        commitMonitor("first", 0);
        View view = view();
        long generation = backfill(view, 100).generation();
        var executor = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            var first = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return repair(view, 1, generation);
            });
            var second = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return repair(view, 1, generation);
            });
            start.countDown();
            assertThat(first.get(15, TimeUnit.SECONDS).generation()).isEqualTo(generation + 1);
            assertThat(second.get(15, TimeUnit.SECONDS).generation()).isEqualTo(generation + 1);
            assertThat(backfill(view, 100).complete()).isTrue();
            assertThat(query(view, "event", "1", "first", null, 1).facts()).hasSize(1);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void canonicalResourceDamageIsNeverRepairedAsDerivedMetadata() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        long generation = backfill(view, 100).generation();
        jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE kind = ?", new byte[] {0}, "managed-monitor_run");
        assertThatThrownBy(() -> query(view, "event", "1", "first", null, 1))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_resource_corrupt"));
        assertThat(repair(view, 1, generation).complete()).isFalse();
        assertThatThrownBy(() -> backfill(view, 1)).isInstanceOf(ManagedAgentException.class);
        assertThat(view()).isEqualTo(view);
    }

    @ParameterizedTest
    @ValueSource(strings = {"event", "count", "chain", "scope", "parent", "uuid"})
    void canonicalTransactionDamageCannotBeCertifiedByRefreshedRawChecksums(String mutation) throws IOException {
        commitMonitor("first", 0);
        View view = view();
        byte[] original = jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE journal_revision = 2", byte[].class);
        var records = new ArrayList<ObjectNode>();
        for (String line : new String(original, StandardCharsets.UTF_8).split("\n")) {
            records.add((ObjectNode) JSON.readTree(line));
        }
        ObjectNode event = (ObjectNode) records.getFirst().path("managedSession");
        ObjectNode marker = (ObjectNode) records.getLast().path("managedSession");
        switch (mutation) {
            case "event" -> event.put("occurredAt", event.path("occurredAt").asLong() + 1);
            case "count" -> marker.put("eventCount", 2);
            case "chain" -> marker.put("previousCommitDigest", "0".repeat(64));
            case "scope" -> ((ObjectNode) event.path("sessionKey")).put("tenantId", "foreign");
            case "parent" -> records.getFirst().put("parentUuid", "foreign");
            case "uuid" -> records.getLast().put("uuid", records.getFirst().path("uuid").asText());
            default -> throw new IllegalArgumentException(mutation);
        }
        StringBuilder text = new StringBuilder();
        for (ObjectNode record : records) {
            text.append(record).append('\n');
        }
        byte[] changed = text.toString().getBytes(StandardCharsets.UTF_8);
        String digest = ExtensionRecordJournal.sha256(changed);
        jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ? WHERE journal_revision = 2",
                changed, changed.length, digest);
        jdbc.update("UPDATE ma_session_history_fact SET record_digest = ? WHERE source_revision = 2", digest);
        assertThatThrownBy(() -> query(view, "event", "1", "first", null, 1))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_journal_corrupt"));
        jdbc.update("DELETE FROM ma_session_history_fact");
        jdbc.update("DELETE FROM ma_session_history_state");
        assertThatThrownBy(() -> backfill(view, 100)).isInstanceOf(ManagedAgentException.class).satisfies(error ->
                assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_journal_corrupt"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_fact", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_history_state", Long.class)).isZero();
        assertThat(view()).isEqualTo(view);
    }

    @Test
    void aGapCannotBeCertifiedByANewerLiveCommit() throws IOException {
        commitMonitor("first", 0);
        View first = view();
        jdbc.update("DELETE FROM ma_session_history_state");
        commitMonitor("second", 1);
        View latest = view();
        assertThatThrownBy(() -> query(latest, "event-id", "missing", "first", null, 1))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_history_not_ready"));
        assertThat(backfill(first, 1).indexedRevision()).isEqualTo(1);
        assertThat(backfill(first, 1).complete()).isTrue();
        assertThat(query(first, "event-id", "monitor_run:2", "first", null, 1).facts()).isEmpty();
        assertThatThrownBy(() -> query(latest, "event-id", "monitor_run:2", "first", null, 1)).isInstanceOf(ManagedAgentException.class);
        assertThat(backfill(latest, 1).complete()).isTrue();
        assertThat(query(latest, "event-id", "monitor_run:2", "first", null, 1).facts()).hasSize(1);
    }

    @Test
    void corruptCanonicalBytesCannotRepairAnIndex() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        jdbc.update("DELETE FROM ma_session_history_state");
        jdbc.update("UPDATE ma_session_journal_tx SET record_digest = ? WHERE journal_revision = 1", "0".repeat(64));
        assertThatThrownBy(() -> backfill(view, 1)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> query(view, "event-id", "monitor_run:1", "first", null, 1)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void backfillAndALiveCommitKeepIndependentFrozenPrefixes() throws Exception {
        commitMonitor("first", 0);
        View frozen = view();
        jdbc.update("DELETE FROM ma_session_history_state");
        assertThat(backfill(frozen, 1).indexedRevision()).isEqualTo(1);
        CountDownLatch start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var rebuilding = executor.submit(() -> {
                assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
                return backfill(frozen, 100);
            });
            var writing = executor.submit(() -> {
                assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
                commitMonitor("second", 1);
                return view();
            });
            start.countDown();
            assertThat(rebuilding.get(15, TimeUnit.SECONDS).complete()).isTrue();
            View current = writing.get(15, TimeUnit.SECONDS);
            assertThat(current.committedSequence()).isEqualTo(2);
            assertThat(backfill(current, 100).complete()).isTrue();
            assertThat(query(frozen, "event-id", "monitor_run:2", "first", null, 1).facts()).isEmpty();
            assertThat(query(current, "event-id", "monitor_run:2", "first", null, 1).facts()).hasSize(1);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void corruptOriginalResourcesCannotBeHiddenByRebuildingDerivedFacts() throws IOException {
        commitMonitor("first", 0);
        View frozen = view();
        jdbc.update("DELETE FROM ma_session_history_state");
        jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE kind = ?", new byte[] {0}, "managed-monitor_run");
        assertThat(backfill(frozen, 1).complete()).isFalse();
        assertThatThrownBy(() -> backfill(frozen, 1)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> query(frozen, "extension-domain", "monitor_run", "first", null, 1))
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void preservesScopeCredentialsAndFrozenHeadProof() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        QueryRequest request = new QueryRequest(WORKSPACE, view, "event-id", "monitor_run:1", null, "first", null, 1);
        assertThatThrownBy(() -> sessions.historyQuery(TENANT, SESSION, "wrong-token", request)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> sessions.historyQuery("foreign", SESSION, TOKEN, request)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> sessions.historyQuery(TENANT, SESSION, TOKEN,
                new QueryRequest("foreign", view, "event-id", "monitor_run:1", null, "first", null, 1))).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> query(new View(view.journalRevision(), view.committedSequence(), "0".repeat(64)),
                "event-id", "monitor_run:1", "first", null, 1)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> query(view, "not-a-family", "id", "first", null, 1)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> query(view, "event-id", "id", "first", null, 257)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void rejectsFractionalWirePositionsAndUsesSharedCorrelationIdentityBytes() throws IOException {
        String request = "{\"workspaceId\":\"workspace\",\"view\":{\"journalRevision\":1,\"committedSequence\":0},"
                + "\"family\":\"event-id\",\"identity\":\"id\",\"limit\":1}";
        assertThatThrownBy(() -> JSON.readValue(request.replace("\"limit\":1", "\"limit\":1.5"), QueryRequest.class))
                .isInstanceOf(IOException.class);
        assertThatThrownBy(() -> JSON.readValue(request.replace("\"journalRevision\":1", "\"journalRevision\":1.0"), QueryRequest.class))
                .isInstanceOf(IOException.class);
        var history = new ManagedSessionHistoryStore(jdbc, JSON);
        try (var stream = getClass().getResourceAsStream("/managed-session-history-keys.json")) {
            for (JsonNode fixture : JSON.readTree(stream)) {
                assertThat(history.correlationIdentity(fixture.path("kind").asText(), fixture.path("field").asText(), fixture.path("value").asText()))
                        .isEqualTo(fixture.path("identity").asText());
            }
        }
    }

    @Test
    void indexesCorrelationsAtTheirOriginalSequence() throws IOException {
        commitMonitor("first", 0);
        View view = view();
        String identity = new ManagedSessionHistoryStore(jdbc, JSON).correlationIdentity("domain.committed", "kind", "domain.committed");
        assertThat(query(view, "event-correlation", identity, "first", null, 1).facts().getFirst().sequence()).isEqualTo(1);
    }

    protected void commitMonitor(String command, int index) throws IOException {
        JsonNode revision = ManagedExtensionProjectionContractTest.fixtures().required("monitorChainCases").get(0).required("revisions").get(index);
        CommitTransactionRequest request = canonicalRequest(journal.request(command, revision.required("monitorRun"), revision.required("occurredAt").longValue()));
        tx.executeWithoutResult(status -> commitCanonical(request));
    }

    private void commitCanonical(CommitTransactionRequest request) {
        journal.commit(request);
        journal.committed(request);
        String[] lines = new String(Base64.getDecoder().decode(request.recordBytesBase64()), StandardCharsets.UTF_8).split("\n");
        try {
            lastPhysicalUuid = JSON.readTree(lines[lines.length - 1]).path("uuid").asText();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private CommitTransactionRequest canonicalRequest(CommitTransactionRequest request) throws IOException {
        var records = new ArrayList<ObjectNode>();
        for (String line : new String(Base64.getDecoder().decode(request.recordBytesBase64()), StandardCharsets.UTF_8).split("\n")) {
            records.add((ObjectNode) JSON.readTree(line));
        }
        String parent = lastPhysicalUuid;
        for (ObjectNode record : records) {
            if (parent == null) {
                record.putNull("parentUuid");
            } else {
                record.put("parentUuid", parent);
            }
            parent = record.path("uuid").asText();
        }
        String transactionId = request.eventCount() == 0 ? "session.create:" + SESSION : request.transactionId();
        String commandId = request.eventCount() == 0 ? transactionId : request.commandId();
        String eventsDigest = null;
        String commitDigest = null;
        if (request.eventCount() > 0) {
            var events = JSON.createArrayNode();
            for (int index = 0; index < request.eventCount(); index++) {
                events.add(records.get(index).path("managedSession"));
            }
            eventsDigest = ExtensionRecordJournal.sha256(CsiNativeActivationProof.canonical(events));
            ObjectNode marker = JSON.createObjectNode().put("transactionId", transactionId).put("commandId", commandId)
                    .put("operation", request.operation()).put("contentDigest", request.contentDigest())
                    .put("firstSequence", request.firstSequence()).put("lastSequence", request.lastSequence())
                    .put("eventCount", request.eventCount()).put("eventsDigest", eventsDigest);
            if (request.previousCommitDigest() == null) {
                marker.putNull("previousCommitDigest");
            } else {
                marker.put("previousCommitDigest", request.previousCommitDigest());
            }
            records.getLast().set("managedSession", marker);
            commitDigest = ExtensionRecordJournal.sha256(CsiNativeActivationProof.canonical(marker));
        }
        StringBuilder text = new StringBuilder();
        for (ObjectNode record : records) {
            text.append(record).append('\n');
        }
        String bytes = text.toString();
        String recordDigest = ExtensionRecordJournal.sha256(bytes);
        return new CommitTransactionRequest(request.workspaceId(), request.writerId(), request.writerGeneration(),
                request.expectedJournalRevision(), request.expectedCommittedSequence(), transactionId, request.operation(), commandId,
                request.eventCount() == 0 ? recordDigest : request.contentDigest(), request.firstSequence(), request.lastSequence(),
                request.eventCount(), eventsDigest, request.previousCommitDigest(), commitDigest, request.activationEpoch(),
                request.latestCheckpointResourceId(), records.size(), Base64.getEncoder().encodeToString(bytes.getBytes(StandardCharsets.UTF_8)),
                recordDigest, request.resources());
    }

    protected View view() {
        var head = sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN);
        return new View(head.journalRevision(), head.committedSequence(), head.lastCommitDigest());
    }

    protected ManagedSessionHistoryStore.QueryResult query(View view, String family, String identity, String mode, Long cursor, int limit) {
        return tx.execute(status -> sessions.historyQuery(TENANT, SESSION, TOKEN,
                new QueryRequest(WORKSPACE, view, family, identity, null, mode, cursor, limit)));
    }

    protected ManagedSessionHistoryStore.Coverage backfill(View view, int limit) {
        return tx.execute(status -> sessions.historyBackfill(TENANT, SESSION, TOKEN, new BackfillRequest(WORKSPACE, view, limit, null, null)));
    }

    protected ManagedSessionHistoryStore.Coverage repair(View view, int limit, long generation) {
        return tx.execute(status -> sessions.historyBackfill(TENANT, SESSION, TOKEN, new BackfillRequest(WORKSPACE, view, limit, true, generation)));
    }

    protected static class FaultJdbc extends ManagedSchemaJdbcTemplate {
        boolean failFacts;
        Runnable beforeTransactionPage;

        FaultJdbc(DataSource source) {
            super(source);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
            if (beforeTransactionPage != null && sql.startsWith("SELECT journal_revision, byte_length FROM ma_session_journal_tx")) {
                Runnable callback = beforeTransactionPage;
                beforeTransactionPage = null;
                callback.run();
            }
            return super.query(sql, mapper, arguments);
        }

        @Override
        public int update(String sql, Object... arguments) {
            int result = super.update(sql, arguments);
            if (failFacts && sql.startsWith("INSERT INTO ma_session_history_fact")) {
                throw new IllegalStateException("Simulated history index failure");
            }
            return result;
        }
    }
}
