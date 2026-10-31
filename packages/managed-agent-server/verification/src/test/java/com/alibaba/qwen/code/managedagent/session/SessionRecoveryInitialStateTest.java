package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionRecoveryInitialStateTest {
    private static final String TENANT = "initial-tenant";
    private static final String WORKSPACE = "initial-workspace";
    private static final String TOKEN = "initial-writer-token-01234567890";
    private final ObjectMapper json = new ObjectMapper();
    private final RequestDigests digests = new RequestDigests();
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final HarnessCoordinator coordinator = mock(HarnessCoordinator.class);
    private JdbcDataSource source;
    private JdbcTemplate jdbc;
    private ManagedAgentStore store;
    private ManagedSessionStore journals;
    private ManagedAgentService sessions;
    private String sessionId;
    private long generation;
    private long revision;
    private long sequence;
    private JsonNode nativeFixture;
    @TempDir
    private Path directory;

    @BeforeEach
    void setup() {
        source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:recovery-initial-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        var registry = mock(ManagedWorkspaceRegistry.class);
        store = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, json, Clock.systemUTC(), events -> {}, registry,
                new ManagedAgentProperties(), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        journals = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedSessionStore(jdbc));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.supportsFencedTitles()).thenReturn(true);
        sessions = new ManagedAgentService(store, digests, coordinator, harness, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        sessionId = sessions.createSession(TENANT, "actor", "create", "qwen-code", null,
                "Untouched", null, List.of()).sessionId();
    }

    @Test
    void aPersistedEmptySessionRenameRemainsSendableAfterHarnessCacheLoss() throws Exception {
        when(harness.createOrLoad(TENANT, sessionId, false, true)).thenAnswer(call -> {
            genesis();
            return new HarnessConnector.Attachment("boot", null, 0L, "epoch");
        });
        doAnswer(call -> {
            rename();
            return null;
        }).when(harness).rename(eq(TENANT), eq(sessionId), eq("Renamed"), anyLong());
        sessions.renameSession(TENANT, "actor", "rename", sessionId, "Renamed");
        assertThat(store.requireSession(TENANT, sessionId).title()).isEqualTo("Renamed");
        assertThat(store.findLatestTurns(TENANT, List.of(sessionId))).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class)).isEqualTo(3);
        clearInvocations(harness, coordinator);

        var recovery = recovery(journals);
        var services = new StaticListableBeanFactory(Map.of("recovery", recovery));
        sessions.setRecoveryServices(services.getBeanProvider(SessionRecoveryService.class));
        assertThat(sessions.getWebShellSession(TENANT, "actor", sessionId).recovery().nextTurnAllowed()).isTrue();
        assertThat(recovery.query(TENANT, "actor", sessionId).state()).isEqualTo("ready");
        verify(harness, never()).createOrLoad(anyString(), anyString(), eq(true), eq(true));
        verify(harness, never()).inspectRecovery(anyString(), anyString(), anyString());
        var admitted = sessions.submitTurn(TENANT, "actor", "first-turn", sessionId,
                List.of(new InputBlock("input_text", "First message")));
        assertThat(admitted.turnId()).isNotNull();
        assertThat(store.findTurn(TENANT, sessionId, admitted.turnId()).orElseThrow().status()).isEqualTo("ACCEPTED");
    }

    @Test
    void cancellingBeforeAnyNativeSubmissionStillAllowsTheFirstRealInput() {
        cancelBeforeSubmission("first-cancelled");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head", Integer.class)).isZero();
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isTrue();
        assertThat(sessions.submitTurn(TENANT, "actor", "first-real-input", sessionId,
                List.of(new InputBlock("input_text", "First real input"))).turnId()).isNotNull();
    }

    @Test
    void cancelledUnsubmittedWorkCanUseAProvenInitialJournal() throws Exception {
        genesis();
        rename();
        cancelBeforeSubmission("unsubmitted");
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-journal", "pristine-journal"})
    void aLaterUnsubmittedCancellationCannotHideAnEarlierPossibleSubmission(String nativeHistory) throws Exception {
        String earlier = cancelBeforeSubmission("earlier");
        jdbc.update("UPDATE ma_turn SET status = 'FAILED', submission_attempted = TRUE, harness_event_epoch = 'earlier-epoch'"
                + " WHERE turn_id = ?", earlier);
        if ("pristine-journal".equals(nativeHistory)) {
            genesis();
            rename();
        }
        String latest = cancelBeforeSubmission("latest");
        jdbc.update("UPDATE ma_turn SET gmt_create = gmt_create + 10 WHERE turn_id = ?", latest);
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isFalse();
    }

    @Test
    void cancellingUnsubmittedWorkCannotIgnoreAChangedInitialJournal() throws Exception {
        genesis();
        cancelBeforeSubmission("unsubmitted");
        jdbc.update("DELETE FROM ma_session_journal_tx");
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isFalse();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void withdrawingAnAttemptAndCancellingCannotHideALostBoundJournal(boolean newerCancellation) throws Exception {
        genesis();
        rename();
        var admitted = sessions.submitTurn(TENANT, "actor", "possibly-submitted", sessionId,
                List.of(new InputBlock("input_text", "Possibly submitted")));
        String turnId = admitted.turnId();
        assertThat(store.claimTurn(TENANT, sessionId, turnId, "owner", Duration.ofMinutes(1))).isPresent();
        assertThat(store.bindHarness(TENANT, sessionId, turnId, "owner", "bound-boot")).isTrue();
        store.markSubmissionAttempted(TENANT, sessionId, turnId, "owner");
        sessions.cancelTurn(TENANT, "actor", "cancel-attempt", sessionId, turnId);
        assertThat(store.withdrawSubmissionAttempted(TENANT, sessionId, turnId, "owner")).isTrue();
        store.cancelBeforeAdmission(TENANT, sessionId, turnId, "owner");
        var cancelled = store.findTurn(TENANT, sessionId, turnId).orElseThrow();
        assertThat(cancelled.status()).isEqualTo("CANCELLED");
        assertThat(cancelled.submissionAttempted()).isFalse();
        assertThat(cancelled.harnessEventEpoch()).isNull();
        if (newerCancellation) {
            turnId = cancelBeforeSubmission("newer");
            jdbc.update("UPDATE ma_turn SET gmt_create = gmt_create + 10 WHERE turn_id = ?", turnId);
        }
        assertThat(store.requireSession(TENANT, sessionId).harnessBootId()).isEqualTo("bound-boot");
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isTrue();
        jdbc.update("DELETE FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'");
        clearInvocations(harness, coordinator);
        String promptId = store.findTurn(TENANT, sessionId, turnId).orElseThrow().promptId();
        when(harness.inspectRecovery(TENANT, sessionId, promptId))
                .thenReturn(new HarnessConnector.RecoveryStatus("ready", null, promptId, true, true, true));
        var recovery = recovery(journals).query(TENANT, "actor", sessionId);
        assertThat(recovery.state()).isEqualTo("operator_required");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        assertThat(recovery.actions().recheck()).isFalse();
        verify(harness, never()).inspectRecovery(anyString(), anyString(), anyString());
        verify(harness, never()).recheckRecoveryCleanup(anyString(), anyString(), anyString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"input.accepted", "model.attempt", "tool.intent", "tool.receipt", "hosted.cleanup",
            "checkpoint.committed", "context.compacted", "unknown.future.event", "extension", "turn-activation"})
    void anApparentlyInitialHeadWithExecutionOrUnknownFactsDoesNotAdmitInput(String kind) throws Exception {
        genesis();
        rename();
        JsonNode payload = json.createObjectNode();
        if ("extension".equals(kind)) {
            payload = json.createObjectNode().put("domain", "hook_execution");
            kind = "domain.committed";
        } else if ("turn-activation".equals(kind)) {
            payload = json.createObjectNode().set("subject", json.createObjectNode().put("type", "turn"));
            kind = "activation.changed";
        }
        // Corrupt the stored bytes and their byte digest together: the narrow
        // initial proof must still inspect their meaning instead of trusting READY.
        replaceRenameRecord(kind, payload);
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isFalse();
    }

    @ParameterizedTest
    @ValueSource(strings = {"digest", "gap", "compaction", "checkpoint", "sequence", "activation", "foreign", "empty", "blocked",
            "genesis-transaction", "genesis-command", "genesis-content", "metadata-epoch", "trailing-newline"})
    void damagedOrIncompleteInitialEvidenceRemainsUnknown(String kind) throws Exception {
        genesis();
        switch (kind) {
            case "digest" -> jdbc.update("UPDATE ma_session_journal_tx SET record_digest = ?", "0".repeat(64));
            case "gap" -> jdbc.update("UPDATE ma_session_head SET journal_revision = journal_revision + 1");
            case "compaction" -> jdbc.update("UPDATE ma_session_head SET compacted_through_revision = 1");
            case "checkpoint" -> jdbc.update("UPDATE ma_session_head SET latest_checkpoint_resource_id = 'checkpoint'");
            case "sequence" -> jdbc.update("UPDATE ma_session_head SET committed_sequence = committed_sequence + 1");
            case "activation" -> jdbc.update("UPDATE ma_session_head SET activation_epoch = activation_epoch + 1");
            case "foreign" -> jdbc.update("UPDATE ma_session_journal_tx SET workspace_id = 'foreign'");
            case "empty" -> jdbc.update("DELETE FROM ma_session_journal_tx");
            case "blocked" -> jdbc.update("UPDATE ma_session_head SET recovery_status = 'BLOCKED_EXECUTION'");
            case "genesis-transaction" -> jdbc.update("UPDATE ma_session_journal_tx SET transaction_id = 'genesis' WHERE journal_revision = 1");
            case "genesis-command" -> jdbc.update("UPDATE ma_session_journal_tx SET command_id = 'genesis' WHERE journal_revision = 1");
            case "genesis-content" -> jdbc.update("UPDATE ma_session_journal_tx SET content_digest = ? WHERE journal_revision = 1", "0".repeat(64));
            case "metadata-epoch" -> {
                rename();
                jdbc.update("UPDATE ma_session_journal_tx SET activation_epoch = activation_epoch + 1 WHERE journal_revision = 3");
                jdbc.update("UPDATE ma_session_head SET activation_epoch = activation_epoch + 1");
            }
            case "trailing-newline" -> {
                rename();
                byte[] bytes = jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE journal_revision = 3", byte[].class);
                byte[] truncated = Arrays.copyOf(bytes, bytes.length - 1);
                jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ? WHERE journal_revision = 3",
                        truncated, truncated.length, DigestUtils.sha256Hex(truncated));
            }
            default -> throw new AssertionError(kind);
        }
        var result = recovery(journals).query(TENANT, "actor", sessionId);
        assertThat(result.nextTurnAllowed()).isFalse();
        assertThat(result.actions().recheck()).isFalse();
    }

    @ParameterizedTest
    @ValueSource(strings = {"definition", "root", "metadata", "install"})
    void missingOrCorruptInitialResourcesCannotProveReadiness(String id) throws Exception {
        genesis();
        rename();
        String resourceId = jdbc.queryForObject("SELECT resource_id FROM ma_resource WHERE kind = ?", String.class,
                switch (id) {
                    case "metadata" -> "managed-session_metadata";
                    case "install" -> "managed-activation-install";
                    default -> "managed-" + id;
                });
        if ("root".equals(id) || "metadata".equals(id)) {
            jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE resource_id = ?",
                    "broken".getBytes(StandardCharsets.UTF_8), resourceId);
        } else {
            jdbc.update("DELETE FROM ma_resource_ref WHERE resource_id = ?", resourceId);
            jdbc.update("DELETE FROM ma_resource WHERE resource_id = ?", resourceId);
        }
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isFalse();
    }

    @Test
    void aDigestCorrectMalformedDefinitionCommittedThroughTheStoreCannotProveReadiness() throws Exception {
        prepareGenesis();
        ObjectNode genesis = (ObjectNode) nativeFixture.path("commits").get(0);
        String[] lines = new String(Base64.getDecoder().decode(genesis.path("recordBytesBase64").asText()),
                StandardCharsets.UTF_8).split("\n");
        ObjectNode header = (ObjectNode) json.readTree(lines[1]);
        ObjectNode ref = (ObjectNode) header.path("managedSession").path("definitionRef");
        byte[] definition = "not-json".getBytes(StandardCharsets.UTF_8);
        String digest = DigestUtils.sha256Hex(definition);
        ref.put("byteLength", definition.length).put("digest", digest);
        for (JsonNode resource : genesis.path("resources")) {
            if (resource.path("resourceId").equals(ref.path("resourceId"))) {
                ((ObjectNode) resource).put("byteLength", definition.length).put("digest", digest)
                        .put("bytesBase64", Base64.getEncoder().encodeToString(definition));
            }
        }
        byte[] rewritten = (lines[0] + "\n" + header + "\n").getBytes(StandardCharsets.UTF_8);
        String recordDigest = DigestUtils.sha256Hex(rewritten);
        genesis.put("recordBytesBase64", Base64.getEncoder().encodeToString(rewritten))
                .put("recordDigest", recordDigest).put("contentDigest", recordDigest);
        commit(genesis);
        commit(nativeFixture.path("commits").get(1));

        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_id = ?",
                byte[].class, ref.path("resourceId").asText())).containsExactly(definition);
        assertThat(journals.hasPristineInitialJournal(TENANT, sessionId, WORKSPACE)).isFalse();
        assertThat(recovery(journals).query(TENANT, "actor", sessionId).nextTurnAllowed()).isFalse();
    }

    @Test
    void aHeadThatAdvancesDuringTheReadCannotProveInitialReadiness() throws Exception {
        genesis();
        JdbcTemplate moving = new ManagedSchemaJdbcTemplate(source) {
            @Override
            public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
                assertThat(sql).doesNotContainIgnoringCase("FOR UPDATE");
                var result = super.query(sql, mapper, arguments);
                if (sql.contains("FROM ma_session_journal_tx")) {
                    jdbc.update("UPDATE ma_session_head SET journal_revision = journal_revision + 1");
                }
                return result;
            }
        };
        assertThat(recovery(com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedSessionStore(moving))).query(TENANT, "actor", sessionId).nextTurnAllowed()).isFalse();
    }

    private SessionRecoveryService recovery(ManagedSessionStore nativeStore) {
        return new SessionRecoveryService(sessions, store, coordinator, harness, new com.alibaba.qwen.code.managedagent.persistence.JdbcSessionRecoveryRepository(jdbc), nativeStore);
    }

    private String cancelBeforeSubmission(String key) {
        var admitted = sessions.submitTurn(TENANT, "actor", key, sessionId,
                List.of(new InputBlock("input_text", "Cancelled before submission")));
        assertThat(store.claimTurn(TENANT, sessionId, admitted.turnId(), "owner", Duration.ofMinutes(1))).isPresent();
        sessions.cancelTurn(TENANT, "actor", key + "-cancel", sessionId, admitted.turnId());
        store.cancelBeforeAdmission(TENANT, sessionId, admitted.turnId(), "owner");
        var cancelled = store.findTurn(TENANT, sessionId, admitted.turnId()).orElseThrow();
        assertThat(cancelled.status()).isEqualTo("CANCELLED");
        assertThat(cancelled.submissionAttempted()).isFalse();
        return admitted.turnId();
    }

    private void genesis() throws Exception {
        prepareGenesis();
        commit(nativeFixture.path("commits").get(0));
        commit(nativeFixture.path("commits").get(1));
    }

    private void prepareGenesis() throws Exception {
        Path root = VerificationFixtures.repositoryRoot();
        Path output = directory.resolve("initial-journal.json");
        var process = new ProcessBuilder("node", root.resolve(
                "packages/managed-agent-server/verification/src/test/resources/recovery-initial-journal.mjs").toString(), sessionId)
                .directory(root.toFile()).redirectErrorStream(true).redirectOutput(output.toFile()).start();
        try {
            assertThat(process.waitFor(30, TimeUnit.SECONDS)).as("Core initial journal generator completed").isTrue();
            assertThat(process.exitValue()).as(Files.readString(output)).isZero();
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly().waitFor(10, TimeUnit.SECONDS);
            }
        }
        nativeFixture = json.readTree(output.toFile());
        assertThat(nativeFixture.path("coldOpened").asBoolean()).isTrue();
        generation = journals.acquireWriter(TENANT, sessionId, TOKEN,
                new AcquireWriterRequest(WORKSPACE, "writer", 60_000L)).writerGeneration();
    }

    private void commit(JsonNode nativeCommit) {
        var resources = new ArrayList<CommitResource>();
        nativeCommit.path("resources").forEach(resource -> resources.add(json.convertValue(resource, CommitResource.class)));
        int recordCount = nativeCommit.path("eventCount").asInt() == 0 ? 2 : nativeCommit.path("eventCount").asInt() + 1;
        journals.commit(TENANT, sessionId, TOKEN, new CommitTransactionRequest(WORKSPACE, "writer", generation,
                revision, sequence, nativeCommit.path("transactionId").asText(), nativeCommit.path("operation").asText(),
                nativeCommit.path("commandId").asText(), nativeCommit.path("contentDigest").asText(),
                nativeCommit.path("firstSequence").asLong(), nativeCommit.path("lastSequence").asLong(),
                nativeCommit.path("eventCount").asInt(), nativeCommit.path("eventsDigest").asText(null),
                nativeCommit.path("previousCommitDigest").asText(null), nativeCommit.path("commitDigest").asText(null),
                nativeCommit.path("activationEpoch").asLong(), null, recordCount,
                nativeCommit.path("recordBytesBase64").asText(), nativeCommit.path("recordDigest").asText(), resources));
        revision++;
        sequence = nativeCommit.path("lastSequence").asLong();
    }

    private void rename() {
        commit(nativeFixture.path("commits").get(2));
    }

    private void replaceRenameRecord(String kind, JsonNode payload) throws Exception {
        byte[] bytes = jdbc.queryForObject("SELECT record_bytes FROM ma_session_journal_tx WHERE journal_revision = 3", byte[].class);
        String[] lines = new String(bytes, StandardCharsets.UTF_8).split("\n");
        ObjectNode record = (ObjectNode) json.readTree(lines[0]);
        record.withObject("/managedSession").put("kind", kind).set("payload", payload);
        ObjectNode marker = (ObjectNode) json.readTree(lines[1]);
        String eventsDigest = digests.digest(json.convertValue(List.of(record.path("managedSession")), Object.class)).substring(7);
        marker.withObject("/managedSession").put("eventsDigest", eventsDigest);
        String commitDigest = digests.digest(json.convertValue(marker.path("managedSession"), Object.class)).substring(7);
        String rewritten = record + "\n" + marker + "\n";
        jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ?,"
                        + " events_digest = ?, commit_digest = ? WHERE journal_revision = 3",
                rewritten.getBytes(StandardCharsets.UTF_8), rewritten.getBytes(StandardCharsets.UTF_8).length,
                DigestUtils.sha256Hex(rewritten), eventsDigest, commitDigest);
        jdbc.update("UPDATE ma_session_head SET last_commit_digest = ?", commitDigest);
    }
}
