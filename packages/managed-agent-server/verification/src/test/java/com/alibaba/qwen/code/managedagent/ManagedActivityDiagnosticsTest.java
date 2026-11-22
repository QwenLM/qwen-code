package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedToolMeasurements;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.session.ManagedSessionActivityService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedActivityDiagnosticsTest {
    private static final String TENANT = "activity-tenant";
    private static final String SESSION = "activity-session";
    private final ObjectMapper json = new ObjectMapper();
    private ObservedJdbc jdbc;
    private JdbcManagedSessionStore sessions;
    private JdbcManagedExtensionRecordStore records;
    private TransactionTemplate transactions;
    private ExtensionRecordJournal journal;

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:activity-" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ObservedJdbc(source);
        records = new JdbcManagedExtensionRecordStore(jdbc);
        sessions = VerificationFixtures.managedSessionStore(jdbc, records);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified) VALUES (?, ?, 'qwen-code', 1, 1)", TENANT, SESSION);
        journal = transactions.execute(status -> new ExtensionRecordJournal(sessions, TENANT, "w1", SESSION).open());
    }

    @Test
    void sharedFixturePreservesUtf8IdentityAndRejectsOpaqueFields() throws Exception {
        JsonNode fixture = json.readTree(Files.readString(Path.of("..", "..", "core", "src", "managed-runtime", "contracts", "managed-execution-diagnostics-v1.fixtures.json")));
        assertThat(ManagedActivityDiagnostics.invocationId(fixture.path("sessionKey").path("tenantId").asText(),
                fixture.path("sessionKey").path("sessionId").asText(), fixture.path("messageId").asText(), 0))
                .isEqualTo(fixture.path("invocationId").asText());
        ManagedActivityDiagnostics.requireEvidence(fixture.path("evidence"));
        ObjectNode bad = fixture.path("evidence").deepCopy();
        bad.put("credential", "private");
        assertThatThrownBy(() -> ManagedActivityDiagnostics.requireEvidence(bad)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void committedOccurrencesAndTypedOutcomesRemainDurableAndReplaySafe() {
        commitRequests();
        CommitTransactionRequest results = results();
        commit(results);
        transactions.executeWithoutResult(status -> journal.commit(results));
        JsonNode summary = records.findActivityStatistics(TENANT, SESSION);
        assertThat(summary.path("tools").path("requested").longValue()).isEqualTo(4);
        assertThat(summary.path("tools").path("execution").path("success").longValue()).isEqualTo(2);
        assertThat(summary.path("tools").path("execution").path("error").longValue()).isZero();
        assertThat(summary.path("tools").path("admission").path("denied").longValue()).isEqualTo(1);
        assertThat(summary.path("files").path("execution").path("success").longValue()).isEqualTo(1);
        assertThat(summary.path("fileOperations").path("read").path("execution").path("success").longValue()).isEqualTo(1);
        assertThat(summary.path("fileOperations").path("edit").path("admission").path("denied").longValue()).isEqualTo(1);
        assertThat(summary.path("skills").path("execution").path("success").longValue()).isEqualTo(1);
        var page = records.listActivity(TENANT, SESSION, ManagedActivityDiagnostics.TOOLS, 2, null, null, 2);
        assertThat(page.items()).hasSize(2);
        assertThat(page.hasMore()).isTrue();
        assertThat(records.listActivity(TENANT, SESSION, ManagedActivityDiagnostics.TOOLS, 2, page.lastTime(), page.lastKey(), 2).items()).hasSize(2);
        assertThat(records.findActivityStatistics("other-tenant", SESSION)).isNull();
        assertThat(jdbc.queryForObject("SELECT has_activity_diagnostics FROM ma_session_head WHERE session_id = ?", Boolean.class, SESSION)).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE task_kind IS NOT NULL", Integer.class)).isZero();
        JdbcManagedExtensionRecordStore restarted = new JdbcManagedExtensionRecordStore(jdbc);
        assertThat(restarted.findActivityStatistics(TENANT, SESSION)).isEqualTo(summary);
    }

    @Test
    void measuredExecutionCommitsWithItsProjectionAndReplaysWithoutDoubleCounting() throws Exception {
        commitRequests();
        String execution = "execution-measured";
        ObjectNode observation = fact(1, "edit").put("executionCallId", execution).put("admission", "allowed");
        observation.putObject("file").put("operation", "edit").put("path", "src/file.ts").put("cwdRelative", ".");
        ObjectNode source = evidence("intent:" + execution);
        source.withArray("observations").add(observation);
        CommitResource diagnostics = resource(ManagedActivityDiagnostics.KIND, ExtensionRecordJournal.bytes(source));
        CommitResource args = resource("managed-tool-args", "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var intent = journal.request("recordIntent", execution, args.digest().getBytes(java.nio.charset.StandardCharsets.UTF_8), 1001, event -> {
            event.put("kind", "tool.intent").put("eventId", "intent:" + execution);
            ObjectNode payload = event.putObject("payload").put("executionCallId", execution).put("batchId", "assistant").put("ordinal", 1)
                    .put("outcomeSource", "runtime");
            payload.set("toolDefinitionRef", ManagedExtensionRecordStoreTest.hookRef(args));
            payload.set("argsRef", ManagedExtensionRecordStoreTest.hookRef(args));
            payload.set("diagnosticsRef", ManagedExtensionRecordStoreTest.hookRef(diagnostics));
        }, lines -> lines);
        commit(withResources(intent, ManagedActivityDiagnostics.commitDigest(args.digest(), ManagedExtensionRecordStoreTest.hookRef(diagnostics)), List.of(args, diagnostics)));
        JsonNode fixture = json.readTree(Files.readString(Path.of("..", "..", "core", "src", "managed-runtime", "contracts", "managed-tool-measurements-v1.fixtures.json")));
        ObjectNode body = fixture.path("evidence").deepCopy();
        body.put("executionCallId", execution).set("invocationId", observation.get("invocationId"));
        CommitResource measured = resource(ManagedToolMeasurements.KIND, ExtensionRecordJournal.bytes(body));
        CommitResource outcome = resource("managed-tool-outcome", ExtensionRecordJournal.bytes(json.createObjectNode().put("executionCallId", execution)));
        ObjectNode carrier = json.createObjectNode().put("executionCallId", execution);
        carrier.set("toolOutcomeRef", ManagedExtensionRecordStoreTest.hookRef(outcome));
        carrier.set("measurementsRef", ManagedExtensionRecordStoreTest.hookRef(measured));
        var base = journal.request("recordToolMeasurements", execution, ExtensionRecordJournal.bytes(body), 1002, event -> {
            event.put("kind", "tool.measured").put("eventId", "tool-measured:" + execution).set("payload", carrier);
        }, lines -> lines);
        var request = withResources(base, ManagedToolMeasurements.commitDigest(carrier), List.of(outcome, measured));
        commit(request);
        JsonNode summary = records.findActivityStatistics(TENANT, SESSION).deepCopy();
        transactions.executeWithoutResult(status -> journal.commit(request));
        assertThat(records.findActivityStatistics(TENANT, SESSION)).isEqualTo(summary);
        assertThat(summary.path("tools").path("requested").asInt()).isEqualTo(4);
        assertThat(summary.path("files").path("measurements").path("executionDurationSamples").asText()).isEqualTo("1");
        assertThat(summary.path("files").path("measurements").path("modelLinesAdded").asText()).isEqualTo("3");
        assertThat(summary.path("files").path("measurements").path("appliedLinesAdded").asText()).isEqualTo("2");
        assertThat(jdbc.queryForObject("SELECT has_activity_diagnostics FROM ma_session_head WHERE session_id = ?", Boolean.class, SESSION)).isTrue();
        var api = new ManagedSessionActivityService(mock(ManagedAgentService.class), records);
        assertThat(api.list(TENANT, "reader", SESSION, "tools", null, 100).toString()).doesNotContain("_measurementEvidenceDigest", "_measurementOutcomeKnown", "resultDigest");
        transactions.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'SESSION_RECORD' AND session_id = ?", SESSION);
            jdbc.update("DELETE FROM ma_session_record WHERE session_id = ?", SESSION);
        });
        journal.acquire();
        assertThat(records.findActivityStatistics(TENANT, SESSION)).isEqualTo(summary);
    }

    @Test
    void conflictingSourceRollsBackJournalDetailsAndSummary() {
        commitRequests();
        ObjectNode bad = evidence("message:bad");
        ObjectNode fact = fact(0, "read_file");
        fact.put("invocationId", "f".repeat(64));
        bad.withArray("observations").add(fact);
        var request = message("bad", "tool_result", bad, json.createArrayNode().addObject().putObject("functionResponse").put("id", "call-0"));
        JsonNode before = records.findActivityStatistics(TENANT, SESSION);
        assertThatThrownBy(() -> transactions.executeWithoutResult(status -> journal.commit(request))).isInstanceOf(RuntimeException.class);
        assertThat(records.findActivityStatistics(TENANT, SESSION)).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class)).isEqualTo(2);
    }

    @Test
    void unknownDeliveryCannotOverwriteConfirmedExecutionAndBucketOverflowStaysExact() {
        ObjectNode summary = ManagedActivityDiagnostics.summary(evidence("message:assistant"), 1, 1000);
        ObjectNode last = null;
        for (int index = 0; index < 80; index++) {
            last = fact(index, "tool-" + index).put("execution", "success").put("delivery", "partial");
            ManagedActivityDiagnostics.contribute(summary, null, last);
        }
        assertThat(summary.path("toolBuckets").size()).isEqualTo(64);
        assertThat(summary.path("otherTools").path("requested").longValue()).isEqualTo(16);
        ObjectNode weaker = last.deepCopy().put("execution", "not_started").put("delivery", "unavailable");
        ObjectNode merged = ManagedActivityDiagnostics.merge(last, weaker, false);
        ManagedActivityDiagnostics.contribute(summary, last, merged);
        assertThat(merged.path("execution").asText()).isEqualTo("success");
        assertThat(merged.path("delivery").asText()).isEqualTo("unavailable");
        assertThat(summary.path("tools").path("requested").longValue()).isEqualTo(80);
        assertThat(summary.path("tools").path("execution").path("success").longValue()).isEqualTo(80);
        assertThat(summary.path("otherTools").path("requested").longValue()).isEqualTo(16);
        assertThat(summary.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isLessThan(65_536);
        ObjectNode unknown = merged.deepCopy().put("delivery", "unknown");
        ObjectNode known = ManagedActivityDiagnostics.merge(merged, unknown, false);
        assertThat(known.path("delivery").asText()).isEqualTo("unavailable");
        ObjectNode partial = last.deepCopy().put("delivery", "unknown");
        assertThat(ManagedActivityDiagnostics.merge(last, partial, false).path("delivery").asText()).isEqualTo("partial");
    }

    @Test
    void executorEvidenceCanCorrectAWeakerTerminalObservation() {
        ObjectNode before = fact(0, "read_file").put("execution", "error").put("delivery", "partial");
        ObjectNode executor = before.deepCopy().put("execution", "success");
        assertThat(ManagedActivityDiagnostics.merge(before, executor, false).path("execution").asText()).isEqualTo("error");
        assertThat(ManagedActivityDiagnostics.merge(before, executor, false).path("conflictingEvidence").asBoolean()).isTrue();
        ObjectNode merged = ManagedActivityDiagnostics.merge(before, executor, true);
        assertThat(merged.path("execution").asText()).isEqualTo("success");
        assertThat(merged.path("delivery").asText()).isEqualTo("partial");
    }

    @Test
    void sameNameSkillsAtDifferentPinsAndCommandExpansionHaveSeparateMetrics() {
        ObjectNode summary = ManagedActivityDiagnostics.summary(evidence("message:assistant"), 1, 1000);
        for (int index = 0; index < 3; index++) {
            ObjectNode fact = fact(index, "skill").put("toolKind", "hosted").put("execution", "success");
            fact.putObject("skill").put("resourceKind", index == 2 ? "extension_command" : "skill")
                    .put("name", "review").put("pin", "pin-" + index).put("origin", index == 0 ? "user" : "model")
                    .put("delivery", index == 0 ? "partial" : "complete");
            ManagedActivityDiagnostics.contribute(summary, null, fact);
        }
        assertThat(summary.path("tools").path("requested").longValue()).isEqualTo(3);
        assertThat(summary.path("skillLoads").path("requested").longValue()).isEqualTo(2);
        assertThat(summary.path("extensionCommands").path("requested").longValue()).isEqualTo(1);
        assertThat(summary.path("skillBuckets").size()).isEqualTo(3);
        for (JsonNode bucket : summary.path("skillBuckets")) {
            assertThat(bucket.path("resource").size()).isEqualTo(3);
            assertThat(bucket.path("resource").has("origin")).isFalse();
            assertThat(bucket.path("resource").has("delivery")).isFalse();
        }
    }

    @Test
    void resourceEvidenceRetainsKnownPathsAndPartialSkillDelivery() {
        ObjectNode before = fact(0, "read_file").put("delivery", "partial");
        before.putObject("file").put("operation", "read").put("path", "unknown").put("cwdRelative", ".");
        ManagedActivityDiagnostics.requireFact(before);
        ObjectNode observation = before.deepCopy().put("delivery", "pending");
        ((ObjectNode) observation.path("file")).put("path", "different");
        ObjectNode merged = ManagedActivityDiagnostics.merge(before, observation, false);
        assertThat(merged.path("file").path("path").asText()).isEqualTo("unknown");
        assertThat(merged.path("delivery").asText()).isEqualTo("partial");
        assertThat(merged.path("conflictingEvidence").asBoolean()).isTrue();
        ObjectNode skill = fact(1, "skill").put("toolKind", "hosted");
        skill.putObject("skill").put("resourceKind", "skill").put("name", "unknown").put("pin", "pin")
                .put("origin", "user").put("delivery", "partial");
        ManagedActivityDiagnostics.requireFact(skill);
        ObjectNode weaker = skill.deepCopy();
        ((ObjectNode) weaker.path("skill")).put("delivery", "unknown");
        assertThat(ManagedActivityDiagnostics.merge(skill, weaker, false).path("skill").path("delivery").asText()).isEqualTo("partial");
    }

    @Test
    void passiveQueriesAuthorizeAndBindPaginationToActorAndKind() {
        commitRequests();
        ManagedAgentService authorization = mock(ManagedAgentService.class);
        ManagedSessionActivityService api = new ManagedSessionActivityService(authorization, records);
        JsonNode page = api.list(TENANT, "reader", SESSION, "tools", null, 2);
        String cursor = page.path("nextCursor").asText();
        assertThat(api.list(TENANT, "reader", SESSION, "tools", cursor, 2).path("items").size()).isEqualTo(2);
        assertThatThrownBy(() -> api.list(TENANT, "another", SESSION, "tools", cursor, 2)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> api.list(TENANT, "reader", SESSION, "files", cursor, 2)).isInstanceOf(ManagedAgentException.class);
        when(authorization.requireReadableSession(TENANT, "denied", SESSION)).thenThrow(new ManagedAgentException(404, "not_found", "Not found"));
        assertThatThrownBy(() -> api.statistics(TENANT, "denied", SESSION)).isInstanceOf(ManagedAgentException.class);
        verify(authorization).requireReadableSession(TENANT, "denied", SESSION);
    }

    @Test
    void writerAdmissionRebuildsMissingDerivedStateFromCommittedSource() {
        commitRebuildHistory();
        JsonNode before = records.findActivityStatistics(TENANT, SESSION).deepCopy();
        var domains = List.of(ManagedActivityDiagnostics.TOOLS, ManagedActivityDiagnostics.FILES, ManagedActivityDiagnostics.SKILLS);
        var pages = domains.stream().map(domain -> records.listActivity(TENANT, SESSION, domain, 64, null, null, 100)).toList();
        clearActivity();
        assertThat(records.findActivityStatistics(TENANT, SESSION)).isNull();
        jdbc.queries.clear();
        journal.acquire();
        assertThat(records.findActivityStatistics(TENANT, SESSION)).isEqualTo(before);
        assertThat(domains.stream().map(domain -> records.listActivity(TENANT, SESSION, domain, 64, null, null, 100)).toList()).isEqualTo(pages);
        assertResourceSizeQueries(32, 32, 1);
        assertThat(rebuildBodyReadsPerBatch()).containsExactly(65);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void rebuildPreservesEightMiBTransactionAndBatchBoundaries(boolean fullTransactionBudget) {
        commitRequests();
        commit(results());
        JsonNode before = records.findActivityStatistics(TENANT, SESSION).deepCopy();
        long padding = 8L * 1024 * 1024 - rebuildCost(2) - (fullTransactionBudget ? 0 : rebuildCost(1));
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        addBudgetReference(TENANT, "JOURNAL", scope, 2, "padding-a", padding / 2);
        addBudgetReference(TENANT, "JOURNAL", scope, 2, "padding-b", padding - padding / 2);
        addBudgetReference(TENANT, "MESSAGE", scope, 2, "other-kind", 8L * 1024 * 1024);
        addBudgetReference(TENANT, "JOURNAL", ManagedSchemaKeys.key("other-owner"), 2, "other-owner", 8L * 1024 * 1024);
        addBudgetReference("other-tenant", "JOURNAL", scope, 2, "other-scope", 8L * 1024 * 1024);
        clearActivity();
        jdbc.queries.clear();
        journal.acquire();
        assertThat(records.findActivityStatistics(TENANT, SESSION)).isEqualTo(before);
        if (fullTransactionBudget) {
            assertResourceSizeQueries(3, 2, 1);
            assertThat(rebuildBodyReadsPerBatch()).containsExactly(1, 1, 1);
        } else {
            assertResourceSizeQueries(3, 1);
            assertThat(rebuildBodyReadsPerBatch()).containsExactly(2, 1);
        }
    }

    @Test
    void rebuildRejectsOversizedFirstTransactionWithoutScanningAllCandidatesOrReadingBodies() {
        commitRebuildHistory();
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        long padding = 8L * 1024 * 1024 + 1 - rebuildCost(1);
        addBudgetReference(TENANT, "JOURNAL", scope, 1, "padding-a", padding / 2);
        addBudgetReference(TENANT, "JOURNAL", scope, 1, "padding-b", padding - padding / 2);
        clearActivity();
        jdbc.queries.clear();
        assertThatThrownBy(() -> journal.acquire()).isInstanceOf(ManagedAgentException.class)
                .hasMessageContaining("Diagnostic recovery source exceeds its bounded batch");
        assertThat(records.findActivityStatistics(TENANT, SESSION).path("readiness").asText()).isEqualTo("rebuilding");
        assertResourceSizeQueries(32);
        assertThat(rebuildBodyReadsPerBatch()).containsExactly(0);
    }

    @Test
    void commitIsRefusedWhileTheActivityProjectionRebuildsAndAdmittedOnceReady() {
        commitRequests();
        commit(results());
        transactions.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'SESSION_RECORD' AND session_id = ?", SESSION);
            jdbc.update("DELETE FROM ma_session_record WHERE session_id = ?", SESSION);
        });
        assertThat(jdbc.queryForObject("SELECT has_activity_diagnostics FROM ma_session_head WHERE session_id = ?", Boolean.class, SESSION)).isTrue();
        var next = message("after-wipe", "assistant", evidence("message:after-wipe"), json.createArrayNode());
        assertThatThrownBy(() -> transactions.executeWithoutResult(status -> journal.commit(next)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("managed_activity_rebuilding"));
        journal.acquire();
        assertThat(records.findActivityStatistics(TENANT, SESSION).path("readiness").asText()).isEqualTo("ready");
        commit(next);
    }

    @Test
    void pagingMembershipDoesNotAdmitRowsCreatedAfterTheFirstPage() {
        commitRequests();
        var first = records.listActivity(TENANT, SESSION, ManagedActivityDiagnostics.FILES, 1, null, null, 100);
        assertThat(first.items()).isEmpty();
        commit(results());
        assertThat(records.listActivity(TENANT, SESSION, ManagedActivityDiagnostics.FILES, 1, null, null, 100).items()).isEmpty();
        assertThat(records.listActivity(TENANT, SESSION, ManagedActivityDiagnostics.FILES, 2, null, null, 100).items()).hasSize(2);
    }

    @ParameterizedTest
    @ValueSource(ints = {2, 33})
    void rebuildRejectsMissingMiddleTransactionsInsteadOfPublishingSmallerTotals(int missingRevision) {
        commitRebuildHistory();
        clearActivity();
        jdbc.update("DELETE FROM ma_session_journal_tx WHERE session_id = ? AND journal_revision = ?", SESSION, missingRevision);
        jdbc.queries.clear();
        assertThatThrownBy(() -> journal.acquire()).hasMessageContaining("source chain is incomplete");
        JsonNode statistics = records.findActivityStatistics(TENANT, SESSION);
        assertThat(statistics == null || !"ready".equals(statistics.path("readiness").asText())).isTrue();
        assertResourceSizeQueries(32);
        assertThat(rebuildBodyReadsPerBatch()).containsExactly(missingRevision - 1);
    }

    @Test
    void paginationBoundsCandidateScanningAndAdvancesPastNewMembers() {
        commitRequests();
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        String resource = jdbc.queryForObject("SELECT record_resource_id FROM ma_session_record WHERE session_id = ? AND domain = ? LIMIT 1",
                String.class, SESSION, ManagedActivityDiagnostics.TOOLS);
        for (int index = 0; index < 512; index++) {
            String id = "new-" + index;
            String key = com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection.recordKey(SESSION, ManagedActivityDiagnostics.TOOLS, id);
            jdbc.update("INSERT INTO ma_session_record (record_key, tenant_id, workspace_id, session_id, domain, record_id, revision, record_resource_id, gmt_create, first_sequence) VALUES (?, ?, 'w1', ?, ?, ?, 2, ?, ?, 2)", key, TENANT, SESSION, ManagedActivityDiagnostics.TOOLS, id, resource, 100000 + index);
        }
        var first = records.listActivity(TENANT, SESSION, ManagedActivityDiagnostics.TOOLS, 1, null, null, 50);
        assertThat(first.items()).isEmpty();
        assertThat(first.partial()).isTrue();
        assertThat(first.hasMore()).isTrue();
        var next = records.listActivity(TENANT, SESSION, ManagedActivityDiagnostics.TOOLS, 1, first.lastTime(), first.lastKey(), 50);
        assertThat(next.items()).hasSize(4);
        assertThat(next.hasMore()).isFalse();
    }

    private void commitRebuildHistory() {
        commitRequests();
        commit(results());
        for (int index = 0; index < 62; index++) {
            String id = "extra-" + index;
            commit(message(id, "assistant", evidence("message:" + id), json.createArrayNode()));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?",
                Integer.class, TENANT, SESSION)).isEqualTo(65);
    }

    private void clearActivity() {
        transactions.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'SESSION_RECORD' AND session_id = ?", SESSION);
            jdbc.update("DELETE FROM ma_session_record WHERE session_id = ?", SESSION);
        });
    }

    private long rebuildCost(long revision) {
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        return jdbc.queryForObject("SELECT byte_length FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                Long.class, TENANT, SESSION, revision)
                + jdbc.queryForObject("SELECT COALESCE(SUM(r.byte_length), 0) FROM ma_resource_ref f JOIN ma_resource r"
                        + " ON r.resource_key = f.resource_key WHERE f.tenant_id = ? AND f.session_id = ? AND f.owner_kind = 'JOURNAL'"
                        + " AND f.owner_key = ? AND f.owner_revision = ?", Long.class, TENANT, SESSION, scope, revision);
    }

    private void addBudgetReference(String tenant, String ownerKind, String ownerKey, long revision, String id, long bytes) {
        String key = ManagedSchemaKeys.key(ManagedSessionStore.sessionScopeKey(tenant, SESSION), id);
        // Size-only external resources are not diagnostic evidence and must never be fetched by the reducer.
        jdbc.update("INSERT INTO ma_resource (resource_key, tenant_id, workspace_id, session_id, resource_id,"
                        + " kind, schema_version, byte_length, sha256, storage_kind, object_key, state, gmt_create)"
                        + " VALUES (?, ?, 'w1', ?, ?, 'managed-tool-outcome', 1, ?, ?, 'OBJECT_STORE', ?, 'REFERENCED', 1)",
                key, tenant, SESSION, id, bytes, ManagedSchemaKeys.key(id), id);
        jdbc.update("INSERT INTO ma_resource_ref (owner_kind, owner_key, owner_revision, resource_key,"
                        + " tenant_id, workspace_id, session_id, resource_id, gmt_create) VALUES (?, ?, ?, ?, ?, 'w1', ?, ?, 1)", ownerKind, ownerKey, revision, key, tenant, SESSION, id);
    }

    private void assertResourceSizeQueries(int... revisionsPerQuery) {
        var queries = jdbc.queries.stream().filter(sql -> sql.contains("SUM(r.byte_length)")).toList();
        assertThat(queries).hasSize(revisionsPerQuery.length);
        for (int index = 0; index < queries.size(); index++) {
            String sql = queries.get(index);
            assertThat(sql).contains("f.tenant_id = ?", "f.session_id = ?", "f.owner_kind = 'JOURNAL'", "f.owner_key = ?",
                    "f.owner_revision IN (", "GROUP BY f.owner_revision").doesNotContain("record_bytes", "inline_bytes");
            assertThat(sql.chars().filter(value -> value == '?').count()).isEqualTo(3L + revisionsPerQuery[index]);
        }
    }

    private List<Integer> rebuildBodyReadsPerBatch() {
        List<Integer> counts = new ArrayList<>();
        for (String sql : jdbc.queries) {
            if (sql.startsWith("SELECT journal_revision, first_sequence")) {
                counts.add(0);
            } else if (sql.startsWith("SELECT record_bytes, record_digest FROM ma_session_journal_tx")) {
                counts.set(counts.size() - 1, counts.getLast() + 1);
            }
        }
        return counts;
    }

    private static final class ObservedJdbc extends ManagedSchemaJdbcTemplate {
        private final List<String> queries = new ArrayList<>();

        private ObservedJdbc(DataSource source) {
            super(source);
        }

        @Override
        public <T> T query(String sql, PreparedStatementSetter setter, ResultSetExtractor<T> extractor) {
            queries.add(sql);
            return super.query(sql, setter, extractor);
        }
    }

    private void commitRequests() {
        var parts = json.createArrayNode();
        int ordinal = 0;
        for (String name : List.of("read_file", "edit", "run_shell_command", "skill")) {
            parts.addObject().putObject("functionCall").put("id", "call-" + ordinal++).put("name", name).putObject("args");
        }
        commit(message("assistant", "assistant", evidence("message:assistant"), parts));
    }

    private CommitTransactionRequest results() {
        ObjectNode evidence = evidence("message:results");
        var parts = json.createArrayNode();
        int ordinal = 0;
        for (String name : List.of("read_file", "edit", "run_shell_command", "skill")) {
            ObjectNode fact = fact(ordinal, name).put("admission", ordinal == 1 ? "denied" : "allowed")
                    .put("execution", ordinal == 1 ? "not_started" : ordinal == 2 ? "cancelled" : "success")
                    .put("delivery", ordinal == 0 || ordinal == 3 ? "partial" : "complete");
            if (ordinal < 2) {
                fact.putObject("file").put("operation", ordinal == 0 ? "read" : "edit").put("path", "docs/说明.md").put("cwdRelative", ".");
            }
            if (ordinal == 3) {
                fact.put("toolKind", "hosted");
                fact.putObject("skill").put("resourceKind", "skill").put("name", "review").put("pin", "a".repeat(64)).put("origin", "user").put("delivery", "partial");
            }
            evidence.withArray("observations").add(fact);
            parts.addObject().putObject("functionResponse").put("id", "call-" + ordinal++).put("name", name).putObject("response");
        }
        return message("results", "tool_result", evidence, parts);
    }

    private ObjectNode fact(int ordinal, String name) {
        ObjectNode call = json.createObjectNode().put("id", "call-" + ordinal).put("name", name);
        ObjectNode fact = ManagedActivityDiagnostics.request(TENANT, SESSION, "assistant", ordinal, call, 1, 1000);
        fact.remove(List.of("requestSequence", "requestedAt"));
        return fact.put("toolKind", "builtin");
    }

    private ObjectNode evidence(String source) {
        ObjectNode value = json.createObjectNode().put("schemaVersion", 1).put("reducerVersion", 1).put("epochId", "epoch-1")
                .put("startEventId", "message:assistant").put("sourceEventId", source).put("omittedObservationCount", 0);
        value.putArray("observations");
        value.putArray("coverageReasons");
        return value;
    }

    private CommitTransactionRequest message(String id, String role, ObjectNode evidence, JsonNode parts) {
        ObjectNode message = json.createObjectNode().put("uuid", id).put("type", role);
        message.putObject("message").set("parts", parts);
        byte[] body = ExtensionRecordJournal.bytes(message);
        CommitResource content = resource("managed-message", body);
        CommitResource diagnostics = resource(ManagedActivityDiagnostics.KIND, ExtensionRecordJournal.bytes(evidence));
        var base = journal.request("commitMessage", id, body, 1000, event -> {
            event.put("kind", "message.committed").put("eventId", "message:" + id);
            ObjectNode payload = event.putObject("payload").put("messageId", id).put("role", role).putNull("parentMessageId");
            payload.set("contentRef", ManagedExtensionRecordStoreTest.hookRef(content));
            payload.set("diagnosticsRef", ManagedExtensionRecordStoreTest.hookRef(diagnostics));
        }, lines -> lines);
        return new CommitTransactionRequest(base.workspaceId(), base.writerId(), base.writerGeneration(), base.expectedJournalRevision(),
                base.expectedCommittedSequence(), base.transactionId(), base.operation(), base.commandId(),
                ManagedActivityDiagnostics.commitDigest(content.digest(), ManagedExtensionRecordStoreTest.hookRef(diagnostics)),
                base.firstSequence(), base.lastSequence(), base.eventCount(), base.eventsDigest(), base.previousCommitDigest(), base.commitDigest(),
                base.activationEpoch(), base.latestCheckpointResourceId(), base.recordCount(), base.recordBytesBase64(), base.recordDigest(), List.of(content, diagnostics));
    }

    private CommitResource resource(String kind, byte[] body) {
        return new CommitResource(kind + ":" + ExtensionRecordJournal.sha256(body), kind, 1, body.length,
                ExtensionRecordJournal.sha256(body), Base64.getEncoder().encodeToString(body));
    }

    private CommitTransactionRequest withResources(CommitTransactionRequest base, String digest, List<CommitResource> resources) {
        return new CommitTransactionRequest(base.workspaceId(), base.writerId(), base.writerGeneration(), base.expectedJournalRevision(),
                base.expectedCommittedSequence(), base.transactionId(), base.operation(), base.commandId(), digest,
                base.firstSequence(), base.lastSequence(), base.eventCount(), base.eventsDigest(), base.previousCommitDigest(), base.commitDigest(),
                base.activationEpoch(), base.latestCheckpointResourceId(), base.recordCount(), base.recordBytesBase64(), base.recordDigest(), resources);
    }

    private void commit(CommitTransactionRequest request) {
        transactions.executeWithoutResult(status -> journal.commit(request));
        journal.committed(request);
    }
}
