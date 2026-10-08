package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.daemon.DaemonException;
import com.alibaba.qwen.code.managedagent.AutomationHarnessFake;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.AutomationDefinitionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicAutomation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicAutomationRun;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.OccurrenceView;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * H6b: the scanner and the service against the real ledger on H2 and the
 * in-memory automation funnel. Time is a controlled clock, so every slot
 * window, late tolerance and lease is exact.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-automation-scanner;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class AutomationScannerTest {
    private static final String WORKSPACE = "ws-automation";
    private static final String ACTOR = "automation-owner";
    private static final String READER = "automation-reader";
    private static final long T0 = Instant.parse("2026-06-01T10:00:00Z")
            .toEpochMilli();
    private static final long MINUTE = 60_000L;

    @Autowired
    private AutomationLedgerStore ledger;

    @Autowired
    private ManagedAgentStore agentStore;

    @Autowired
    private ManagedAgentService sessions;

    @Autowired
    private ManagedWorkspaceRegistry workspaces;

    @Autowired
    private RequestDigests digests;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ApplicationContext applicationContext;

    private String tenant;
    private String sessionId;
    private AutomationHarnessFake fake;
    private FakeConnector connector;
    private AtomicLong clock;
    private ManagedAgentProperties.Automation settings;
    private AutomationScanner scanner;
    private ManagedAutomationService service;

    @BeforeEach
    void setUp() {
        // The scanner's work queries span every tenant by design, and this
        // class shares one H2: earlier methods' armed rows must never be
        // the current method's fake's fires.
        for (String table : List.of("qwen_managed_automation_occurrence",
                "qwen_managed_automation_schedule",
                "qwen_managed_automation_command")) {
            jdbc.update("DELETE FROM " + table
                    + " WHERE tenant_id LIKE 'tenant-automation-%'");
        }
        tenant = "tenant-automation-" + UUID.randomUUID();
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, 'storage', 'Workspace', ?, ?,"
                        + " 'ACTIVE')",
                tenant, WORKSPACE,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)",
                tenant, WORKSPACE, ACTOR.getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, FALSE)",
                tenant, WORKSPACE, READER.getBytes(StandardCharsets.UTF_8));
        sessionId = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Automation",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, sessionId);
        fake = new AutomationHarnessFake();
        connector = new FakeConnector(fake);
        clock = new AtomicLong(T0);
        settings = new ManagedAgentProperties.Automation();
        settings.setEnabled(true);
        settings.setLateTolerance(Duration.ofMinutes(5));
        settings.setLookback(Duration.ofHours(24));
        settings.setLease(Duration.ofSeconds(60));
        settings.setConcurrency(4);
        scanner = scanner("scanner-a");
        service = new ManagedAutomationService(ledger, agentStore, workspaces,
                connector, scanner, digests, mapper, settings, true,
                clock::get);
    }

    private AutomationScanner scanner(String owner) {
        return new AutomationScanner(ledger, connector, mapper, settings,
                clock::get, owner);
    }

    private PublicAutomation define(String cron, String overlap,
            String catchUp, Long catchUpLimit, boolean enabled) {
        return service.create(tenant, ACTOR, "key-" + UUID.randomUUID(),
                new AutomationDefinitionRequest(sessionId, "Goal", cron, "UTC",
                        "Run it.", null, overlap, catchUp, catchUpLimit,
                        enabled)).body();
    }

    private Map<String, List<String>> outcomes(String automationId) {
        return ledger.listOccurrences(tenant, automationId, null, 100).rows()
                .stream().map(OccurrenceView::occurrence)
                .collect(Collectors.groupingBy(
                        AutomationLedgerStore.OccurrenceRow::outcome,
                        Collectors.mapping(
                                AutomationLedgerStore.OccurrenceRow::occurrenceKey,
                                Collectors.toList())));
    }

    @Test
    void twoScannersClaimExactlyOneRunPerOccurrence() {
        PublicAutomation automation = define("* * * * *", "allow", "none", null,
                true);
        AutomationScanner other = scanner("scanner-b");
        clock.set(T0 + MINUTE + 1_000);
        int fired = scanner.tick(clock.get()) + other.tick(clock.get());
        assertThat(fired).isEqualTo(1);
        assertThat(fake.fires()).isEqualTo(1);
        assertThat(fake.firedOccurrences())
                .containsExactly("schedule:2026-06-01T10:01:00Z");
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRED);
        // A lease another scanner holds keeps this one out; an expired
        // lease yields the row.
        long held = ledger.claim(tenant, automation.id(), "scanner-c",
                clock.get() + 60_000, clock.get());
        assertThat(held).isPositive();
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        // The held lease covered nothing: both slots since the watermark
        // are still timely and fire once the lease expires.
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(2);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:02:00Z",
                "schedule:2026-06-01T10:03:00Z");
        // The lost fence cannot move the watermark.
        ScheduleRow row = ledger.findSchedule(tenant, automation.id())
                .orElseThrow();
        assertThat(ledger.advanceWatermark(tenant, automation.id(),
                "scanner-c", held, clock.get(), clock.get())).isFalse();
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .watermarkSlot()).isEqualTo(row.watermarkSlot());
    }

    @Test
    void appliesEveryOverlapAndCatchUpPair() {
        // Ten slots since arming; the newest five are timely under the
        // five-minute tolerance, the oldest five are late.
        for (String overlap : List.of("skip", "queue_one", "allow")) {
            for (String catchUp : List.of("none", "latest", "bounded")) {
                clock.set(T0);
                PublicAutomation automation = define("* * * * *", overlap,
                        catchUp, "bounded".equals(catchUp) ? 2L : null, true);
                clock.set(T0 + 10 * MINUTE + 30_000);
                scanner.tick(clock.get());
                int caughtUp = switch (catchUp) {
                    case "latest" -> 1;
                    case "bounded" -> 2;
                    default -> 0;
                };
                int allowed = switch (overlap) {
                    case "queue_one" -> 2;
                    case "allow" -> 4;
                    default -> 1;
                };
                Map<String, List<String>> outcomes = outcomes(automation.id());
                String label = overlap + "/" + catchUp;
                assertThat(outcomes.getOrDefault("fired", List.of())).as(label)
                        .hasSize(Math.min(allowed, caughtUp + 5));
                assertThat(outcomes.getOrDefault("missed", List.of())).as(label)
                        .hasSize(5 - caughtUp);
                assertThat(outcomes.getOrDefault("skipped", List.of())).as(label)
                        .hasSize(caughtUp + 5 - Math.min(allowed, caughtUp + 5));
                if (caughtUp > 0) {
                    // Catch-up fires oldest first, so the oldest chosen late
                    // slot is the one every overlap policy admits.
                    assertThat(outcomes.get("fired")).as(label)
                            .contains("schedule:2026-06-01T10:0" + (6 - caughtUp)
                                    + ":00Z");
                }
                List<String> skippedReasons = ledger.listOccurrences(tenant,
                        automation.id(), null, 100).rows().stream()
                        .map(OccurrenceView::occurrence)
                        .filter(each -> "skipped".equals(each.outcome()))
                        .map(AutomationLedgerStore.OccurrenceRow::reason)
                        .distinct().toList();
                assertThat(skippedReasons).as(label).isSubsetOf(List.of(
                        "allow".equals(overlap) ? "count_limit" : "overlap"));
                // The window is covered: the same tick fires nothing more.
                assertThat(scanner.tick(clock.get())).as(label).isEqualTo(0);
            }
        }
    }

    @Test
    void redrivesAClaimWhoseAnswerWasLost() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        fake.failNextFire = new IllegalStateException("answer lost");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRING);
        clock.set(T0 + MINUTE + 11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(fake.firedOccurrences())
                .containsExactly("schedule:2026-06-01T10:01:00Z",
                        "schedule:2026-06-01T10:01:00Z");
    }

    @Test
    void skipsAnOccurrenceTheDefinitionMovedUnder() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        // The definition moved on the Harness without the mirror learning.
        fake.run(sessionId, Map.of("operationId", UUID.randomUUID().toString(),
                "kind", "define_schedule", "scheduleId", automation.id(),
                "definition", Map.of("cron", "*/2 * * * *")));
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        List<OccurrenceView> rows = ledger.listOccurrences(tenant,
                automation.id(), null, 10).rows();
        assertThat(rows).hasSize(1);
        assertThat(rows.getFirst().occurrence().outcome()).isEqualTo("skipped");
        assertThat(rows.getFirst().occurrence().reason())
                .isEqualTo("revision_stale");
    }

    @Test
    void skipsWhenTheTargetSessionIsNotActive() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSED'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, sessionId);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(fake.fires()).isEqualTo(0);
        List<OccurrenceView> rows = ledger.listOccurrences(tenant,
                automation.id(), null, 10).rows();
        assertThat(rows.getFirst().occurrence().reason())
                .isEqualTo("session_not_active");
    }

    @Test
    void neverFiresTheSlotsOfADisabledSpan() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                false);
        clock.set(T0 + 3 * MINUTE);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        service.update(tenant, ACTOR, automation.id(), "enable-" + UUID.randomUUID(),
                new AutomationDefinitionRequest(null, null, null, null, null,
                        null, null, null, null, true));
        clock.set(T0 + 4 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.firedOccurrences())
                .containsExactly("schedule:2026-06-01T10:04:00Z");
        assertThat(outcomes(automation.id()).values().stream()
                .mapToInt(List::size).sum()).isEqualTo(1);
    }

    @Test
    void blocksADefinitionWhoseZoneStopsResolving() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        jdbc.update("UPDATE qwen_managed_automation_schedule SET timezone = ?"
                + " WHERE tenant_id = ? AND schedule_id = ?", "Mars/Olympus_Mons",
                tenant, automation.id());
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .blockedReason()).contains("does not resolve");
        assertThat(ledger.findArmed(clock.get(), 10)).noneMatch(
                row -> row.scheduleId().equals(automation.id()));
    }

    @Test
    void manualRunsReplayByKeyAndFollowTheOverlapPolicy() {
        PublicAutomation automation = define("0 2 * * *", "skip", "none", null,
                false);
        PublicAutomationRun first = service.run(tenant, ACTOR, automation.id(),
                "manual-1").body();
        assertThat(first.outcome()).isEqualTo("fired");
        assertThat(first.occurrenceKey()).isEqualTo("manual:manual-1");
        assertThat(first.id()).isEqualTo(AutomationLedgerStore
                .automationRunId(automation.id(), "manual:manual-1"));
        assertThat(service.run(tenant, ACTOR, automation.id(), "manual-1")
                .replayed()).isTrue();
        assertThat(fake.fires()).isEqualTo(1);
        assertThatThrownBy(() -> service.run(tenant, ACTOR, automation.id(),
                "manual-2"))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode()).isEqualTo("automation_run_skipped");
                });
        // The first run settles in the Session store: its projection row
        // reads completed, so the next manual run is admitted.
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, created_at)"
                        + " VALUES (?, ?, ?, ?, ?, 'automation_run', ?, ?, 3,"
                        + " 'resource', 'automation_run', 'completed', ?)",
                ManagedSessionStore.sessionScopeKey(tenant, sessionId),
                ManagedExtensionProjection.recordKey(sessionId, "automation_run",
                        first.id()), tenant, WORKSPACE, sessionId, first.id(),
                "0".repeat(64), clock.get());
        assertThat(service.run(tenant, ACTOR, automation.id(), "manual-3")
                .body().outcome()).isEqualTo("fired");
        PublicList<PublicAutomationRun> runs = service.listRuns(tenant, ACTOR,
                automation.id(), null, 10);
        assertThat(runs.data()).extracting(PublicAutomationRun::outcome)
                .containsExactlyInAnyOrder("fired", "skipped", "fired");
        assertThat(runs.data()).filteredOn(run -> run.id().equals(first.id()))
                .extracting(PublicAutomationRun::state)
                .containsExactly("completed");
    }

    @Test
    void definitionsReviseAppendOnlyAndRetireIdempotently() {
        var created = service.create(tenant, ACTOR, "create-1",
                new AutomationDefinitionRequest(sessionId, "Goal", "0 2 * * *",
                        "UTC", "Run it.", null, null, null, null, null));
        assertThat(created.replayed()).isFalse();
        assertThat(created.body().definitionRevision()).isEqualTo(1);
        assertThat(created.body().overlap()).isEqualTo("skip");
        assertThat(service.create(tenant, ACTOR, "create-1",
                new AutomationDefinitionRequest(sessionId, "Goal", "0 2 * * *",
                        "UTC", "Run it.", null, null, null, null, null))
                .replayed()).isTrue();
        assertThatThrownBy(() -> service.create(tenant, ACTOR, "create-1",
                new AutomationDefinitionRequest(sessionId, "Other", "0 2 * * *",
                        "UTC", "Run it.", null, null, null, null, null)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        String id = created.body().id();
        var revised = service.update(tenant, ACTOR, id, "update-1",
                new AutomationDefinitionRequest(null, null, "30 2 * * *", null,
                        null, null, null, null, null, null));
        assertThat(revised.body().definitionRevision()).isEqualTo(2);
        assertThat(revised.body().cron()).isEqualTo("30 2 * * *");
        assertThat(revised.body().goal()).isEqualTo("Goal");
        // Unchanged content appends nothing.
        var same = service.update(tenant, ACTOR, id, "update-2",
                new AutomationDefinitionRequest(null, null, "30 2 * * *", null,
                        null, null, null, null, null, null));
        assertThat(same.body().definitionRevision()).isEqualTo(2);
        assertThat(service.list(tenant, ACTOR, null, 10).data())
                .extracting(PublicAutomation::id).contains(id);
        assertThat(service.list(tenant, READER, null, 10).data())
                .extracting(PublicAutomation::id).contains(id);
        assertThatThrownBy(() -> service.update(tenant, READER, id, "update-3",
                new AutomationDefinitionRequest(null, "Reader", null, null,
                        null, null, null, null, null, null)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getStatus()).isEqualTo(HttpStatus.FORBIDDEN));
        assertThatThrownBy(() -> service.get(tenant, "stranger", id))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
        var retired = service.retire(tenant, ACTOR, id, "retire-1");
        assertThat(retired.body().state()).isEqualTo("retired");
        assertThat(service.retire(tenant, ACTOR, id, "retire-2").replayed())
                .isTrue();
        assertThatThrownBy(() -> service.update(tenant, ACTOR, id, "update-4",
                new AutomationDefinitionRequest(null, null, "0 3 * * *", null,
                        null, null, null, null, null, null)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("automation_retired"));
        clock.set(T0 + 25 * 3_600_000L);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
    }

    @Test
    void aLostCommandRowNeverMintsASecondDefinition() {
        AutomationDefinitionRequest request = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        PublicAutomation created = service.create(tenant, ACTOR, "lost-row",
                request).body();
        assertThat(created.id()).isEqualTo(
                ManagedAutomationService.scheduleIdFor(tenant, "lost-row"));
        // The crash window: the Harness committed and the ledger mirrored,
        // but the command row was never written.
        jdbc.update("DELETE FROM qwen_managed_automation_command"
                + " WHERE tenant_id = ? AND idempotency_key = ?", tenant,
                "lost-row");
        var retried = service.create(tenant, ACTOR, "lost-row", request);
        assertThat(retried.body().id()).isEqualTo(created.id());
        assertThat(retried.body().definitionRevision()).isEqualTo(1);
        assertThat(ledger.listReadableSchedules(tenant, ACTOR, null, 10).rows())
                .extracting(AutomationLedgerStore.ScheduleRow::scheduleId)
                .containsExactly(created.id());
        assertThat(fake.operations).filteredOn(operation ->
                "define_schedule".equals(operation.get("kind"))).hasSize(2);
    }

    @Test
    void pagesDefinitionsAndOccurrencesWithStableCursors() {
        for (int index = 0; index < 3; index++) {
            clock.set(T0 + index);
            define("* * * * *", "allow", "none", null, true);
        }
        PublicList<PublicAutomation> first = service.list(tenant, ACTOR, null, 2);
        assertThat(first.data()).hasSize(2);
        assertThat(first.hasMore()).isTrue();
        PublicList<PublicAutomation> second = service.list(tenant, ACTOR,
                first.nextCursor(), 2);
        assertThat(second.data()).hasSize(1);
        assertThat(second.hasMore()).isFalse();
        assertThat(second.data().getFirst().id())
                .isNotIn(first.data().stream().map(PublicAutomation::id).toList());
        assertThatThrownBy(() -> service.list(tenant, ACTOR, "!!", 2))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("invalid_cursor"));
        String automationId = second.data().getFirst().id();
        clock.set(T0 + 3 * MINUTE + 1_000);
        scanner.tick(clock.get());
        PublicList<PublicAutomationRun> runs = service.listRuns(tenant, ACTOR,
                automationId, null, 2);
        assertThat(runs.data()).hasSize(2);
        assertThat(runs.hasMore()).isTrue();
        PublicList<PublicAutomationRun> rest = service.listRuns(tenant, ACTOR,
                automationId, runs.nextCursor(), 2);
        assertThat(rest.data()).hasSize(1);
        assertThat(rest.hasMore()).isFalse();
    }

    @Test
    void aScannerThatLostItsLeaseCannotMoveTheLedger() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        String id = automation.id();
        String key = "schedule:2026-06-01T10:01:00Z";
        AutomationLedgerStore.ScheduleRow row = ledger.findSchedule(tenant, id)
                .orElseThrow();
        long first = ledger.claim(tenant, id, "scanner-a", T0 + 60_000, T0);
        assertThat(first).isPositive();
        // Held: a second claimant is refused until the lease expires, and
        // the next holder takes a higher fence.
        assertThat(ledger.claim(tenant, id, "scanner-b", T0 + 60_000, T0 + 1))
                .isEqualTo(-1);
        long second = ledger.claim(tenant, id, "scanner-b", T0 + 120_000,
                T0 + 61_000);
        assertThat(second).isGreaterThan(first);
        long now = T0 + 61_000;
        // The stale holder records nothing and moves nothing.
        AutomationLedgerStore.OccurrenceRow stale = AutomationLedgerStore
                .OccurrenceRow.decision(row, key, T0 + MINUTE,
                        AutomationScanner.TRIGGER_SCHEDULED,
                        AutomationLedgerStore.OUTCOME_FIRING, null, first, now);
        assertThat(ledger.recordOccurrence(stale, "scanner-a")).isEmpty();
        assertThat(ledger.advanceWatermark(tenant, id, "scanner-a", first,
                T0 + MINUTE, now)).isFalse();
        assertThat(ledger.findSchedule(tenant, id).orElseThrow()
                .watermarkSlot()).isNull();
        // The holder records; only the holder settles.
        AutomationLedgerStore.OccurrenceRow held = ledger.recordOccurrence(
                AutomationLedgerStore.OccurrenceRow.decision(row, key,
                        T0 + MINUTE, AutomationScanner.TRIGGER_SCHEDULED,
                        AutomationLedgerStore.OUTCOME_FIRING, null, second, now),
                "scanner-b").orElseThrow();
        assertThat(held.fence()).isEqualTo(second);
        assertThat(ledger.settleOccurrence(tenant, id, key,
                AutomationLedgerStore.OUTCOME_FIRED, null, "scanner-a", first,
                now)).isFalse();
        assertThat(ledger.deferOccurrence(tenant, id, key, 1, now + 1_000,
                "lost", "scanner-a", first, now)).isFalse();
        assertThat(ledger.repinOccurrence(tenant, id, key, 7, "scanner-a",
                first, now)).isFalse();
        assertThat(ledger.settleOccurrence(tenant, id, key,
                AutomationLedgerStore.OUTCOME_FIRED, null, "scanner-b", second,
                now)).isTrue();
        // A late record of an existing decision answers that decision.
        assertThat(ledger.recordOccurrence(stale, "scanner-a"))
                .map(AutomationLedgerStore.OccurrenceRow::outcome)
                .contains(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(ledger.findOccurrence(tenant, id, key).orElseThrow()
                .definitionRevision()).isEqualTo(1);
    }

    @Test
    void backsOffALostAnswerAndRecordsUnknownPastTheBound() {
        // One slot ever: 10:01 on June 1st.
        PublicAutomation automation = define("1 10 1 6 *", "skip", "none", null,
                true);
        String id = automation.id();
        String key = "schedule:2026-06-01T10:01:00Z";
        fake.failNextFire = new DaemonException("answer lost");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow claim = ledger.findOccurrence(
                tenant, id, key).orElseThrow();
        assertThat(claim.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_FIRING);
        assertThat(claim.attempts()).isEqualTo(1);
        assertThat(claim.nextRetryAt()).isEqualTo(clock.get() + 2_000);
        assertThat(claim.lastError()).isEqualTo("answer lost");
        // Inside the backoff the claim is left alone.
        clock.addAndGet(1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(fake.fires()).isEqualTo(1);
        // Every later attempt fails too; the delay caps below five minutes.
        for (int attempt = 2; attempt < AutomationScanner.MAX_FIRE_ATTEMPTS;
                attempt++) {
            fake.failNextFire = new DaemonException("answer lost " + attempt);
            clock.addAndGet(301_000);
            assertThat(scanner.tick(clock.get())).isEqualTo(0);
            AutomationLedgerStore.OccurrenceRow again = ledger.findOccurrence(
                    tenant, id, key).orElseThrow();
            assertThat(again.outcome())
                    .isEqualTo(AutomationLedgerStore.OUTCOME_FIRING);
            assertThat(again.attempts()).isEqualTo(attempt);
            assertThat(again.nextRetryAt() - clock.get())
                    .isBetween(2_000L, 300_000L);
        }
        assertThat(ledger.countActive(tenant, id)).isEqualTo(1);
        fake.failNextFire = new DaemonException("answer lost, last");
        clock.addAndGet(301_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow given = ledger.findOccurrence(
                tenant, id, key).orElseThrow();
        assertThat(given.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_UNKNOWN);
        assertThat(given.reason())
                .isEqualTo(AutomationScanner.REASON_ANSWER_UNOBTAINABLE);
        assertThat(given.attempts()).isEqualTo(AutomationScanner.MAX_FIRE_ATTEMPTS - 1);
        assertThat(fake.fires()).isEqualTo(AutomationScanner.MAX_FIRE_ATTEMPTS);
        // Unknown is visible, counts against nothing, and is never re-driven.
        assertThat(ledger.countActive(tenant, id)).isZero();
        clock.addAndGet(301_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(fake.fires()).isEqualTo(AutomationScanner.MAX_FIRE_ATTEMPTS);
        assertThat(service.listRuns(tenant, ACTOR, id, null, 10).data())
                .extracting(PublicAutomationRun::outcome)
                .containsExactly("unknown");
    }

    @Test
    void redrivesTheLostAnswerOfADefinitionDisabledMeanwhile() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        String id = automation.id();
        fake.failNextFire = new DaemonException("answer lost");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(outcomes(id))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRING);
        // Disabled before the answer was obtained: the definition is no
        // longer armed, but the claim is still re-driven — and the
        // revision it moved to is learned and re-pinned on the way.
        assertThat(service.update(tenant, ACTOR, id, "disable",
                new AutomationDefinitionRequest(null, null, null, null, null,
                        null, null, null, null, false)).body()
                .definitionRevision()).isEqualTo(2);
        clock.set(T0 + MINUTE + 11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(outcomes(id))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(ledger.findOccurrence(tenant, id,
                "schedule:2026-06-01T10:01:00Z").orElseThrow()
                .definitionRevision()).isEqualTo(2);
        assertThat(fake.operations).filteredOn(operation ->
                "fire_run".equals(operation.get("kind")))
                .extracting(operation -> operation.get("definitionRevision"))
                .containsExactly(1L, 1L, 2L);
        // Disabled: no later slot is derived.
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(outcomes(id).values().stream().mapToInt(List::size).sum())
                .isEqualTo(1);
    }

    @Test
    void repinsAClaimToTheRevisionTheMirrorLagged() throws Exception {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        String id = automation.id();
        String key = "schedule:2026-06-01T10:01:00Z";
        long now = T0 + MINUTE + 1_000;
        AutomationLedgerStore.ScheduleRow row = ledger.findSchedule(tenant, id)
                .orElseThrow();
        long fence = ledger.claim(tenant, id, "scanner-a", now + 60_000, now);
        AutomationLedgerStore.OccurrenceRow claim = ledger.recordOccurrence(
                AutomationLedgerStore.OccurrenceRow.decision(row, key,
                        T0 + MINUTE, AutomationScanner.TRIGGER_SCHEDULED,
                        AutomationLedgerStore.OUTCOME_FIRING, null, fence, now),
                "scanner-a").orElseThrow();
        // Between the claim and the fire another instance revised the
        // definition: the Harness and the Session store hold revision 2,
        // the mirror still reads revision 1.
        Map<String, Object> moved = fake.run(sessionId, Map.of("operationId",
                UUID.randomUUID().toString(), "kind", "define_schedule",
                "scheduleId", id, "definition", Map.of("goal", "Moved")));
        Map<?, ?> schedule = (Map<?, ?>) moved.get("schedule");
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("scheduleId", id);
        record.put("definitionRevision", 2L);
        record.put("definitionDigest", schedule.get("definitionDigest"));
        record.put("goal", "Moved");
        record.put("cron", "* * * * *");
        record.put("timezone", "UTC");
        record.put("sessionMode", "persistent");
        record.put("overlap", "skip");
        record.put("catchUp", "none");
        record.put("catchUpLimit", null);
        record.put("enabled", true);
        record.put("run", Map.of("state", "admitted"));
        byte[] bytes = mapper.writeValueAsBytes(record);
        String scope = ManagedSessionStore.sessionScopeKey(tenant, sessionId);
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, created_at)"
                        + " VALUES (?, ?, ?, ?, 'schedule-rev-2',"
                        + " 'managed-schedule', 1, ?, ?, 'MYSQL_INLINE', ?,"
                        + " 'publish', 'REFERENCED', ?)",
                scope, tenant, WORKSPACE, sessionId, bytes.length,
                AutomationLedgerStore.sha256(new String(bytes,
                        StandardCharsets.UTF_8)), bytes,
                new java.sql.Timestamp(now));
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, definition_revision,"
                        + " created_at)"
                        + " VALUES (?, ?, ?, ?, ?, 'schedule', ?, ?, 2,"
                        + " 'schedule-rev-2', 'schedule', 'running', 2, ?)",
                scope, ManagedExtensionProjection.recordKey(sessionId,
                        "schedule", id), tenant, WORKSPACE, sessionId, id,
                "0".repeat(64), now);
        assertThat(scanner.fire(row, claim, "scanner-a", fence, now)).isTrue();
        ledger.release(tenant, id, "scanner-a", fence, now);
        AutomationLedgerStore.ScheduleRow refreshed = ledger.findSchedule(
                tenant, id).orElseThrow();
        assertThat(refreshed.definitionRevision()).isEqualTo(2);
        assertThat(refreshed.goal()).isEqualTo("Moved");
        AutomationLedgerStore.OccurrenceRow fired = ledger.findOccurrence(
                tenant, id, key).orElseThrow();
        assertThat(fired.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(fired.definitionRevision()).isEqualTo(2);
        assertThat(fake.operations).filteredOn(operation ->
                "fire_run".equals(operation.get("kind")))
                .extracting(operation -> operation.get("definitionRevision"))
                .containsExactly(1L, 2L);
        // The lag was transient; a definition that moved again under the
        // second try is skipped, not chased.
        String later = "schedule:2026-06-01T10:02:00Z";
        long then = T0 + 2 * MINUTE + 1_000;
        long again = ledger.claim(tenant, id, "scanner-a", then + 60_000, then);
        AutomationLedgerStore.OccurrenceRow second = ledger.recordOccurrence(
                AutomationLedgerStore.OccurrenceRow.decision(
                        ledger.findSchedule(tenant, id).orElseThrow(), later,
                        T0 + 2 * MINUTE, AutomationScanner.TRIGGER_SCHEDULED,
                        AutomationLedgerStore.OUTCOME_FIRING, null, again,
                        then), "scanner-a").orElseThrow();
        fake.run(sessionId, Map.of("operationId",
                UUID.randomUUID().toString(), "kind", "define_schedule",
                "scheduleId", id, "definition", Map.of("goal", "Moved twice")));
        assertThat(scanner.fire(refreshed, second, "scanner-a", again, then))
                .isFalse();
        ledger.release(tenant, id, "scanner-a", again, then);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, id, later).orElseThrow();
        assertThat(skipped.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason()).isEqualTo(AutomationScanner.REASON_REVISION_STALE);
    }

    @Test
    void replayIsScopedToTheActorThatIssuedTheKey() {
        AutomationDefinitionRequest request = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        var created = service.create(tenant, ACTOR, "shared-key", request);
        assertThat(created.replayed()).isFalse();
        // Another actor presenting the same key and body is not handed the
        // first actor's answer.
        assertThatThrownBy(() -> service.create(tenant, READER, "shared-key",
                request))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode()).isEqualTo("idempotency_conflict");
                });
        assertThat(service.create(tenant, ACTOR, "shared-key", request)
                .replayed()).isTrue();
        assertThat(ledger.findCommand(tenant, "shared-key").orElseThrow()
                .actorId()).isEqualTo(ACTOR);
    }

    @Test
    void aMutationsRetryAfterALostAnswerAnswersTheOriginalResult()
            throws Exception {
        AutomationDefinitionRequest requestA = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        String keyA = "lost-" + UUID.randomUUID();
        String automationId = ManagedAutomationService.scheduleIdFor(tenant,
                keyA);
        // The Harness commits revision 1, but the answer never arrives:
        // the pre-relay claim is the only ledger trace, and no mirror.
        fake.failAfterNextDefineCommit = new DaemonException("connection lost");
        assertThatThrownBy(() -> service.create(tenant, ACTOR, keyA, requestA))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(error.getCode())
                            .isEqualTo("automation_operation_unknown");
                });
        AutomationLedgerStore.CommandRow claim = ledger
                .findCommand(tenant, keyA).orElseThrow();
        assertThat(claim.resultJson()).isEmpty();
        assertThat(ledger.findSchedule(tenant, automationId)).isEmpty();
        // The committed record reaches the record store out of band (the
        // projection of the Session store), and the next scanner tick
        // refreshes the mirror from it — the repair arm of the lost answer.
        Map<?, ?> committed = fake.scheduleOf(sessionId, automationId);
        assertThat(committed).isNotNull();
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("scheduleId", automationId);
        record.put("definitionRevision", 1L);
        record.put("definitionDigest", committed.get("definitionDigest"));
        record.put("goal", "Goal");
        record.put("cron", "0 2 * * *");
        record.put("timezone", "UTC");
        record.put("sessionMode", "persistent");
        record.put("overlap", "skip");
        record.put("catchUp", "none");
        record.put("catchUpLimit", null);
        record.put("enabled", true);
        record.put("run", Map.of("state", "admitted"));
        byte[] bytes = mapper.writeValueAsBytes(record);
        String scope = ManagedSessionStore.sessionScopeKey(tenant, sessionId);
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, created_at)"
                        + " VALUES (?, ?, ?, ?, 'schedule-rev-1',"
                        + " 'managed-schedule', 1, ?, ?, 'MYSQL_INLINE', ?,"
                        + " 'publish', 'REFERENCED', ?)",
                scope, tenant, WORKSPACE, sessionId, bytes.length,
                AutomationLedgerStore.sha256(new String(bytes,
                        StandardCharsets.UTF_8)), bytes,
                new java.sql.Timestamp(T0));
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, definition_revision,"
                        + " created_at)"
                        + " VALUES (?, ?, ?, ?, ?, 'schedule', ?, ?, 1,"
                        + " 'schedule-rev-1', 'schedule', 'running', 1, ?)",
                scope, ManagedExtensionProjection.recordKey(sessionId,
                        "schedule", automationId), tenant, WORKSPACE,
                sessionId, automationId, "0".repeat(64), T0);
        scanner.tick(clock.get());
        assertThat(ledger.findSchedule(tenant, automationId).orElseThrow()
                .definitionRevision()).isEqualTo(1);
        // Another request moves the same definition to revision 2.
        AutomationDefinitionRequest requestB = new AutomationDefinitionRequest(
                null, null, "30 3 * * *", null, null, null, null, null, null,
                null);
        var revised = service.update(tenant, ACTOR, automationId,
                "key-" + UUID.randomUUID(), requestB);
        assertThat(revised.body().definitionRevision()).isEqualTo(2);
        // The retry of the same key re-sends the same derived operationId,
        // so the Harness replays revision 1 rather than committing A over B.
        var retried = service.create(tenant, ACTOR, keyA, requestA);
        assertThat(retried.replayed()).isTrue();
        assertThat(retried.body().definitionRevision()).isEqualTo(1);
        assertThat(retried.body().cron()).isEqualTo("0 2 * * *");
        // The mirror kept revision 2 instead of following the replay.
        ScheduleRow mirror = ledger.findSchedule(tenant, automationId)
                .orElseThrow();
        assertThat(mirror.definitionRevision()).isEqualTo(2);
        assertThat(mirror.definitionDigest()).isEqualTo(revised.body().digest());
        // The remembered row answers revision 1 again, without a third relay.
        int relays = fake.operations.size();
        var replayed = service.create(tenant, ACTOR, keyA, requestA);
        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.body().definitionRevision()).isEqualTo(1);
        assertThat(fake.operations).hasSize(relays);
        // The first create and its retry carried the same derived
        // operationId; the update in between carried its own.
        List<Map<String, Object>> defines = fake.operations.stream()
                .filter(operation -> "define_schedule"
                        .equals(operation.get("kind")))
                .toList();
        assertThat(defines).hasSize(3);
        assertThat(defines.get(0).get("operationId"))
                .isEqualTo(defines.get(2).get("operationId"))
                .isNotEqualTo(defines.get(1).get("operationId"));
    }

    @Test
    void aRetiresRetryAfterALostAnswerAnswersTheCancelItCommitted() {
        PublicAutomation created = define("0 2 * * *", "skip", "none", null,
                true);
        String keyR = "lost-" + UUID.randomUUID();
        fake.failAfterNextRetireCommit = new DaemonException("connection lost");
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, created.id(), keyR))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        // The answer never arrived: the mirror still reads the chain live,
        // and the pre-relay claim is the request's own unanswered binding.
        assertThat(
                ledger.findSchedule(tenant, created.id()).orElseThrow().state())
                .isEqualTo(AutomationLedgerStore.STATE_LIVE);
        assertThat(ledger.findCommand(tenant, keyR).orElseThrow().resultJson())
                .isEmpty();
        // The retry re-sends the same derived operationId and answers the
        // cancel revision the first attempt committed.
        var retried = service.retire(tenant, ACTOR, created.id(), keyR);
        assertThat(retried.replayed()).isTrue();
        assertThat(retried.body().state()).isEqualTo("retired");
        assertThat(
                ledger.findSchedule(tenant, created.id()).orElseThrow().state())
                .isEqualTo(AutomationLedgerStore.STATE_RETIRED);
        var replayed = service.retire(tenant, ACTOR, created.id(), keyR);
        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.body().state()).isEqualTo("retired");
        // Two relays, one derived operationId, no further ones.
        List<Map<String, Object>> retires = fake.operations.stream()
                .filter(operation -> "retire_schedule"
                        .equals(operation.get("kind")))
                .toList();
        assertThat(retires).hasSize(2);
        assertThat(retires.get(0).get("operationId"))
                .isEqualTo(retires.get(1).get("operationId"));
    }

    @Test
    void aNoOpMutationsRetryAfterALostAnswerAnswersTheHonoredResult() {
        AutomationDefinitionRequest requestA = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        var created = service.create(tenant, ACTOR, "key-" + UUID.randomUUID(),
                requestA);
        String automationId = created.body().id();
        // A new key carrying identical content is honored without a
        // revision; its answer is lost after the honor committed.
        String keyU = "lost-" + UUID.randomUUID();
        AutomationDefinitionRequest requestU = new AutomationDefinitionRequest(
                null, null, "0 2 * * *", null, null, null, null, null, null,
                null);
        fake.failAfterNextDefineCommit = new DaemonException("connection lost");
        assertThatThrownBy(
                () -> service.update(tenant, ACTOR, automationId, keyU,
                        requestU))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        // The pre-relay claim survived the lost answer, still unanswered.
        assertThat(ledger.findCommand(tenant, keyU).orElseThrow().resultJson())
                .isEmpty();
        // Another request moves the definition to revision 2; the retry of
        // the no-op honor answers the revision-1 result it committed.
        AutomationDefinitionRequest requestB = new AutomationDefinitionRequest(
                null, null, "30 3 * * *", null, null, null, null, null, null,
                null);
        var revised = service.update(tenant, ACTOR, automationId,
                "key-" + UUID.randomUUID(), requestB);
        assertThat(revised.body().definitionRevision()).isEqualTo(2);
        var retried = service.update(tenant, ACTOR, automationId, keyU,
                requestU);
        assertThat(retried.replayed()).isTrue();
        assertThat(retried.body().definitionRevision()).isEqualTo(1);
        assertThat(retried.body().cron()).isEqualTo("0 2 * * *");
        ScheduleRow mirror = ledger.findSchedule(tenant, automationId)
                .orElseThrow();
        assertThat(mirror.definitionRevision()).isEqualTo(2);
        assertThat(mirror.definitionDigest())
                .isEqualTo(revised.body().digest());
        // The remembered row replays without another relay.
        int relays = fake.operations.size();
        var replayed = service.update(tenant, ACTOR, automationId, keyU,
                requestU);
        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.body().definitionRevision()).isEqualTo(1);
        assertThat(fake.operations).hasSize(relays);
    }

    @Test
    void aRetireUnderAnotherTargetsKeyConflictsAndTouchesNothing() {
        PublicAutomation first = define("0 2 * * *", "skip", "none", null,
                true);
        PublicAutomation second = define("15 3 * * *", "skip", "none", null,
                true);
        String key = "lost-" + UUID.randomUUID();
        fake.failAfterNextRetireCommit = new DaemonException("connection lost");
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, first.id(), key))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        // The same key against another target is a different request: the
        // first attempt's claim refuses it at the identity layer, and the
        // ledger never retires that definition's mirror.
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, second.id(), key))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
        assertThat(ledger.findSchedule(tenant, second.id()).orElseThrow()
                .state()).isEqualTo(AutomationLedgerStore.STATE_LIVE);
        assertThat(fake.scheduleOf(sessionId, second.id()).get("state"))
                .isEqualTo("admitted");
        // The honest retry still answers the first one's cancel.
        var retried = service.retire(tenant, ACTOR, first.id(), key);
        assertThat(retried.replayed()).isTrue();
        assertThat(retried.body().state()).isEqualTo("retired");
    }

    @Test
    void listsOnlyTheDefinitionsTheActorMayReadWithoutLeakingACursor() {
        // A second Workspace the reader has no grant in, holding the three
        // newest definitions.
        String hidden = "ws-automation-private";
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, 'storage', 'Private', ?, ?,"
                        + " 'ACTIVE')",
                tenant, hidden,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)",
                tenant, hidden, ACTOR.getBytes(StandardCharsets.UTF_8));
        String privateSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Private",
                Map.of(), List.of(), new WorkspaceSelection(hidden, "."))
                .sessionId();
        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                privateSession);
        clock.set(T0);
        String visible = define("* * * * *", "allow", "none", null, true).id();
        List<String> hiddenIds = new ArrayList<>();
        for (int index = 1; index <= 3; index++) {
            clock.set(T0 + index);
            hiddenIds.add(service.create(tenant, ACTOR, "private-" + index,
                    new AutomationDefinitionRequest(privateSession, "Goal",
                            "* * * * *", "UTC", "Run it.", null, null, null,
                            null, null)).body().id());
        }
        // The reader's first page is the one readable definition: not an
        // empty page that claims more, and no cursor naming a hidden id.
        PublicList<PublicAutomation> page = service.list(tenant, READER, null,
                2);
        assertThat(page.data()).extracting(PublicAutomation::id)
                .containsExactly(visible);
        assertThat(page.hasMore()).isFalse();
        assertThat(page.nextCursor()).isNull();
        // The owner pages through all four, newest first, in stable pages.
        PublicList<PublicAutomation> owner = service.list(tenant, ACTOR, null,
                3);
        assertThat(owner.data()).extracting(PublicAutomation::id)
                .containsExactly(hiddenIds.get(2), hiddenIds.get(1),
                        hiddenIds.get(0));
        assertThat(owner.hasMore()).isTrue();
        assertThat(service.list(tenant, ACTOR, owner.nextCursor(), 3).data())
                .extracting(PublicAutomation::id).containsExactly(visible);
        // No grant at all: an empty list, not a page that claims more.
        PublicList<PublicAutomation> stranger = service.list(tenant,
                "stranger", null, 2);
        assertThat(stranger.data()).isEmpty();
        assertThat(stranger.hasMore()).isFalse();
        for (String hiddenId : hiddenIds) {
            assertThatThrownBy(() -> service.get(tenant, READER, hiddenId))
                    .isInstanceOfSatisfying(ApiException.class, error ->
                            assertThat(error.getCode())
                                    .isEqualTo("automation_not_found"));
        }
    }

    @Test
    void aManualRunWaitsForTheScannersLeaseAndAnswersBusyWhenItStays() {
        PublicAutomation automation = define("0 2 * * *", "skip", "none", null,
                true);
        String id = automation.id();
        long fence = ledger.claim(tenant, id, "scanner-b", clock.get() + 60_000,
                clock.get());
        assertThat(fence).isPositive();
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "busy-1"))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode()).isEqualTo("automation_busy");
                });
        assertThat(fake.fires()).isZero();
        assertThat(ledger.findOccurrence(tenant, id, "manual:busy-1")).isEmpty();
        ledger.release(tenant, id, "scanner-b", fence, clock.get());
        PublicAutomationRun run = service.run(tenant, ACTOR, id, "busy-1")
                .body();
        assertThat(run.outcome()).isEqualTo("fired");
        assertThat(fake.fires()).isEqualTo(1);
        // The run released the lease: the scanner claims again.
        assertThat(ledger.findSchedule(tenant, id).orElseThrow().leaseOwner())
                .isNull();
        assertThat(ledger.claim(tenant, id, "scanner-b", clock.get() + 60_000,
                clock.get())).isGreaterThan(fence);
    }

    @Test
    void aManualRunWhoseAnswerWasLostIsReDrivenAndThenReplayed() {
        PublicAutomation automation = define("0 2 * * *", "allow", "none", null,
                true);
        String id = automation.id();
        fake.failNextFire = new DaemonException("connection lost");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "lost-1"))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(error.getCode())
                            .isEqualTo("automation_operation_unknown");
                });
        AutomationLedgerStore.OccurrenceRow claim = ledger.findOccurrence(
                tenant, id, "manual:lost-1").orElseThrow();
        assertThat(claim.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_FIRING);
        assertThat(claim.attempts()).isEqualTo(1);
        assertThat(claim.lastError()).isEqualTo("connection lost");
        assertThat(claim.trigger()).isEqualTo(AutomationScanner.TRIGGER_MANUAL);
        // The same key asked again re-drives the claim at once: the caller
        // is answered what the Harness now says, under the same run id.
        var asked = service.run(tenant, ACTOR, id, "lost-1");
        assertThat(asked.replayed()).isTrue();
        assertThat(asked.body().outcome()).isEqualTo("fired");
        assertThat(asked.body().id()).isEqualTo(claim.runId());
        assertThat(fake.fires()).isEqualTo(2);
        // A claim nobody asks about again is re-driven by the scanner.
        fake.failNextFire = new DaemonException("connection lost");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "lost-2"))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        clock.addAndGet(11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        var replayed = service.run(tenant, ACTOR, id, "lost-2");
        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.body().outcome()).isEqualTo("fired");
        assertThat(fake.fires()).isEqualTo(4);
        // A Harness that is not configured answers unavailable and leaves
        // the claim for the scanner too.
        connector.unavailable = true;
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "lost-3"))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_unavailable"));
        connector.unavailable = false;
        assertThat(ledger.findOccurrence(tenant, id, "manual:lost-3")
                .orElseThrow().outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRING);
        assertThat(ledger.findSchedule(tenant, id).orElseThrow().leaseOwner())
                .isNull();
    }

    @Test
    void theScannerRunsOnADedicatedScheduler() throws Exception {
        assertThat(applicationContext.containsBean("managedAutomationScheduler"))
                .isTrue();
        assertThat(applicationContext.getBean("managedAutomationScheduler"))
                .isNotSameAs(applicationContext.getBean("taskScheduler"));
        var scheduled = AutomationScanner.class.getMethod("scan")
                .getAnnotation(org.springframework.scheduling.annotation.Scheduled.class);
        assertThat(scheduled.scheduler())
                .isEqualTo("managedAutomationScheduler");
    }

    @Test
    void anOpenPublicTurnSuppressesFiresUntilItEnds() {
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, created_at, updated_at, completed_at)"
                        + " VALUES (?, ?, 'turn-open', 'prompt-open', '[]',"
                        + " 'digest', 'RUNNING', 1000, 1000, NULL)",
                tenant, sessionId);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(fake.fires()).isZero();
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_SKIPPED);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:01:00Z")
                .orElseThrow();
        assertThat(skipped.reason())
                .isEqualTo(AutomationScanner.REASON_OVERLAP);
        // The public Turn ends: the next slot fires again.
        jdbc.update("UPDATE managed_agent_turn SET status = 'COMPLETED',"
                        + " completed_at = 2000 WHERE tenant_id = ?"
                        + " AND turn_id = 'turn-open'",
                tenant);
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.firedOccurrences())
                .containsExactly("schedule:2026-06-01T10:02:00Z");
    }

    @Test
    void aDefinitiveRefusalSettlesTheOccurrenceSkippedNotUnknown() {
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        fake.failNextFire = AutomationHarnessFake.refusal(409,
                "automation_mode_disabled");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow row = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:01:00Z")
                .orElseThrow();
        assertThat(row.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(row.reason()).isEqualTo("automation_mode_disabled");
        assertThat(row.attempts()).isZero();
        // The obtained 4xx is not re-driven; the next slot fires normally.
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:02:00Z");
    }

    @Test
    void aTransientStoreFaultKeepsTheClaimFiringForRedrive() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        // A store-fault 503 from the route is infrastructure, not a
        // refusal: the claim waits the fault out instead of settling
        // skipped, which no redrive would ever revisit.
        fake.failNextFire = AutomationHarnessFake.refusal(503,
                "automation_operation_failed");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRING);
        clock.set(T0 + MINUTE + 11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:01:00Z");
    }

    @Test
    void aCrossKindRetryAfterTheCommandRowWasLostConflicts() {
        String key = "key-" + UUID.randomUUID();
        PublicAutomation automation = service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal",
                        "0 2 * * *", "UTC", "Run it.", null, "skip", "none",
                        null, true)).body();
        // The crash window the funnel's journal closes: the control plane
        // lost its command row after the Harness committed the create.
        jdbc.update("DELETE FROM qwen_managed_automation_command"
                + " WHERE tenant_id = ? AND idempotency_key = ?", tenant, key);
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, automation.id(), key))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("automation_operation_conflict");
                });
        ScheduleRow mirror = ledger.findSchedule(tenant, automation.id())
                .orElseThrow();
        assertThat(mirror.state()).isEqualTo(AutomationLedgerStore.STATE_LIVE);
        assertThat(mirror.definitionRevision()).isEqualTo(1L);
    }

    @Test
    void aCrossSessionCreateReusingTheKeyConflictsAfterTheCommandRowWasLost() {
        String key = "key-" + UUID.randomUUID();
        PublicAutomation first = service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal",
                        "0 2 * * *", "UTC", "Run it.", null, "skip", "none",
                        null, true)).body();
        String otherSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Other",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        // The crash window: the command row is gone while the durable
        // mirror still proves the identity landed — on the first Session.
        jdbc.update("DELETE FROM qwen_managed_automation_command"
                + " WHERE tenant_id = ? AND idempotency_key = ?", tenant, key);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, "skip", "none",
                        null, true)))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("automation_operation_conflict");
                });
        // Nothing relayed to the other Session's Harness, and the mirror
        // still names the first Session — no shadowed second definition.
        assertThat(fake.scheduleOf(otherSession, first.id())).isNull();
        ScheduleRow mirror = ledger.findSchedule(tenant, first.id())
                .orElseThrow();
        assertThat(mirror.sessionId()).isEqualTo(sessionId);
    }

    @Test
    void aLostAnswerCreateStillBindsTheKeySoAnotherRequestConflicts() {
        String keyA = "lost-" + UUID.randomUUID();
        String scheduleId = ManagedAutomationService.scheduleIdFor(tenant,
                keyA);
        AutomationDefinitionRequest requestA = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        // The post-commit answer is lost: the claim is durable, mirror and
        // answer are not — the window a mirror check could never cover.
        fake.failAfterNextDefineCommit = new DaemonException("connection lost");
        assertThatThrownBy(() -> service.create(tenant, ACTOR, keyA, requestA))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        assertThat(ledger.findSchedule(tenant, scheduleId)).isEmpty();
        assertThat(fake.scheduleOf(sessionId, scheduleId)).isNotNull();
        // A different request under the same key meets the claim, not a
        // second commit — whatever Session it names.
        String otherSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Other",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, keyA,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, null, null,
                        null, null)))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
        assertThat(fake.scheduleOf(otherSession, scheduleId)).isNull();
        // The request that owns the claim redrives: the Harness replays
        // its committed revision, the mirror and the answer follow.
        var retried = service.create(tenant, ACTOR, keyA, requestA);
        assertThat(retried.replayed()).isTrue();
        assertThat(retried.body().id()).isEqualTo(scheduleId);
        assertThat(ledger.findSchedule(tenant, scheduleId).orElseThrow()
                .sessionId()).isEqualTo(sessionId);
        assertThat(ledger.findCommand(tenant, keyA).orElseThrow().resultJson())
                .isNotEmpty();
    }

    @Test
    void aConcurrentClaimUnderTheSameKeyConflictsBeforeAnySideEffect() {
        String key = "race-" + UUID.randomUUID();
        String scheduleId = ManagedAutomationService.scheduleIdFor(tenant,
                key);
        // A foreign request's claim already holds the key mid-flight:
        // this one never reaches the Harness and mirrors nothing.
        ledger.claimCommand(new AutomationLedgerStore.CommandRow(tenant, key,
                ACTOR, "deadbeef", scheduleId, ""), clock.get());
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal",
                        "0 2 * * *", "UTC", "Run it.", null, null, null, null,
                        null)))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
        assertThat(fake.operations).noneMatch(operation -> "define_schedule"
                .equals(operation.get("kind")));
        assertThat(ledger.findSchedule(tenant, scheduleId)).isEmpty();
    }

    @Test
    void anOwnersSettleIsGuardedAtIdentityAndCompletion() {
        String key = "claim-" + UUID.randomUUID();
        String scheduleId = ManagedAutomationService.scheduleIdFor(tenant,
                key);
        ledger.claimCommand(new AutomationLedgerStore.CommandRow(tenant, key,
                ACTOR, "digest-c", scheduleId, ""), clock.get());
        assertThat(ledger.settleCommand(tenant, key, "digest-c", ACTOR,
                "{\"id\":\"" + scheduleId + "\"}")).isTrue();
        // A late different request writes nothing into this row, and the
        // completed result itself is frozen.
        assertThat(ledger.settleCommand(tenant, key, "digest-u", ACTOR,
                "{\"id\":\"other\"}")).isFalse();
        assertThat(ledger.settleCommand(tenant, key, "digest-c", ACTOR,
                "{\"id\":\"again\"}")).isFalse();
        assertThat(ledger.findCommand(tenant, key).orElseThrow().resultJson())
                .contains(scheduleId)
                .doesNotContain("other");
    }

    @Test
    void aDefinitiveRefusalReleasesTheClaimSoAFixedRetrySucceeds() {
        String key = "fix-" + UUID.randomUUID();
        // The mode gate refuses per_run: a definitive 4xx, nothing
        // committed on the Harness.
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal",
                        "0 2 * * *", "UTC", "Run it.", "per_run", null, null,
                        null, true)))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("automation_mode_disabled");
                });
        // The refusal committed nothing, so the claim went back: the key
        // is the caller's again, not a conflict against its own request.
        assertThat(ledger.findCommand(tenant, key)).isEmpty();
        var fixed = service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal",
                        "0 2 * * *", "UTC", "Run it.", null, null, null, null,
                        true));
        assertThat(fixed.replayed()).isFalse();
        assertThat(fixed.body().id())
                .isEqualTo(ManagedAutomationService.scheduleIdFor(tenant,
                        key));
    }

    @Test
    void aProoflessRefusalKeepsTheClaimAndBlocksAnotherRequest() {
        String key = "read-" + UUID.randomUUID();
        String scheduleId = ManagedAutomationService.scheduleIdFor(tenant,
                key);
        AutomationDefinitionRequest requestA = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        // invalid_automation_operation is also the code a broken read of
        // committed data produces: it proves nothing about the operation,
        // so the claim must outlive it.
        fake.failNextMutation = AutomationHarnessFake.refusal(400,
                "invalid_automation_operation");
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key, requestA))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(error.getCode())
                            .isEqualTo("invalid_automation_operation");
                });
        assertThat(ledger.findCommand(tenant, key).orElseThrow().resultJson())
                .isEmpty();
        // Another request under the key meets the binding, not a relay.
        String otherSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Other",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, null, null,
                        null, null)))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
        assertThat(fake.scheduleOf(otherSession, scheduleId)).isNull();
        // The claim's owner re-drives: this time the relay commits, and
        // the claim settles its own answer.
        var retried = service.create(tenant, ACTOR, key, requestA);
        assertThat(retried.replayed()).isFalse();
        assertThat(retried.body().id()).isEqualTo(scheduleId);
        assertThat(ledger.findCommand(tenant, key).orElseThrow().resultJson())
                .isNotEmpty();
        assertThat(ledger.findSchedule(tenant, scheduleId).orElseThrow()
                .sessionId()).isEqualTo(sessionId);
    }

    @Test
    void aManualRunsDefinitiveRefusalAnswers409AndItsRetryTheDecision() {
        PublicAutomation automation = define("0 2 * * *", "allow", "none",
                null, true);
        fake.failNextFire = AutomationHarnessFake.refusal(409,
                "automation_mode_disabled");
        assertThatThrownBy(
                () -> service.run(tenant, ACTOR, automation.id(), "manual-def"))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("automation_run_skipped");
                    assertThat(error.getMessage())
                            .contains("automation_mode_disabled");
                });
        // The same key is answered the recorded decision, without a second
        // fire — the refusal was obtained, not lost.
        var asked = service.run(tenant, ACTOR, automation.id(), "manual-def");
        assertThat(asked.replayed()).isTrue();
        assertThat(asked.body().outcome()).isEqualTo("skipped");
        assertThat(asked.body().reason()).isEqualTo("automation_mode_disabled");
        assertThat(fake.fires()).isEqualTo(1);
    }

    @Test
    void anUpdatesKeyUsedWithAnotherSessionIdConflicts() {
        PublicAutomation automation = define("0 2 * * *", "skip", "none",
                null, true);
        String key = "usid-" + UUID.randomUUID();
        AutomationDefinitionRequest first = new AutomationDefinitionRequest(
                sessionId, null, "30 3 * * *", null, null, null, null, null,
                null, null);
        var revised = service.update(tenant, ACTOR, automation.id(), key,
                first);
        assertThat(revised.body().definitionRevision()).isEqualTo(2);
        // The same replay lands when the body names the same Session.
        assertThat(service.update(tenant, ACTOR, automation.id(), key, first)
                .replayed()).isTrue();
        // The same key used with another session_id is not that body.
        AutomationDefinitionRequest moved = new AutomationDefinitionRequest(
                "other-session", null, "30 3 * * *", null, null, null, null,
                null, null, null);
        assertThatThrownBy(
                () -> service.update(tenant, ACTOR, automation.id(), key,
                        moved))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
    }

    @Test
    void aUnicodeDigitCronIsRefusedTheContractWay() {
        AutomationDefinitionRequest unicode = new AutomationDefinitionRequest(
                sessionId, "Goal", "٣ * * * *", "UTC", "Run it.", null,
                null, null, null, null);
        assertThatThrownBy(() -> service.create(tenant, ACTOR,
                "key-" + UUID.randomUUID(), unicode))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(error.getCode())
                            .isEqualTo("invalid_automation");
                });
        assertThat(fake.operations).isEmpty();
    }

    @Test
    void enablementStaysExplicitAtEveryGate() {
        // The scanner's own gate: disabled, a tick does nothing at all.
        define("* * * * *", "allow", "none", null, true);
        String automationId = ledger.listReadableSchedules(tenant, ACTOR, null,
                1).rows().getFirst().scheduleId();
        settings.setEnabled(false);
        clock.set(T0 + MINUTE + 1_000);
        scanner.scan();
        assertThat(fake.fires()).isZero();
        assertThat(ledger.findSchedule(tenant, automationId).orElseThrow()
                .watermarkSlot()).isNull();
        // The mutation gate refuses writes while disabled.
        AutomationDefinitionRequest body = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        assertThatThrownBy(() -> service.create(tenant, ACTOR,
                "key-" + UUID.randomUUID(), body))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("automation_unavailable");
                });
        settings.setEnabled(true);
        // And the Session store arm is its own gate.
        var offStore = new ManagedAutomationService(ledger, agentStore,
                workspaces, connector, scanner, digests, mapper, settings,
                false, clock::get);
        assertThatThrownBy(() -> offStore.create(tenant, ACTOR,
                "key-" + UUID.randomUUID(), body))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("automation_unavailable");
                });
    }

    @Test
    void aFireReDrivenAfterTheDefinitionRetiredAnswersTheCommittedRun() {
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        fake.failAfterNextFireCommit = new DaemonException("connection lost");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        // The claim committed at the Harness, its answer lost; the
        // definition retires meanwhile: the re-drive meets the committed
        // run, replayed, never a retired refusal.
        service.retire(tenant, ACTOR, automation.id(),
                "key-" + UUID.randomUUID());
        clock.addAndGet(11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        AutomationLedgerStore.OccurrenceRow row = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:01:00Z")
                .orElseThrow();
        assertThat(row.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(fake.fires()).isEqualTo(2);
    }

    /** The connector the control plane sees: only the automation verb answers. */
    static final class FakeConnector implements HarnessConnector {
        private final AutomationHarnessFake fake;
        /** A test seam: the Harness is not configured. */
        volatile boolean unavailable;

        FakeConnector(AutomationHarnessFake fake) {
            this.fake = fake;
        }

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public Map<String, Object> runAutomationOperation(String tenantId,
                String sessionId, Map<String, Object> body) {
            if (unavailable) {
                throw new UnsupportedOperationException();
            }
            return fake.run(sessionId, body);
        }

        @Override
        public Attachment createOrLoad(String tenantId, String sessionId,
                boolean loadExisting) {
            throw new UnsupportedOperationException();
        }

        @Override
        public Admission submit(String tenantId, String sessionId,
                String promptId, List<Map<String, Object>> input,
                String payloadDigest) {
            throw new UnsupportedOperationException();
        }

        @Override
        public SourceStream stream(String tenantId, String sessionId,
                long lastEventId, String eventEpoch) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void cancel(String tenantId, String sessionId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void rename(String tenantId, String sessionId, String title) {
            throw new UnsupportedOperationException();
        }

        @Override
        public String closeSession(String tenantId, String sessionId) {
            throw new UnsupportedOperationException();
        }
    }
}
