package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class ManagedModelContextTest {
    private static final String TENANT = "model-context-tenant";
    private static final String WORKSPACE = "model-context-workspace";
    private static final String USAGE_KIND = "managed-hosted-model-usage";
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicInteger statements = new AtomicInteger();
    private ManagedSchemaJdbcTemplate jdbc;
    private ManagedSessionStore sessions;
    private ManagedExtensionRecordStore records;
    private TransactionTemplate transactions;

    @BeforeEach
    void setUp() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:model-context-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var counted = new DelegatingDataSource(source) {
            @Override
            public java.sql.Connection getConnection() throws java.sql.SQLException {
                var connection = super.getConnection();
                return (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(
                        getClass().getClassLoader(), new Class<?>[] {java.sql.Connection.class},
                        (proxy, method, arguments) -> {
                            if (method.getName().equals("prepareStatement")) {
                                statements.incrementAndGet();
                            }
                            try {
                                return method.invoke(connection, arguments);
                            } catch (java.lang.reflect.InvocationTargetException error) {
                                throw error.getCause();
                            }
                        });
            }
        };
        jdbc = new ManagedSchemaJdbcTemplate(counted);
        records = new ManagedExtensionRecordStore(jdbc);
        sessions = new ManagedSessionStore(jdbc, records);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(counted));
    }

    @Test
    void committedMainUsageIsDurableAndUsesOnlyTheLatestRequest() {
        var journal = open(TENANT, "main", true);
        var body = usage("actual-model", 120, 1_000);
        body.putObject("budget").put("secretHandle", "private-budget");
        body.putObject("models").put("totalTokenCount", 100_000_000);
        body.withArray("attempts").insert(0, json.createObjectNode()
                .put("promptTokenCount", 900).put("contextWindowSize", 2_000));
        commit(journal, request(journal, "first", body, USAGE_KIND, "output_committed", 1_000));

        var saved = new ManagedExtensionRecordStore(jdbc).findModelContexts(TENANT, List.of("main"));
        assertThat(saved).containsEntry("main", new WebShellModelContext("actual-model", 120L, 1_000L, 1_000));
        assertThat(json.valueToTree(saved.get("main")).toString())
                .doesNotContain("budget", "secretHandle", "totalTokenCount", "models", "route");
        assertThat(records.listTasks(TENANT, "main", null, null, 10).tasks()).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind ="
                + " 'SESSION_RECORD'", Integer.class)).isEqualTo(1);
    }

    @Test
    void replayCannotReplaceANewerObservationAndFirstSequenceStaysFixed() {
        var journal = open(TENANT, "replay", true);
        var first = request(journal, "first", usage("first", 10, 100), USAGE_KIND,
                "output_committed", 1_000);
        commit(journal, first);
        var second = request(journal, "second", usage("second", 20, 200), USAGE_KIND,
                "output_committed", 900);
        commit(journal, second);
        assertThat(transactions.execute(status -> journal.commit(first)).replayed()).isTrue();

        assertThat(context("replay")).isEqualTo(new WebShellModelContext("second", 20L, 200L, 900));
        var row = jdbc.queryForMap("SELECT revision, first_sequence, gmt_create, settled_at FROM"
                + " ma_session_record WHERE domain = 'hosted_context_usage'");
        assertThat(((Number) row.get("revision")).longValue()).isEqualTo(second.lastSequence());
        assertThat(((Number) row.get("first_sequence")).longValue()).isEqualTo(first.lastSequence());
        assertThat(((Number) row.get("gmt_create")).longValue()).isEqualTo(1_000);
        assertThat(((Number) row.get("settled_at")).longValue()).isEqualTo(900);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind ="
                + " 'SESSION_RECORD'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT owner_revision FROM ma_resource_ref WHERE"
                + " owner_kind = 'SESSION_RECORD'", Long.class)).isEqualTo(second.lastSequence());
    }

    @ParameterizedTest
    @ValueSource(strings = {"started", "abandoned", "hook", "unbound", "control"})
    void unrelatedAttemptsNeverCreateAnObservation(String shape) {
        var journal = open(TENANT, "excluded", !shape.equals("unbound"));
        if (shape.equals("control")) {
            jdbc.update("UPDATE ma_session SET session_kind = 'CONTROL' WHERE session_id = ?", "excluded");
        }
        String kind = shape.equals("hook") ? "managed-hook-model-usage" : USAGE_KIND;
        String state = List.of("started", "abandoned").contains(shape) ? shape : "output_committed";
        commit(journal, request(journal, "excluded", usage("model", 10, 100), kind, state, 1_000));
        assertThat(records.findModelContexts(TENANT, List.of("excluded"))).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record", Integer.class)).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"old", "null-last", "invalid-counts", "invalid-json", "invalid-model"})
    void newerUnknownNeverFallsBackToAnOlderKnownSnapshot(String shape) {
        var journal = open(TENANT, "unknown", true);
        commit(journal, request(journal, "known", usage("known-model", 10, 100), USAGE_KIND,
                "output_committed", 1_000));
        ObjectNode next = usage("new-model", 20, 200);
        if (shape.equals("old")) {
            ((ObjectNode) next.withArray("attempts").get(0)).remove("contextWindowSize");
        } else if (shape.equals("null-last")) {
            next.withArray("attempts").addNull();
        } else if (shape.equals("invalid-counts")) {
            ((ObjectNode) next.withArray("attempts").get(0))
                    .put("promptTokenCount", -1).put("contextWindowSize", 0);
        } else if (shape.equals("invalid-model")) {
            next.put("model", "");
        }
        byte[] bytes = shape.equals("invalid-json") ? "{bad".getBytes(StandardCharsets.UTF_8)
                : ExtensionRecordJournal.bytes(next);
        var request = request(journal, "unknown", bytes, USAGE_KIND, "output_committed", 2_000,
                event -> {});
        commit(journal, request);
        var context = context("unknown");
        if (List.of("invalid-json", "invalid-model").contains(shape)) {
            assertThat(context).isNull();
        } else {
            assertThat(context.modelId()).isEqualTo("new-model");
            assertThat(context.observedAt()).isEqualTo(2_000);
            assertThat(context.contextWindowSize()).isNull();
            assertThat(context.inputTokens()).isEqualTo(shape.equals("old") ? 20L : null);
        }
        assertThat(jdbc.queryForObject("SELECT revision FROM ma_session_record WHERE domain ="
                + " 'hosted_context_usage'", Long.class)).isEqualTo(request.lastSequence());
    }

    @ParameterizedTest
    @ValueSource(strings = {"9007199254740992", "1.5", "\"123\"", "null", "-1"})
    void unsafeTokenValuesAreUnknown(String value) throws Exception {
        var journal = open(TENANT, "unsafe", true);
        ObjectNode body = usage("model", 0, 100);
        ObjectNode usage = (ObjectNode) body.withArray("attempts").get(0);
        usage.set("promptTokenCount", json.readTree(value));
        usage.set("contextWindowSize", json.readTree(value));
        commit(journal, request(journal, "unsafe", body, USAGE_KIND, "output_committed", 1_000));
        assertThat(context("unsafe")).isEqualTo(new WebShellModelContext("model", null, null, 1_000));
    }

    @Test
    void zeroUsageAndSafeIntegerCeilingsArePreserved() {
        var journal = open(TENANT, "zero", true);
        commit(journal, request(journal, "zero", usage("model", 0, 9_007_199_254_740_991L),
                USAGE_KIND, "output_committed", 1_000));
        assertThat(context("zero")).isEqualTo(new WebShellModelContext("model", 0L,
                9_007_199_254_740_991L, 1_000));
    }

    @Test
    void integralJsonNumbersRemainValidAndOverflowingVersionsAreUnknown() throws Exception {
        var journal = open(TENANT, "numeric", true);
        ObjectNode body = usage("model", 10, 100);
        ObjectNode last = (ObjectNode) body.withArray("attempts").get(0);
        last.set("promptTokenCount", json.readTree("12.0"));
        last.set("contextWindowSize", json.readTree("120.0"));
        commit(journal, request(journal, "integral", body, USAGE_KIND, "output_committed", 1_000));
        assertThat(context("numeric")).isEqualTo(new WebShellModelContext("model", 12L, 120L, 1_000));
        body.set("version", json.readTree("18446744073709551617"));
        commit(journal, request(journal, "overflow", body, USAGE_KIND, "output_committed", 2_000));
        assertThat(context("numeric")).isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"digest", "scope", "missing", "fields"})
    void conflictingUsageReferencesRollBackTheWholeTransaction(String shape) {
        var journal = open(TENANT, "refused", true);
        var request = request(journal, "refused", ExtensionRecordJournal.bytes(usage("model", 10, 100)),
                USAGE_KIND, "output_committed", 1_000, event -> {
                    if (shape.equals("digest")) {
                        ((ObjectNode) event.path("payload").path("usageRef")).put("digest", "f".repeat(64));
                    } else if (shape.equals("scope")) {
                        ((ObjectNode) event.path("sessionKey")).put("workspaceId", "foreign");
                    } else if (shape.equals("fields")) {
                        ((ObjectNode) event.path("payload").path("usageRef")).put("unexpected", true);
                    } else {
                        ((ObjectNode) event.path("payload").path("usageRef")).put("resourceId", "missing");
                    }
                });
        assertThatThrownBy(() -> transactions.execute(status -> journal.commit(request)))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class)).isEqualTo(1);
    }

    @Test
    void batchReadIsOneQueryAndNeverCrossesTenantOrSession() {
        for (String session : List.of("first", "second", "excluded")) {
            var journal = open(TENANT, session, true);
            commit(journal, request(journal, session, usage(session, 10, 100), USAGE_KIND,
                    "output_committed", 1_000));
        }
        var foreign = open("foreign", "foreign-session", true);
        commit(foreign, request(foreign, "foreign", usage("foreign-model", 10, 100), USAGE_KIND,
                "output_committed", 1_000));
        statements.set(0);
        assertThat(records.findModelContexts(TENANT, List.of("first", "second", "foreign-session")))
                .containsOnlyKeys("first", "second");
        assertThat(statements.get()).isEqualTo(1);
        statements.set(0);
        assertThat(records.findModelContexts(TENANT, List.of())).isEmpty();
        assertThat(statements.get()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"digest", "oversized", "scope", "kind"})
    void corruptedOrOversizedBodiesAreNotExposed(String corruption) {
        var journal = open(TENANT, "corrupt", true);
        commit(journal, request(journal, "corrupt", usage("model", 10, 100), USAGE_KIND,
                "output_committed", 1_000));
        switch (corruption) {
            case "digest" -> jdbc.update("UPDATE ma_resource SET sha256 = ?", "f".repeat(64));
            case "oversized" -> jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?",
                    new byte[65_537], 65_537);
            case "scope" -> jdbc.update("UPDATE ma_resource SET workspace_id = ?", "foreign");
            case "kind" -> jdbc.update("UPDATE ma_resource SET kind = ?", "managed-hook-model-usage");
            default -> throw new IllegalArgumentException(corruption);
        }
        assertThat(records.findModelContexts(TENANT, List.of("corrupt"))).isEmpty();
    }

    @Test
    void webShellGetAndListReadTheSameAuthorizedObservation() {
        var journal = open(TENANT, "summary", true);
        commit(journal, request(journal, "summary", usage("actual-model", 12, 100), USAGE_KIND,
                "output_committed", 1_000));
        var properties = new ManagedAgentProperties();
        var registry = new ManagedWorkspaceRegistry(jdbc);
        var state = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, registry, properties);
        var service = new ManagedAgentService(state, new RequestDigests(), mock(HarnessCoordinator.class),
                mock(HarnessConnector.class), registry);
        assertThat(service.getWebShellSession(TENANT, "reader", "summary").modelContext())
                .isEqualTo(context("summary"));
        assertThat(service.listWebShellSessions(TENANT, "reader", null, 100).data())
                .singleElement().satisfies(session -> assertThat(session.modelContext()).isEqualTo(context("summary")));
        assertThatThrownBy(() -> service.getWebShellSession(TENANT, "stranger", "summary"))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(service.listWebShellSessions(TENANT, "stranger", null, 100).data()).isEmpty();
        assertThat(json.valueToTree(service.getWebShellSession(TENANT, "reader", "summary"))
                .path("modelContext").path("modelId").textValue()).isEqualTo("actual-model");
    }

    private ExtensionRecordJournal open(String tenant, String session, boolean bound) {
        if (bound) {
            jdbc.update("INSERT IGNORE INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, ?, 1,"
                    + " 'storage', 'Workspace', ?, ?, 'ACTIVE')", tenant, WORKSPACE,
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT IGNORE INTO ma_workspace_access (tenant_id, workspace_id, actor_id,"
                    + " role) VALUES (?, ?, ?, 'READER')", tenant, WORKSPACE, "reader");
            jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified,"
                    + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative,"
                    + " context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref)"
                    + " VALUES (?, ?, 'qwen-code', 1, 1, ?, 1, 'storage', '.', ?, 1, ?, ?)", tenant,
                    session, WORKSPACE, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        } else {
            jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, 'qwen-code', 1, 1)", tenant, session);
        }
        return transactions.execute(status -> new ExtensionRecordJournal(sessions, tenant, WORKSPACE, session).open());
    }

    private ObjectNode usage(String model, long input, long window) {
        ObjectNode body = json.createObjectNode().put("version", 1).put("model", model);
        body.putArray("attempts").addObject().put("promptTokenCount", input)
                .put("contextWindowSize", window).put("totalTokenCount", 999_999);
        return body;
    }

    private CommitTransactionRequest request(ExtensionRecordJournal journal, String command,
            JsonNode body, String kind, String state, long at) {
        return request(journal, command, ExtensionRecordJournal.bytes(body), kind, state, at, event -> {});
    }

    private CommitTransactionRequest request(ExtensionRecordJournal journal, String command,
            byte[] body, String kind, String state, long at, Consumer<ObjectNode> edit) {
        String resource = ExtensionRecordJournal.resourceId(body);
        var base = journal.request("hostedModelAttempt", command, body, at, event -> {
            event.put("kind", "model.attempt").put("eventId", "attempt:" + command);
            ObjectNode payload = event.putObject("payload").put("attemptId", command).put("state", state);
            payload.putObject("usageRef").put("resourceId", resource).put("kind", kind)
                    .put("schemaVersion", 1).put("byteLength", body.length)
                    .put("digest", ExtensionRecordJournal.sha256(body));
            edit.accept(event);
        }, lines -> lines);
        return new CommitTransactionRequest(base.workspaceId(), base.writerId(), base.writerGeneration(),
                base.expectedJournalRevision(), base.expectedCommittedSequence(), base.transactionId(),
                base.operation(), base.commandId(), base.contentDigest(), base.firstSequence(),
                base.lastSequence(), base.eventCount(), base.eventsDigest(), base.previousCommitDigest(),
                base.commitDigest(), base.activationEpoch(), base.latestCheckpointResourceId(), base.recordCount(),
                base.recordBytesBase64(), base.recordDigest(), List.of(new CommitResource(resource, kind, 1,
                        body.length, ExtensionRecordJournal.sha256(body), Base64.getEncoder().encodeToString(body))));
    }

    private void commit(ExtensionRecordJournal journal, CommitTransactionRequest request) {
        transactions.executeWithoutResult(status -> journal.commit(request));
        journal.committed(request);
    }

    private WebShellModelContext context(String session) {
        return records.findModelContexts(TENANT, List.of(session)).get(session);
    }
}
