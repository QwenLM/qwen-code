package com.alibaba.qwen.code.managedagent.automation;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.AutomationHarnessFake;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AutomationDefinitionRequest;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicAutomation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicAutomationRun;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.OccurrenceView;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.TextNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
    private @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc;

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
        for (String previousTenant : jdbc.queryForList("SELECT DISTINCT tenant_id FROM ma_session", String.class)) {
            if (previousTenant.startsWith("tenant-automation-")) {
                jdbc.update("DELETE FROM ma_schedule_occurrence WHERE tenant_id=?", previousTenant);
                jdbc.update("DELETE FROM ma_schedule WHERE tenant_id=?", previousTenant);
                jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind='SESSION_RECORD' AND tenant_id=?", previousTenant);
                jdbc.update("DELETE FROM ma_session_record WHERE record_kind='DOMAIN' AND tenant_id=?", previousTenant);
                jdbc.update("DELETE FROM ma_request_receipt WHERE namespace='AUTOMATION' AND tenant_id=?", previousTenant);
            }
        }
        tenant = "tenant-automation-" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, 'storage', 'Workspace', ?, ?,"
                        + " 'ACTIVE')",
                tenant, WORKSPACE,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')",
                tenant, WORKSPACE, ACTOR.getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'READER')",
                tenant, WORKSPACE, READER.getBytes(StandardCharsets.UTF_8));
        sessionId = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Automation",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, sessionId);
        clock = new AtomicLong(T0);
        fake = new AutomationHarnessFake((session, schedule) ->
                AutomationHarnessFake.projectSchedule(jdbc, tenant, session, schedule, clock.get()));
        connector = new FakeConnector(fake);
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

    private PublicAutomation defineGated(String gate) {
        return service.create(tenant, ACTOR, "key-" + UUID.randomUUID(),
                new AutomationDefinitionRequest(sessionId, "Goal", "* * * * *",
                        "UTC", "Run it.", null, "skip", "none", null, true,
                        TextNode.valueOf(gate))).body();
    }

    private AutomationLedgerStore.OccurrenceRow occurrence(String automationId,
            String key) {
        return ledger.findOccurrence(tenant, automationId, key).orElseThrow();
    }

    @Test
    void aGatedDefinitionFiresOnlyWhenItsProbePrints() {
        PublicAutomation automation = defineGated("./probe.sh --gate");
        assertThat(automation.gate()).isEqualTo("./probe.sh --gate");
        assertThat(automation.gateStatus()).isNull();
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .gate()).isEqualTo("./probe.sh --gate");

        // Quiet: the probe ran, nothing was claimed, the slot is skipped
        // under its own reason and the status counts it.
        fake.gateAnswers.add("quiet");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        String first = "schedule:2026-06-01T10:01:00Z";
        assertThat(fake.probes).containsExactly(automation.id() + "|" + first);
        assertThat(occurrence(automation.id(), first).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(occurrence(automation.id(), first).reason())
                .isEqualTo(AutomationScanner.REASON_GATE_QUIET);
        PublicAutomation quiet = service.get(tenant, ACTOR, automation.id());
        assertThat(quiet.gateStatus().lastOutcome()).isEqualTo("quiet");
        assertThat(quiet.gateStatus().lastAt()).isEqualTo(clock.get());
        assertThat(quiet.gateStatus().quietSinceDelivery()).isEqualTo(1);
        assertThat(quiet.gateStatus().consecutiveFailures()).isEqualTo(0);
        assertThat(quiet.gateStatus().lastError()).isNull();

        // Failed, unknown and blocked grow one streak and keep the detail.
        fake.gateAnswers.add("failed:exited with code 1");
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        String second = "schedule:2026-06-01T10:02:00Z";
        assertThat(occurrence(automation.id(), second).reason())
                .isEqualTo(AutomationScanner.REASON_GATE_FAILED);
        assertThat(occurrence(automation.id(), second).lastError())
                .isEqualTo("exited with code 1");
        fake.gateAnswers.add("unknown:the Runtime did not settle");
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(occurrence(automation.id(), "schedule:2026-06-01T10:03:00Z")
                .reason()).isEqualTo(AutomationScanner.REASON_GATE_UNKNOWN);
        fake.gateAnswers.add("blocked:the Session's tool profile declares no Shell");
        clock.set(T0 + 4 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(occurrence(automation.id(), "schedule:2026-06-01T10:04:00Z")
                .reason()).isEqualTo(AutomationScanner.REASON_GATE_BLOCKED);
        PublicAutomation failing = service.get(tenant, ACTOR, automation.id());
        assertThat(failing.gateStatus().lastOutcome()).isEqualTo("blocked");
        assertThat(failing.gateStatus().consecutiveFailures()).isEqualTo(3);
        assertThat(failing.gateStatus().quietSinceDelivery()).isEqualTo(1);
        assertThat(failing.gateStatus().lastError())
                .isEqualTo("the Session's tool profile declares no Shell");

        // Delivered: the one fire, and the status starts over.
        clock.set(T0 + 5 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(outcomes(automation.id()).get(AutomationLedgerStore
                .OUTCOME_FIRED)).containsExactly("schedule:2026-06-01T10:05:00Z");
        assertThat(outcomes(automation.id()).get(AutomationLedgerStore
                .OUTCOME_SKIPPED)).hasSize(4);
        PublicAutomation delivered = service.get(tenant, ACTOR, automation.id());
        assertThat(delivered.gateStatus().lastOutcome()).isEqualTo("delivered");
        assertThat(delivered.gateStatus().quietSinceDelivery()).isEqualTo(0);
        assertThat(delivered.gateStatus().consecutiveFailures()).isEqualTo(0);
        assertThat(delivered.gateStatus().lastError()).isNull();
        // Every slot asked the Harness once; only the delivery got a run.
        assertThat(fake.probes).hasSize(5);
        assertThat(fake.fires()).isEqualTo(5);
    }

    @Test
    void anOutcomeOfAReplacedGateDoesNotLandOnTheNewOne() {
        // The gate is revised while its probe runs: the old command's answer
        // must not count on the new command's freshly reset status.
        PublicAutomation automation = defineGated("./probe.sh");
        fake.gateAnswers.add("failed:exited with code 1");
        fake.beforeGateAnswer = () -> service.update(tenant, ACTOR,
                automation.id(), "key-" + UUID.randomUUID(),
                new AutomationDefinitionRequest(null, null, null, null, null,
                        null, null, null, null, null,
                        TextNode.valueOf("./other.sh")));
        clock.set(T0 + MINUTE + 1_000);
        scanner.tick(clock.get());
        PublicAutomation revised = service.get(tenant, ACTOR, automation.id());
        assertThat(revised.gate()).isEqualTo("./other.sh");
        assertThat(revised.gateStatus()).isNull();
    }

    @Test
    void aReplayedDeliveryOfAnEarlierRevisionDoesNotCountForTheNewGate() {
        // The probe delivered and the claim committed, but the answer was
        // lost; the gate is revised before the re-drive, which replays the
        // committed run: that delivery was the old command's.
        PublicAutomation automation = defineGated("./probe.sh");
        fake.failAfterNextFireCommit = new HarnessFailure("connection lost");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        service.update(tenant, ACTOR, automation.id(),
                "key-" + UUID.randomUUID(),
                new AutomationDefinitionRequest(null, null, null, null, null,
                        null, null, null, null, null,
                        TextNode.valueOf("./other.sh")));
        clock.addAndGet(11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(occurrence(automation.id(), "schedule:2026-06-01T10:01:00Z")
                .outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(fake.probes).hasSize(1);
        PublicAutomation revised = service.get(tenant, ACTOR, automation.id());
        assertThat(revised.gate()).isEqualTo("./other.sh");
        assertThat(revised.gateStatus()).isNull();
    }

    @Test
    void everySlotOfOneScanCountsInTheGateStatus() {
        // One scan hands every due slot the same schedule snapshot: the
        // counters must still move once per probe.
        PublicAutomation automation = defineGated("./probe.sh");
        fake.gateAnswers.add("quiet");
        fake.gateAnswers.add("quiet");
        fake.gateAnswers.add("quiet");
        clock.set(T0 + 3 * MINUTE + 1_000);
        scanner.tick(clock.get());
        assertThat(fake.probes).hasSize(3);
        assertThat(service.get(tenant, ACTOR, automation.id()).gateStatus()
                .quietSinceDelivery()).isEqualTo(3);

        fake.gateAnswers.add("failed:exited with code 1");
        fake.gateAnswers.add("failed:exited with code 2");
        clock.set(T0 + 5 * MINUTE + 1_000);
        scanner.tick(clock.get());
        assertThat(fake.probes).hasSize(5);
        PublicAutomation failing = service.get(tenant, ACTOR, automation.id());
        assertThat(failing.gateStatus().consecutiveFailures()).isEqualTo(2);
        assertThat(failing.gateStatus().quietSinceDelivery()).isEqualTo(3);
        assertThat(failing.gateStatus().lastError())
                .isEqualTo("exited with code 2");
    }

    @Test
    void aGateRevisionStartsItsStatusOverAndNullClearsIt() {
        PublicAutomation automation = defineGated("./probe.sh");
        fake.gateAnswers.add("quiet");
        clock.set(T0 + MINUTE + 1_000);
        scanner.tick(clock.get());
        assertThat(service.get(tenant, ACTOR, automation.id()).gateStatus()
                .quietSinceDelivery()).isEqualTo(1);
        // Another command: the summary described the old one.
        PublicAutomation revised = service.update(tenant, ACTOR,
                automation.id(), "key-" + UUID.randomUUID(),
                new AutomationDefinitionRequest(null, null, null, null, null,
                        null, null, null, null, null,
                        TextNode.valueOf("./other.sh"))).body();
        assertThat(revised.definitionRevision()).isEqualTo(2);
        assertThat(revised.gate()).isEqualTo("./other.sh");
        assertThat(revised.gateStatus()).isNull();
        // A revision naming no gate keeps it; null clears it.
        PublicAutomation kept = service.update(tenant, ACTOR, automation.id(),
                "key-" + UUID.randomUUID(), new AutomationDefinitionRequest(null,
                        "Goal 2", null, null, null, null, null, null, null,
                        null)).body();
        assertThat(kept.gate()).isEqualTo("./other.sh");
        PublicAutomation cleared = service.update(tenant, ACTOR,
                automation.id(), "key-" + UUID.randomUUID(),
                new AutomationDefinitionRequest(null, null, null, null, null,
                        null, null, null, null, null, NullNode.getInstance()))
                .body();
        assertThat(cleared.gate()).isNull();
        assertThat(cleared.definitionRevision()).isEqualTo(4);
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .gate()).isNull();
        // An ungated fire never probes.
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.probes).hasSize(1);
        // The request's own bounds refuse before the relay.
        for (JsonNode bad : List.of(TextNode.valueOf("x".repeat(2049)),
                TextNode.valueOf("./probe.sh\u0007"), TextNode.valueOf("  "),
                mapper.getNodeFactory().numberNode(7))) {
            assertThatThrownBy(() -> service.update(tenant, ACTOR,
                    automation.id(), "key-" + UUID.randomUUID(),
                    new AutomationDefinitionRequest(null, null, null, null,
                            null, null, null, null, null, null, bad)))
                    .isInstanceOf(ManagedAgentException.class)
                    .extracting(error -> ((ManagedAgentException) error).getCode())
                    .isEqualTo("invalid_automation");
        }
    }

    @Test
    void aManualRunOfAQuietGateIsSkippedUnderItsReason() {
        PublicAutomation automation = defineGated("./probe.sh");
        fake.gateAnswers.add("quiet");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, automation.id(),
                "manual-quiet"))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessageContaining(AutomationScanner.REASON_GATE_QUIET);
        assertThat(occurrence(automation.id(), "manual:manual-quiet").outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(occurrence(automation.id(), "manual:manual-quiet").reason())
                .isEqualTo(AutomationScanner.REASON_GATE_QUIET);
        // A printing probe fires the manual run like any other.
        PublicAutomationRun run = service.run(tenant, ACTOR, automation.id(),
                "manual-print").body();
        assertThat(run.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(fake.probes).containsExactly(
                automation.id() + "|manual:manual-quiet",
                automation.id() + "|manual:manual-print");
    }

    private AutomationScanner scanner(String owner) {
        return new AutomationScanner(ledger, connector, settings,
                clock::get, owner);
    }

    private AutomationScanner scanner(String owner, ExecutorService pool) {
        return new AutomationScanner(ledger, connector, settings,
                clock::get, owner, pool);
    }

    /** A real bounded row pool, shut down by each test that opens one. */
    private ThreadPoolTaskExecutor rowPool(int threads) {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(threads);
        executor.setMaxPoolSize(threads);
        executor.setThreadNamePrefix("automation-scan-test-");
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.afterPropertiesSet();
        return executor;
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            assertThat(latch.await(10, TimeUnit.SECONDS)).isTrue();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        }
    }

    private long leaseUntilOf(String automationId) {
        Long until = jdbc.queryForObject("SELECT lease_until FROM ma_schedule"
                        + " WHERE tenant_id = ? AND schedule_id = ?",
                Long.class, tenant, automationId);
        return until == null ? -1 : until;
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
    void doesNotDeriveSlotsFromADefinitionReplacedBeforeTick() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        // The journal publishes the new cron before the scanner derives its slots.
        fake.run(sessionId, Map.of("operationId", UUID.randomUUID().toString(),
                "kind", "define_schedule", "scheduleId", automation.id(),
                "definition", Map.of("cron", "*/2 * * * *")));
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        List<OccurrenceView> rows = ledger.listOccurrences(tenant,
                automation.id(), null, 10).rows();
        assertThat(rows).isEmpty();
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow().definitionRevision())
                .isEqualTo(2);
    }

    @Test
    void skipsWhenTheTargetSessionIsNotActive() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED'"
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
    void aClosedSessionStillRetiresItsDefinitionLocally() {
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, sessionId);
        var retired = service.retire(tenant, ACTOR, automation.id(), "retire-local");
        assertThat(retired.body().state()).isEqualTo("retired");
        assertThat(retired.body().enabled()).isFalse();
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .state()).isEqualTo(AutomationLedgerStore.STATE_RETIRED);
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow().enabled()).isTrue();
        // No slot of it is decided again: the retire is visible, not an
        // endless skipped(session_not_active) column.
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(ledger.listOccurrences(tenant, automation.id(), null, 10)
                .rows()).isEmpty();
        // The same key replays the local retire.
        assertThat(service.retire(tenant, ACTOR, automation.id(),
                "retire-local").replayed()).isTrue();
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
        jdbc.update("UPDATE ma_schedule SET timezone = ?"
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
        assertThat(first.id()).isEqualTo(com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.automationRunId(automation.id(), "manual:manual-1"));
        assertThat(service.run(tenant, ACTOR, automation.id(), "manual-1")
                .replayed()).isTrue();
        assertThat(fake.fires()).isEqualTo(1);
        assertThatThrownBy(() -> service.run(tenant, ACTOR, automation.id(),
                "manual-2"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("automation_run_skipped");
                });
        // The first run settles in the Session store: its projection row
        // reads completed, so the next manual run is admitted.
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, 'automation_run', ?, ?, 3,"
                        + " 'resource', 'automation_run', 'completed', ?)",
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, sessionId),
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getStatus()).isEqualTo(403));
        assertThatThrownBy(() -> service.get(tenant, "stranger", id))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getStatus()).isEqualTo(404));
        var retired = service.retire(tenant, ACTOR, id, "retire-1");
        assertThat(retired.body().state()).isEqualTo("retired");
        assertThat(service.retire(tenant, ACTOR, id, "retire-2").replayed())
                .isTrue();
        assertThatThrownBy(() -> service.update(tenant, ACTOR, id, "update-4",
                new AutomationDefinitionRequest(null, null, "0 3 * * *", null,
                        null, null, null, null, null, null)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
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
        jdbc.update("DELETE FROM ma_request_receipt"
                + " WHERE namespace='AUTOMATION' AND tenant_id = ? AND idempotency_key = ?", tenant,
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
    void aCapFullSessionStillRedrivesItsOwnLandedCreate() {
        AutomationDefinitionRequest request = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        for (int index = 0; index < 31; index += 1) {
            service.create(tenant, ACTOR, "fill-" + index, request);
        }
        PublicAutomation last = service.create(tenant, ACTOR, "cap-key",
                request).body();
        assertThat(ledger.countLive(tenant, sessionId)).isEqualTo(32);
        // The crash window the finding names: the Harness committed the
        // definition and the ledger mirrored it, but the answer — and so
        // the command row's settle — was lost.
        jdbc.update("UPDATE ma_request_receipt SET"
                + " result_json = '' WHERE namespace='AUTOMATION' AND tenant_id = ? AND"
                + " idempotency_key = ?", tenant, "cap-key");
        var retried = service.create(tenant, ACTOR, "cap-key", request);
        assertThat(retried.replayed()).isTrue();
        assertThat(retried.body().id()).isEqualTo(last.id());
        // The retry settled the row rather than dying at the count it had
        // already paid: the next replay now answers from it.
        var remembered = service.create(tenant, ACTOR, "cap-key", request);
        assertThat(remembered.replayed()).isTrue();
        assertThat(remembered.body().id()).isEqualTo(last.id());
        assertThat(ledger.countLive(tenant, sessionId)).isEqualTo(32);
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
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
    void aScannerWhoseLeaseWasTakenCannotMoveTheLedger() {
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
    void aLapsedLeaseStillWritesUntilAnotherClaimMovesTheFence() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        String id = automation.id();
        String key = "schedule:2026-06-01T10:01:00Z";
        AutomationLedgerStore.ScheduleRow row = ledger.findSchedule(tenant, id)
                .orElseThrow();
        long fence = ledger.claim(tenant, id, "scanner-a", T0 + 60_000, T0);
        assertThat(fence).isPositive();
        // Past lease_until with nobody else claiming: owner and fence still
        // match, so a tick that outlived its lease records and settles.
        long late = T0 + 61_000;
        assertThat(ledger.recordOccurrence(AutomationLedgerStore.OccurrenceRow
                        .decision(row, key, T0 + MINUTE,
                                AutomationScanner.TRIGGER_SCHEDULED,
                                AutomationLedgerStore.OUTCOME_FIRING, null, fence,
                                late), "scanner-a"))
                .map(AutomationLedgerStore.OccurrenceRow::fence).contains(fence);
        assertThat(ledger.repinOccurrence(tenant, id, key, 1, "scanner-a", fence,
                late)).isTrue();
        assertThat(ledger.deferOccurrence(tenant, id, key, 1, late + 1_000,
                "slow", "scanner-a", fence, late)).isTrue();
        assertThat(ledger.settleOccurrence(tenant, id, key,
                AutomationLedgerStore.OUTCOME_FIRED, null, "scanner-a", fence,
                late)).isTrue();
        assertThat(ledger.advanceWatermark(tenant, id, "scanner-a", fence,
                T0 + MINUTE, late)).isTrue();
        String next = "schedule:2026-06-01T10:02:00Z";
        assertThat(ledger.recordOccurrence(AutomationLedgerStore.OccurrenceRow
                .decision(row, next, T0 + 2 * MINUTE,
                        AutomationScanner.TRIGGER_SCHEDULED,
                        AutomationLedgerStore.OUTCOME_FIRING, null, fence, late),
                "scanner-a")).isPresent();
        assertThat(ledger.settleOccurrence(tenant, id, next,
                AutomationLedgerStore.OUTCOME_SKIPPED, "gate_failed",
                "probe exited 2", "scanner-a", fence, late)).isTrue();
        assertThat(ledger.findOccurrence(tenant, id, next).orElseThrow()
                .lastError()).isEqualTo("probe exited 2");
        assertThat(ledger.recordGateOutcome(row, row.definitionRevision(),
                "scanner-a", fence, AutomationLedgerStore.GATE_FAILED,
                "probe exited 2", late)).isTrue();
        ledger.block(tenant, id, "scanner-a", fence, "cron * does not compile",
                late);
        ScheduleRow held = ledger.findSchedule(tenant, id).orElseThrow();
        assertThat(held.gateLastError()).isEqualTo("probe exited 2");
        assertThat(held.blockedReason()).isEqualTo("cron * does not compile");
        ledger.release(tenant, id, "scanner-a", fence, late);
        assertThat(ledger.findSchedule(tenant, id).orElseThrow().leaseOwner())
                .isNull();
        // The next claim moves the fence; from then on the earlier holder
        // moves nothing.
        assertThat(ledger.claim(tenant, id, "scanner-b", late + 60_000, late + 1))
                .isGreaterThan(fence);
        assertThat(ledger.advanceWatermark(tenant, id, "scanner-a", fence,
                T0 + 2 * MINUTE, late + 2)).isFalse();
        assertThat(ledger.findSchedule(tenant, id).orElseThrow()
                .watermarkSlot()).isEqualTo(T0 + MINUTE);
    }

    @Test
    void backsOffALostAnswerAndRecordsUnknownPastTheBound() {
        // One slot ever: 10:01 on June 1st.
        PublicAutomation automation = define("1 10 1 6 *", "skip", "none", null,
                true);
        String id = automation.id();
        String key = "schedule:2026-06-01T10:01:00Z";
        fake.failNextFire = new HarnessFailure("answer lost");
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
            fake.failNextFire = new HarnessFailure("answer lost " + attempt);
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
        fake.failNextFire = new HarnessFailure("answer lost, last");
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
        fake.failNextFire = new HarnessFailure("answer lost");
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
    void repinsAClaimToTheRevisionCommittedAfterItWasRead() throws Exception {
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
        // definition and its projection now hold revision 2; the claim
        // still pins the revision this scanner read before the change.
        fake.run(sessionId, Map.of("operationId",
                UUID.randomUUID().toString(), "kind", "define_schedule",
                "scheduleId", id, "definition", Map.of("goal", "Moved")));
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
        FakeConnector moving = new FakeConnector(fake) {
            @Override
            public Map<String, Object> runAutomationOperation(String tenantId,
                    String targetSession, Map<String, Object> body) {
                if ("fire_run".equals(body.get("kind"))
                        && Long.valueOf(3).equals(body.get("definitionRevision"))) {
                    fake.run(targetSession, Map.of("operationId", UUID.randomUUID().toString(),
                            "kind", "define_schedule", "scheduleId", id,
                            "definition", Map.of("goal", "Moved during repin")));
                }
                return super.runAutomationOperation(tenantId, targetSession, body);
            }
        };
        AutomationScanner racing = new AutomationScanner(ledger, moving, settings,
                clock::get, "scanner-a");
        assertThat(racing.fire(refreshed, second, "scanner-a", again, then))
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
        fake.failAfterNextDefineCommit = new HarnessFailure("connection lost");
        assertThatThrownBy(() -> service.create(tenant, ACTOR, keyA, requestA))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE.value());
                    assertThat(error.getCode())
                            .isEqualTo("automation_operation_unknown");
                });
        AutomationLedgerStore.CommandRow claim = ledger
                .findCommand(tenant, keyA).orElseThrow();
        assertThat(claim.resultJson()).isEmpty();
        // The journal commit published the definition before its answer was lost.
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
        fake.failAfterNextRetireCommit = new HarnessFailure("connection lost");
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, created.id(), keyR))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        // The journal published retirement before the answer was lost;
        // the pre-relay claim is still the request's unanswered binding.
        assertThat(
                ledger.findSchedule(tenant, created.id()).orElseThrow().state())
                .isEqualTo(AutomationLedgerStore.STATE_RETIRED);
        assertThat(ledger.findCommand(tenant, keyR).orElseThrow().resultJson())
                .isEmpty();
        // The terminal committed projection answers the retry directly.
        var retried = service.retire(tenant, ACTOR, created.id(), keyR);
        assertThat(retried.replayed()).isTrue();
        assertThat(retried.body().state()).isEqualTo("retired");
        assertThat(
                ledger.findSchedule(tenant, created.id()).orElseThrow().state())
                .isEqualTo(AutomationLedgerStore.STATE_RETIRED);
        var replayed = service.retire(tenant, ACTOR, created.id(), keyR);
        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.body().state()).isEqualTo("retired");
        // The original relay committed once; retries perform no extra relay.
        List<Map<String, Object>> retires = fake.operations.stream()
                .filter(operation -> "retire_schedule"
                        .equals(operation.get("kind")))
                .toList();
        assertThat(retires).hasSize(1);
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
        fake.failAfterNextDefineCommit = new HarnessFailure("connection lost");
        assertThatThrownBy(
                () -> service.update(tenant, ACTOR, automationId, keyU,
                        requestU))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
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
        fake.failAfterNextRetireCommit = new HarnessFailure("connection lost");
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, first.id(), key))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        // The same key against another target is a different request: the
        // first attempt's claim refuses it at the identity layer, and the
        // ledger never retires that definition's mirror.
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, second.id(), key))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, 'storage', 'Private', ?, ?,"
                        + " 'ACTIVE')",
                tenant, hidden,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')",
                tenant, hidden, ACTOR.getBytes(StandardCharsets.UTF_8));
        String privateSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Private",
                Map.of(), List.of(), new WorkspaceSelection(hidden, "."))
                .sessionId();
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE'"
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
                    .isInstanceOfSatisfying(ManagedAgentException.class, error ->
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
        fake.failNextFire = new HarnessFailure("connection lost");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "lost-1"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE.value());
                    assertThat(error.getCode())
                            .isEqualTo("automation_operation_unknown");
                });
        AutomationLedgerStore.OccurrenceRow claim = ledger.findOccurrence(
                tenant, id, "manual:lost-1").orElseThrow();
        assertThat(claim.outcome()).isEqualTo(AutomationLedgerStore.OUTCOME_FIRING);
        assertThat(claim.attempts()).isEqualTo(1);
        assertThat(claim.lastError()).isEqualTo("connection lost");
        assertThat(claim.trigger()).isEqualTo(AutomationScanner.TRIGGER_MANUAL);
        // The first same-key retry after a lost answer re-drives the claim:
        // the caller is answered what the Harness now says.
        var asked = service.run(tenant, ACTOR, id, "lost-1");
        assertThat(asked.replayed()).isTrue();
        assertThat(asked.body().outcome()).isEqualTo("fired");
        assertThat(asked.body().id()).isEqualTo(claim.runId());
        assertThat(fake.fires()).isEqualTo(2);
        // A claim nobody asks about again is re-driven by the scanner.
        fake.failNextFire = new HarnessFailure("connection lost");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "lost-2"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
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
    void aRetryInsideTheDeferWindowDoesNotSpendTheScannerBudget() {
        PublicAutomation automation = define("0 2 * * *", "allow", "none",
                null, true);
        String id = automation.id();
        ScheduleRow held = ledger.findSchedule(tenant, id).orElseThrow();
        long seedFence = ledger.claim(tenant, id, "seed",
                clock.get() + 60_000, clock.get());
        assertThat(seedFence).isPositive();
        assertThat(ledger.recordOccurrence(AutomationLedgerStore.OccurrenceRow
                .decision(held, "manual:seeded", null,
                        AutomationScanner.TRIGGER_MANUAL,
                        AutomationLedgerStore.OUTCOME_FIRING, null, seedFence,
                        clock.get()), "seed")).isPresent();
        assertThat(ledger.deferOccurrence(tenant, id, "manual:seeded", 63,
                clock.get() + 30_000, "seeded", "seed", seedFence,
                clock.get())).isTrue();
        ledger.release(tenant, id, "seed", seedFence, clock.get());
        // One more fire would take attempts to MAX_FIRE_ATTEMPTS and settle
        // the claim unknown; the guard answers 503 without reaching it.
        fake.failNextFire = new HarnessFailure("must not fire");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "seeded"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE.value());
                    assertThat(error.getCode())
                            .isEqualTo("automation_operation_unknown");
                });
        assertThat(fake.fires()).isZero();
        AutomationLedgerStore.OccurrenceRow after = ledger.findOccurrence(
                tenant, id, "manual:seeded").orElseThrow();
        assertThat(after.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRING);
        assertThat(after.attempts()).isEqualTo(63);
    }

    @Test
    void aDeferredRetryAnswersTheRecordedWorkspaceCode() {
        PublicAutomation automation = define("0 2 * * *", "allow", "none",
                null, true);
        String id = automation.id();
        seedDeferred(id, "manual:workspace", 2,
                "fire failed with HTTP 409: {\"error\":\"workspace_busy\","
                        + "\"code\":\"workspace_busy\"}");
        fake.failNextFire = new HarnessFailure("must not fire");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "workspace"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE.value());
                    assertThat(error.getCode()).isEqualTo("workspace_busy");
                });
        assertThat(fake.fires()).isZero();
    }

    @Test
    void aDeferredRetryKeepsAFinalRefusalFinal() {
        PublicAutomation automation = define("0 2 * * *", "allow", "none",
                null, true);
        String id = automation.id();
        seedDeferred(id, "manual:blocked", 2,
                "fire failed with HTTP 409: {\"error\":\"hosted_session_blocked\","
                        + "\"code\":\"hosted_session_blocked\"}");
        fake.failNextFire = new HarnessFailure("must not fire");
        assertThatThrownBy(() -> service.run(tenant, ACTOR, id, "blocked"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("hosted_session_blocked");
                });
        assertThat(fake.fires()).isZero();
    }

    private void seedDeferred(String id, String occurrenceKey, int attempts,
            String lastError) {
        ScheduleRow held = ledger.findSchedule(tenant, id).orElseThrow();
        long fence = ledger.claim(tenant, id, "seed",
                clock.get() + 60_000, clock.get());
        assertThat(fence).isPositive();
        assertThat(ledger.recordOccurrence(AutomationLedgerStore.OccurrenceRow
                .decision(held, occurrenceKey, null,
                        AutomationScanner.TRIGGER_MANUAL,
                        AutomationLedgerStore.OUTCOME_FIRING, null, fence,
                        clock.get()), "seed")).isPresent();
        assertThat(ledger.deferOccurrence(tenant, id, occurrenceKey, attempts,
                clock.get() + 30_000, lastError, "seed", fence,
                clock.get())).isTrue();
        ledger.release(tenant, id, "seed", fence, clock.get());
    }

    @Test
    void theScannerRunsOnADedicatedScheduler() throws Exception {
        assertThat(applicationContext.containsBean("managedAutomationScheduler"))
                .isTrue();
        assertThat(applicationContext.getBean("managedAutomationScheduler"))
                .isNotSameAs(applicationContext.getBean("managedAgentScheduler"));
        var scheduled = AutomationScanner.class.getMethod("scan")
                .getAnnotation(org.springframework.scheduling.annotation.Scheduled.class);
        assertThat(scheduled.scheduler())
                .isEqualTo("managedAutomationScheduler");
    }

    @Test
    void anOpenPublicTurnSuppressesFiresUntilItEnds() {
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, gmt_create, gmt_modified, completed_at)"
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
        jdbc.update("UPDATE ma_turn SET status = 'COMPLETED',"
                        + " completed_at = 2000 WHERE tenant_id = ?"
                        + " AND turn_id = ?",
                tenant, "turn-open");
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
    void aRecoveryBlockedSessionDefersAndItsSlotRetries() {
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        fake.failNextFire = AutomationHarnessFake.refusal(409,
                "hosted_session_blocked");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow row = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:01:00Z")
                .orElseThrow();
        // A transient session-state refusal is a defer, never a skip:
        // the claim stays firing with its backoff visible.
        assertThat(row.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRING);
        assertThat(row.attempts()).isEqualTo(1);
        assertThat(row.nextRetryAt()).isGreaterThan(T0 + MINUTE + 1_000);
        assertThat(row.lastError()).contains("hosted_session_blocked");
        // The recovery clears, and the retried slot fires instead of
        // having been recorded skipped forever.
        fake.failNextFire = null;
        clock.set(T0 + MINUTE + 3_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(ledger.findOccurrence(tenant, automation.id(),
                "schedule:2026-06-01T10:01:00Z").orElseThrow().outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:02:00Z");
    }

    @Test
    void aWedgedRunIsReconciledAndTheSlotThatAskedFires() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        // The run is live and its wake turn healthy: the refusal stands,
        // and the reconcile the decision asked reports that, untouched.
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:02:00Z")
                .orElseThrow();
        assertThat(skipped.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason()).isEqualTo(AutomationScanner.REASON_OVERLAP);
        assertThat(fake.operations.stream()
                .filter(operation -> "reconcile_run"
                        .equals(operation.get("kind")))
                .map(operation -> String.valueOf(
                        operation.get("occurrenceKey"))))
                .containsExactly("schedule:2026-06-01T10:01:00Z");
        // The Harness died inside that wake turn, and nothing else ever
        // loads the Session under overlap skip: the next decision's
        // reconcile settles the crashed run — and the very slot that
        // asked fires instead of being recorded skipped forever.
        fake.crashedRuns.add(com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.automationRunId(
                automation.id(), "schedule:2026-06-01T10:01:00Z"));
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:03:00Z");
    }

    @Test
    void aSettledRunIsNeverSubtractedAgainWhenTheMirrorAlreadyDropsIt() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        String id = automation.id();
        String wedged = "schedule:2026-06-01T10:01:00Z";
        String liveKey = "schedule:2026-06-01T10:02:00Z";
        String wedgedRunId = com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.automationRunId(id, wedged);
        // A second, genuinely live run beside the wedged one (a manual
        // run, fired and never settled: the mirror has no terminal row).
        AutomationLedgerStore.ScheduleRow row = ledger.findSchedule(tenant, id)
                .orElseThrow();
        long fence = ledger.claim(tenant, id, "scanner-a",
                clock.get() + 60_000, clock.get());
        ledger.recordOccurrence(AutomationLedgerStore.OccurrenceRow.decision(
                row, liveKey, T0 + 2 * MINUTE, AutomationScanner.TRIGGER_MANUAL,
                AutomationLedgerStore.OUTCOME_FIRING, null, fence, clock.get()),
                "scanner-a");
        assertThat(ledger.settleOccurrence(tenant, id, liveKey,
                AutomationLedgerStore.OUTCOME_FIRED, null, "scanner-a", fence,
                clock.get())).isTrue();
        ledger.release(tenant, id, "scanner-a", fence, clock.get());
        // Production's shape: the commit that settles the wedged run
        // applies its `failed` mirror row inside the same commit that
        // answers the reconcile (ManagedSessionStore). Subtracting the
        // answered run again from the recounted active would admit this
        // very slot past the wedge it was refused for.
        FakeConnector applying = new FakeConnector(fake) {
            private boolean applied;
            @Override
            public Map<String, Object> runAutomationOperation(String tenantId,
                    String sessionId, Map<String, Object> body) {
                Map<String, Object> answer = super.runAutomationOperation(
                        tenantId, sessionId, body);
                if (!applied && "reconcile_run".equals(body.get("kind"))) {
                    applied = true;
                    String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant,
                            sessionId);
                    byte[] bytes = "{}".getBytes(StandardCharsets.UTF_8);
                    jdbc.update("INSERT INTO ma_resource"
                            + " (resource_key, session_scope_key, tenant_id, workspace_id,"
                            + " session_id, resource_id, kind, schema_version,"
                            + " byte_length, sha256, storage_kind,"
                            + " inline_bytes, publish_command_id, state,"
                            + " gmt_create)"
                            + " VALUES (?, ?, ?, ?, ?, 'wedged-run-rev-3',"
                            + " 'managed-automation-run', 1, ?, ?,"
                            + " 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', ?)",
                            com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(scope, "wedged-run-rev-3"), scope, tenant, WORKSPACE, sessionId, bytes.length,
                            com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.sha256(
                                    new String(bytes, StandardCharsets.UTF_8)),
                            bytes, new java.sql.Timestamp(clock.get()));
                    jdbc.update(
                            "INSERT INTO ma_session_record"
                            + " (session_scope_key, record_key, tenant_id,"
                            + " workspace_id, session_id, domain, record_id,"
                            + " operation_hash, revision, record_resource_id,"
                            + " task_kind, task_state, definition_revision,"
                            + " gmt_create)"
                            + " VALUES (?, ?, ?, ?, ?, 'automation_run', ?, ?, 3,"
                            + " 'wedged-run-rev-3', 'automation_run', 'failed',"
                            + " 1, ?)",
                            scope, ManagedExtensionProjection.recordKey(
                                    sessionId, "automation_run", wedgedRunId),
                            tenant, WORKSPACE, sessionId, wedgedRunId,
                            "0".repeat(64), clock.get());
                }
                return answer;
            }
        };
        AutomationScanner applyingScanner = new AutomationScanner(ledger,
                applying, settings, clock::get, "scanner-a");
        fake.crashedRuns.add(wedgedRunId);
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(applyingScanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, id, "schedule:2026-06-01T10:03:00Z").orElseThrow();
        assertThat(skipped.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason()).isEqualTo(AutomationScanner.REASON_OVERLAP);
        assertThat(fake.firedOccurrences()).containsExactly(wedged);
    }

    @Test
    void anUnansweredReconcileKeepsTheRefusalAndTheNextSlotRetries() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        // The reconcile's own answer is lost: the refusal it stood behind
        // is the accurate record — the decision is skipped, never deferred
        // into unknown nor fired on a guess.
        fake.failNextReconcile = AutomationHarnessFake.refusal(503,
                "automation_operation_failed");
        fake.crashedRuns.add(com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.automationRunId(
                automation.id(), "schedule:2026-06-01T10:01:00Z"));
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:02:00Z")
                .orElseThrow();
        assertThat(skipped.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason()).isEqualTo(AutomationScanner.REASON_OVERLAP);
        // The re-drive repairs the run the fault swallowed, and clears the
        // slot that asked.
        fake.crashedRuns.add(com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.automationRunId(
                automation.id(), "schedule:2026-06-01T10:01:00Z"));
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:03:00Z");
    }

    @Test
    void aRetiredDefinitionRefreshRetiresOnTheReconcileRefusalNotSkippedForever() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        // The chain ended at the journal while the mirror still arms: each
        // later reconcile meets its not-found — refresh-retire the mirror
        // and record the accurate reason instead of skipped-overlap for
        // every slot after it.
        fake.failNextReconcile = AutomationHarnessFake.refusal(404,
                "automation_not_found");
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:02:00Z")
                .orElseThrow();
        assertThat(skipped.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason())
                .isEqualTo(AutomationScanner.REASON_DEFINITION_RETIRED);
        AutomationLedgerStore.ScheduleRow mirror = ledger.findSchedule(tenant,
                automation.id()).orElseThrow();
        assertThat(mirror.state())
                .isEqualTo(AutomationLedgerStore.STATE_RETIRED);
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(fake.operations.stream()
                .filter(operation -> "reconcile_run"
                        .equals(operation.get("kind")))).hasSize(1);
    }

    @Test
    void aSessionNotFoundReconcileOnAnActiveSessionKeepsTheRefusalAndTheMirror() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        // A pool member that drained and released the Session answers
        // not-found while the Store still holds it ACTIVE (#15795): that is
        // an unanswered reconcile, so the refusal stands, the mirror stays
        // live and the next due slot asks again.
        fake.failNextReconcile = AutomationHarnessFake.refusal(404,
                "hosted_session_not_found");
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:02:00Z")
                .orElseThrow();
        assertThat(skipped.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason()).isEqualTo(AutomationScanner.REASON_OVERLAP);
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .state()).isEqualTo(AutomationLedgerStore.STATE_LIVE);
        fake.crashedRuns.add(com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.automationRunId(
                automation.id(), "schedule:2026-06-01T10:01:00Z"));
        clock.set(T0 + 3 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:03:00Z");
    }

    @Test
    void aSessionNotFoundReconcileTheStoreConfirmsRefreshRetiresTheMirror() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        // The Session closes after admission read it ACTIVE: the Store now
        // confirms the reconcile's not-found, and the mirror retires.
        fake.beforeReconcile = () -> jdbc.update("UPDATE ma_session SET"
                + " status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?",
                tenant, sessionId);
        fake.failNextReconcile = AutomationHarnessFake.refusal(404,
                "hosted_session_not_found");
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:02:00Z")
                .orElseThrow();
        assertThat(skipped.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason())
                .isEqualTo(AutomationScanner.REASON_DEFINITION_RETIRED);
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .state()).isEqualTo(AutomationLedgerStore.STATE_RETIRED);
    }

    @Test
    void anOpenTurnBlocksFiresWithoutAskingForAReconcile() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        // The overlap a waiting Turn makes is its own lane with its own
        // takeover: no reconcile goes out for it.
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id,"
                        + " turn_id, prompt_id, input_json, payload_digest,"
                        + " status, gmt_create, gmt_modified, completed_at)"
                        + " VALUES (?, ?, 'turn-open-reconcile',"
                        + " 'prompt-open-reconcile', '[]', 'digest', 'RUNNING',"
                        + " 1000, 1000, NULL)",
                tenant, sessionId);
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow skipped = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:02:00Z")
                .orElseThrow();
        assertThat(skipped.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(skipped.reason()).isEqualTo(AutomationScanner.REASON_OVERLAP);
        assertThat(fake.operations.stream()).noneMatch(
                operation -> "reconcile_run".equals(operation.get("kind")));
        jdbc.update("DELETE FROM ma_turn WHERE tenant_id = ?"
                + " AND turn_id = ?", tenant, "turn-open-reconcile");
    }

    @Test
    void aSessionNotFoundFireOnAnActiveSessionDefersAndKeepsTheMirror() {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        // A pool member that drained and released the Session answers
        // not-found while the Store still holds it ACTIVE (#15795): the
        // claim waits for a Harness that holds the Session, and the mirror
        // stays live instead of retiring for good.
        fake.failNextFire = AutomationHarnessFake.refusal(404,
                "hosted_session_not_found");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRING);
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .state()).isEqualTo(AutomationLedgerStore.STATE_LIVE);
        clock.set(T0 + MINUTE + 11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(1);
        assertThat(outcomes(automation.id()))
                .containsOnlyKeys(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(fake.firedOccurrences()).containsExactly(
                "schedule:2026-06-01T10:01:00Z",
                "schedule:2026-06-01T10:01:00Z");
    }

    @ParameterizedTest
    @ValueSource(strings = {"CLOSED", "DELETED"})
    void aSessionNotFoundFireTheStoreConfirmsRetiresTheDefinition(String status) {
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        fake.failNextFire = new HarnessFailure("answer lost");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        // The Session ended while the claim waited: the Store confirms the
        // re-drive's not-found, so the mirror retires now rather than the
        // claim riding the backoff out to unknown.
        jdbc.update("UPDATE ma_session SET status = ? WHERE tenant_id = ?"
                + " AND session_id = ?", status, tenant, sessionId);
        fake.failNextFire = AutomationHarnessFake.refusal(404,
                "hosted_session_not_found");
        clock.set(T0 + MINUTE + 11_000);
        assertThat(scanner.tick(clock.get())).isEqualTo(0);
        AutomationLedgerStore.OccurrenceRow settled = ledger.findOccurrence(
                tenant, automation.id(), "schedule:2026-06-01T10:01:00Z")
                .orElseThrow();
        assertThat(settled.outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_SKIPPED);
        assertThat(settled.reason())
                .isEqualTo(AutomationScanner.REASON_DEFINITION_RETIRED);
        assertThat(ledger.findSchedule(tenant, automation.id()).orElseThrow()
                .state()).isEqualTo(AutomationLedgerStore.STATE_RETIRED);
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
        jdbc.update("DELETE FROM ma_request_receipt"
                + " WHERE namespace='AUTOMATION' AND tenant_id = ? AND idempotency_key = ?", tenant, key);
        assertThatThrownBy(
                () -> service.retire(tenant, ACTOR, automation.id(), key))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        // The crash window: the command row is gone while the durable
        // mirror still proves the identity landed — on the first Session.
        jdbc.update("DELETE FROM ma_request_receipt"
                + " WHERE namespace='AUTOMATION' AND tenant_id = ? AND idempotency_key = ?", tenant, key);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, "skip", "none",
                        null, true)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
        // The post-commit answer is lost; the request claim and definition
        // projection are durable while the response receipt is unsettled.
        fake.failAfterNextDefineCommit = new HarnessFailure("connection lost");
        assertThatThrownBy(() -> service.create(tenant, ACTOR, keyA, requestA))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_operation_unknown"));
        assertThat(ledger.findSchedule(tenant, scheduleId)).isPresent();
        assertThat(fake.scheduleOf(sessionId, scheduleId)).isNotNull();
        // A different request under the same key meets the claim, not a
        // second commit — whatever Session it names.
        String otherSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Other",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, keyA,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, null, null,
                        null, null)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
        ledger.claimCommand(sessionId, new AutomationLedgerStore.CommandRow(tenant, key,
                ACTOR, "deadbeef", scheduleId, ""), clock.get());
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal",
                        "0 2 * * *", "UTC", "Run it.", null, null, null, null,
                        null)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
        ledger.claimCommand(sessionId, new AutomationLedgerStore.CommandRow(tenant, key,
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
    void aGateTheHarnessRefusesReleasesTheClaimSoAFixedRetrySucceeds() {
        // The server's own checks accept `sleep 5 &`; the Harness's shell
        // checks refuse it before committing, so the key goes back.
        String key = "gate-" + UUID.randomUUID();
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal", "* * * * *",
                        "UTC", "Run it.", null, "skip", "none", null, true,
                        TextNode.valueOf("sleep 5 &"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(400);
                    assertThat(error.getCode()).isEqualTo("automation_gate_invalid");
                });
        assertThat(ledger.findCommand(tenant, key)).isEmpty();
        PublicAutomation fixed = service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(sessionId, "Goal", "* * * * *",
                        "UTC", "Run it.", null, "skip", "none", null, true,
                        TextNode.valueOf("./probe.sh"))).body();
        assertThat(fixed.gate()).isEqualTo("./probe.sh");
    }

    @Test
    void aGateTheSessionCannotRunReleasesTheClaim() {
        // No Shell, or a pinned Hook catalog: the Harness refuses before it
        // commits, so the key goes back for a retry without the gate.
        String key = "unsupported-" + UUID.randomUUID();
        fake.gateUnsupported = true;
        try {
            assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                    new AutomationDefinitionRequest(sessionId, "Goal",
                            "* * * * *", "UTC", "Run it.", null, "skip", "none",
                            null, true, TextNode.valueOf("./probe.sh"))))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> {
                                assertThat(error.getStatus())
                                        .isEqualTo(HttpStatus.CONFLICT.value());
                                assertThat(error.getCode()).isEqualTo(
                                        "automation_gate_unsupported");
                            });
            assertThat(ledger.findCommand(tenant, key)).isEmpty();
            PublicAutomation ungated = service.create(tenant, ACTOR, key,
                    new AutomationDefinitionRequest(sessionId, "Goal",
                            "* * * * *", "UTC", "Run it.", null, "skip", "none",
                            null, true)).body();
            assertThat(ungated.gate()).isNull();
        } finally {
            fake.gateUnsupported = false;
        }
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.BAD_REQUEST.value());
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
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, null, null,
                        null, null)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
    void anAttachConflictKeepsTheClaimAndBlocksAnotherRequest() {
        String key = "busy-" + UUID.randomUUID();
        String scheduleId = ManagedAutomationService.scheduleIdFor(tenant,
                key);
        AutomationDefinitionRequest requestA = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        // A re-attach that found the Session running a Turn proves nothing
        // about whether the mutation landed — the claim must outlive it.
        fake.failNextMutation = AutomationHarnessFake.refusal(409,
                "hosted_session_already_attached");
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key, requestA))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("hosted_session_already_attached");
                });
        assertThat(ledger.findCommand(tenant, key).orElseThrow().resultJson())
                .isEmpty();
        String otherSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Other",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, null, null,
                        null, null)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
        assertThat(fake.scheduleOf(otherSession, scheduleId)).isNull();
        var retried = service.create(tenant, ACTOR, key, requestA);
        assertThat(retried.replayed()).isFalse();
        assertThat(retried.body().id()).isEqualTo(scheduleId);
        assertThat(ledger.findCommand(tenant, key).orElseThrow().resultJson())
                .isNotEmpty();
        assertThat(ledger.findSchedule(tenant, scheduleId).orElseThrow()
                .sessionId()).isEqualTo(sessionId);
    }

    @Test
    void aQuotaRefusalKeepsTheClaimSharedWithItsSiblings() {
        String key = "full-" + UUID.randomUUID();
        String scheduleId = ManagedAutomationService.scheduleIdFor(tenant,
                key);
        AutomationDefinitionRequest requestA = new AutomationDefinitionRequest(
                sessionId, "Goal", "0 2 * * *", "UTC", "Run it.", null, null,
                null, null, null);
        // Capacity is another attempt's state: a quota refusal of this
        // attempt can never dissolve the key's binding.
        fake.failNextMutation = AutomationHarnessFake.refusal(409,
                "automation_count_limit");
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key, requestA))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("automation_count_limit"));
        assertThat(ledger.findCommand(tenant, key).orElseThrow().resultJson())
                .isEmpty();
        String otherSession = sessions.createWorkspaceSession(tenant, ACTOR,
                "create-" + UUID.randomUUID(), "qwen-code", null, "Other",
                Map.of(), List.of(), new WorkspaceSelection(WORKSPACE, "."))
                .sessionId();
        jdbc.update("UPDATE ma_session SET status = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                otherSession);
        assertThatThrownBy(() -> service.create(tenant, ACTOR, key,
                new AutomationDefinitionRequest(otherSession, "Goal 2",
                        "15 3 * * *", "UTC", "Run that.", null, null, null,
                        null, null)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
        assertThat(fake.scheduleOf(otherSession, scheduleId)).isNull();
        // The sibling attempt after capacity freed commits against the
        // same claim and settles it with its own answer.
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.BAD_REQUEST.value());
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("automation_unavailable");
                });
    }

    @Test
    void aFireReDrivenAfterTheDefinitionRetiredAnswersTheCommittedRun() {
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        fake.failAfterNextFireCommit = new HarnessFailure("connection lost");
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

    @Test
    void firesDueTogetherSettleAcrossTheRowPool() {
        // #15418: three slow fires due on the same minute must overlap each
        // other on one node's scanner instead of queueing behind the tick's
        // single thread. The latch only opens once every fire is in flight,
        // so a pool that ever lets fewer than three probes run at once
        // deadlocks this test until its timeout fails it.
        PublicAutomation firstAutomation = define("* * * * *", "allow",
                "none", null, true);
        PublicAutomation secondAutomation = define("* * * * *", "allow",
                "none", null, true);
        PublicAutomation thirdAutomation = define("* * * * *", "allow",
                "none", null, true);
        CountDownLatch arrived = new CountDownLatch(3);
        AtomicInteger inFlight = new AtomicInteger();
        AtomicInteger peak = new AtomicInteger();
        HookedConnector hooked = new HookedConnector(fake);
        hooked.onFire = body -> {
            int now = inFlight.incrementAndGet();
            peak.accumulateAndGet(now, Math::max);
            try {
                arrived.countDown();
                awaitLatch(arrived);
            } finally {
                inFlight.decrementAndGet();
            }
        };
        ThreadPoolTaskExecutor rows = rowPool(3);
        try {
            AutomationScanner pooled = new AutomationScanner(ledger, hooked,
                    settings, clock::get, "scanner-pool",
                    rows.getThreadPoolExecutor());
            clock.set(T0 + MINUTE + 1_000);
            assertThat(pooled.tick(clock.get())).isEqualTo(3);
            assertThat(peak.get()).isEqualTo(3);
        } finally {
            rows.destroy();
        }
        String slot = "schedule:2026-06-01T10:01:00Z";
        assertThat(occurrence(firstAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(occurrence(secondAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(occurrence(thirdAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
    }

    @Test
    void theLeaseRunsFromTheClaimNotTheTick() {
        // #15418: with rows on a pool the first row's fire can run halfway
        // through the lease before the second row starts. A lease anchored
        // at the tick's start would already be (close to) expired when the
        // second claim lands; anchoring at the claim keeps it whole. The row
        // order inside the tick is the store's, so the slow fire is
        // whichever runs first.
        define("* * * * *", "allow", "none", null, true);
        define("* * * * *", "allow", "none", null, true);
        HookedConnector hooked = new HookedConnector(fake);
        Map<String, Long> leased = new java.util.concurrent
                .ConcurrentHashMap<>();
        AtomicInteger inFire = new AtomicInteger();
        hooked.onFire = body -> {
            String id = String.valueOf(body.get("scheduleId"));
            // The fire runs under the claim: the lease each definition
            // holds by now is anchored at its own claim, never the tick.
            leased.put(id, leaseUntilOf(id));
            if (inFire.incrementAndGet() == 1) {
                clock.addAndGet(30_000);
            }
        };
        AutomationScanner serial = new AutomationScanner(ledger, hooked,
                settings, clock::get, "scanner-slow-first");
        long t1 = T0 + MINUTE + 1_000;
        clock.set(t1);
        assertThat(serial.tick(t1)).isEqualTo(2);
        assertThat(leased.values()).containsExactlyInAnyOrder(t1 + 60_000,
                t1 + 30_000 + 60_000);
    }

    @Test
    void aHolderThatLostItsLeaseMidFireCannotSettleAndTheNewOwnerRedrives()
            throws Exception {
        // A fire's relay (up to 150 s with the Session load) can outlive
        // the row's lease. The next owner must take the row over and the
        // stale holder's settle must no-op, or one lost answer would
        // produce two Harness-side runs.
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        settings.setLease(Duration.ofSeconds(5));
        CountDownLatch inFire = new CountDownLatch(1);
        CountDownLatch stillFiring = new CountDownLatch(1);
        HookedConnector hooked = new HookedConnector(fake);
        hooked.onFire = body -> {
            if (automation.id().equals(body.get("scheduleId"))
                    && inFire.getCount() > 0) {
                inFire.countDown();
                awaitLatch(stillFiring);
            }
        };
        AutomationScanner stale = new AutomationScanner(ledger, hooked,
                settings, clock::get, "scanner-stale");
        long t1 = T0 + MINUTE + 1_000;
        clock.set(t1);
        Thread first = new Thread(() -> stale.tick(t1));
        first.start();
        awaitLatch(inFire);
        clock.set(t1 + 6_000);
        AutomationScanner next = new AutomationScanner(ledger, hooked,
                settings, clock::get, "scanner-next");
        assertThat(next.tick(clock.get())).isEqualTo(1);
        stillFiring.countDown();
        first.join(10_000);
        assertThat(first.isAlive()).isFalse();
        AutomationLedgerStore.OccurrenceRow row = occurrence(automation.id(),
                "schedule:2026-06-01T10:01:00Z");
        assertThat(row.outcome()).isEqualTo(AutomationLedgerStore
                .OUTCOME_FIRED);
        assertThat(row.attempts()).isEqualTo(0);
        assertThat(fake.fires()).isEqualTo(2);
        assertThat(fake.runCount(sessionId)).isEqualTo(1);
    }

    @Test
    void aBacklogDeeperThanThePoolStillCompletesWithinTheTick() {
        // More candidates than threads queue inside the executor (up to
        // 2×SCAN_LIMIT by construction), and the join leaves none of them
        // outstanding when the tick answers.
        PublicAutomation firstAutomation = define("* * * * *", "allow",
                "none", null, true);
        PublicAutomation secondAutomation = define("* * * * *", "allow",
                "none", null, true);
        PublicAutomation thirdAutomation = define("* * * * *", "allow",
                "none", null, true);
        ThreadPoolTaskExecutor rows = rowPool(2);
        try {
            AutomationScanner pooled = scanner("scanner-backlog",
                    rows.getThreadPoolExecutor());
            clock.set(T0 + MINUTE + 1_000);
            // The join is what drains the backlog: the tick answers with
            // every submitted task's result, so a tick that returned after
            // submitting would answer less than three. Pool gauges are not
            // read here — the executor's counters move after a task's future
            // unparks this joiner, so any of them can lag the answer.
            assertThat(pooled.tick(clock.get())).isEqualTo(3);
        } finally {
            rows.destroy();
        }
        String slot = "schedule:2026-06-01T10:01:00Z";
        assertThat(occurrence(firstAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(occurrence(secondAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(occurrence(thirdAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
    }

    @Test
    void twoDefinitionsSharingOneSessionBothFireWhenDueTogether() {
        // #15442 verify finding 1, accepted behavior (design §Residual
        // ceilings): two definitions on ONE Session are admitted
        // concurrently and both fire. Across definitions the admission
        // guards only on public Turns — automation fires never write
        // ma_turn rows, so neither executor shape suppresses the second
        // definition — and the runs still serialize in the Harness funnel.
        PublicAutomation firstAutomation = define("* * * * *", "skip",
                "none", null, true);
        PublicAutomation secondAutomation = define("* * * * *", "skip",
                "none", null, true);
        ThreadPoolTaskExecutor rows = rowPool(2);
        try {
            AutomationScanner pooled = scanner("scanner-shared-session",
                    rows.getThreadPoolExecutor());
            clock.set(T0 + MINUTE + 1_000);
            assertThat(pooled.tick(clock.get())).isEqualTo(2);
        } finally {
            rows.destroy();
        }
        String slot = "schedule:2026-06-01T10:01:00Z";
        assertThat(occurrence(firstAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(occurrence(secondAutomation.id(), slot).outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
    }

    @Test
    void aTickJoinsEveryRowBeforeItReportsOneFailure() {
        // A row task that escapes claimed() — here, the claim write itself
        // going down — must not abort the tick: the other row runs to
        // completion BEFORE the tick reports the first failure. A direct
        // executor cannot pin this (its tasks finish during submission, so
        // a fail-fast break in the join survives), so on this real pool the
        // second row's claim is still in flight when the first one throws.
        define("* * * * *", "allow", "none", null, true);
        define("* * * * *", "allow", "none", null, true);
        CountDownLatch firstFailed = new CountDownLatch(1);
        AtomicBoolean secondDone = new AtomicBoolean();
        AtomicInteger claims = new AtomicInteger();
        AutomationLedgerStore downAtFirstClaim =
                new AutomationLedgerStore(jdbc) {
                    @Override
                    public long claim(String tenantId, String scheduleId,
                            String owner, long leaseUntil, long now) {
                        if (claims.incrementAndGet() == 1) {
                            firstFailed.countDown();
                            throw new IllegalStateException(
                                    "claim store down");
                        }
                        try {
                            assertThat(firstFailed.await(10,
                                    TimeUnit.SECONDS)).isTrue();
                            // Stay in flight well past the first failure:
                            // a tick that stopped joining there reports
                            // before this claim ever lands.
                            Thread.sleep(300);
                        } catch (InterruptedException error) {
                            Thread.currentThread().interrupt();
                            throw new AssertionError(error);
                        }
                        long fence = super.claim(tenantId, scheduleId,
                                owner, leaseUntil, now);
                        if (fence >= 0) {
                            secondDone.set(true);
                        }
                        return fence;
                    }
                };
        ThreadPoolTaskExecutor rows = rowPool(1);
        try {
            AutomationScanner broken = new AutomationScanner(
                    downAtFirstClaim, connector, settings, clock::get,
                    "scanner-broken-store", rows.getThreadPoolExecutor());
            clock.set(T0 + MINUTE + 1_000);
            assertThatThrownBy(() -> broken.tick(clock.get()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("claim store down");
            assertThat(secondDone).isTrue();
            assertThat(claims.get()).isEqualTo(2);
        } finally {
            rows.destroy();
        }
    }

    @Test
    void commonClaimFailuresProduceOneBoundedSummary() {
        for (int index = 0; index < 5; index++) {
            define("* * * * *", "allow", "none", null, true);
        }
        clock.set(T0 + MINUTE + 1_000);
        List<ScheduleRow> candidates = ledger.findArmed(clock.get(), 100);
        IllegalStateException firstFailure = new IllegalStateException(
                "claim store down");
        AtomicInteger claims = new AtomicInteger();
        AutomationLedgerStore downAtClaim = new AutomationLedgerStore(jdbc) {
            @Override
            public long claim(String tenantId, String scheduleId,
                    String owner, long leaseUntil, long now) {
                if (claims.incrementAndGet() == 1) {
                    throw firstFailure;
                }
                throw new IllegalStateException("claim store down "
                        + scheduleId);
            }
        };
        AutomationScanner broken = new AutomationScanner(downAtClaim,
                connector, settings, clock::get, "scanner-down-store");
        Logger log = (Logger) LoggerFactory.getLogger(AutomationScanner.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        log.addAppender(logged);
        try {
            assertThatThrownBy(() -> broken.tick(clock.get()))
                    .isSameAs(firstFailure);
            assertThat(claims.get()).isEqualTo(5);
            assertThat(logged.list).hasSize(1);
            ILoggingEvent summary = logged.list.getFirst();
            assertThat(summary.getThrowableProxy()).isNull();
            assertThat(summary.getFormattedMessage())
                    .contains("additionalObservedTaskFailures=4", "submitted=5");
            for (ScheduleRow row : candidates.subList(0, 3)) {
                assertThat(summary.getFormattedMessage())
                        .contains("tenant=" + row.tenantId(),
                                "schedule=" + row.scheduleId());
            }
            for (ScheduleRow row : candidates.subList(3, 5)) {
                assertThat(summary.getFormattedMessage())
                        .doesNotContain(row.scheduleId());
            }
        } finally {
            log.detachAppender(logged);
            logged.stop();
        }
    }

    @Test
    void aMessageLessRowFailureKeepsItsIdentityInTheSummary() {
        // The summary is the only record of an additional failure, so an
        // exception without a message must name its class rather than
        // render as "failure=null".
        define("* * * * *", "allow", "none", null, true);
        define("* * * * *", "allow", "none", null, true);
        clock.set(T0 + MINUTE + 1_000);
        AtomicInteger claims = new AtomicInteger();
        AutomationLedgerStore downAtClaim = new AutomationLedgerStore(jdbc) {
            @Override
            public long claim(String tenantId, String scheduleId,
                    String owner, long leaseUntil, long now) {
                if (claims.incrementAndGet() == 1) {
                    throw new IllegalStateException("claim store down");
                }
                throw new IllegalStateException();
            }
        };
        AutomationScanner broken = new AutomationScanner(downAtClaim,
                connector, settings, clock::get, "scanner-silent-store");
        Logger log = (Logger) LoggerFactory.getLogger(AutomationScanner.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        log.addAppender(logged);
        try {
            assertThatThrownBy(() -> broken.tick(clock.get()))
                    .hasMessage("claim store down");
            assertThat(logged.list).hasSize(1);
            String summary = logged.list.getFirst().getFormattedMessage();
            assertThat(summary).contains("failure="
                    + IllegalStateException.class.getName());
            assertThat(summary).doesNotContain("failure=null");
        } finally {
            log.detachAppender(logged);
            logged.stop();
        }
    }

    @Test
    void theScannerWorksRowsOnItsOwnBoundedPool() {
        ThreadPoolTaskExecutor executor = applicationContext.getBean(
                "automationScannerExecutor", ThreadPoolTaskExecutor.class);
        assertThat(executor).isNotSameAs(applicationContext.getBean(
                "managedAutomationScheduler"));
        assertThat(executor.getThreadNamePrefix())
                .isEqualTo("automation-scan-");
        ManagedAgentProperties properties = applicationContext
                .getBean(ManagedAgentProperties.class);
        int threads = properties.getAutomation().getScannerThreads();
        assertThat(executor.getCorePoolSize()).isEqualTo(threads);
        assertThat(executor.getMaxPoolSize()).isEqualTo(threads);
        // The scan tick joins on the row pool, so the scheduler must stay a
        // one-thread driver: scanning on its own pool would deadlock the
        // tick on the pool's only thread.
        ThreadPoolTaskScheduler scheduler = (ThreadPoolTaskScheduler)
                applicationContext.getBean("managedAutomationScheduler");
        assertThat(scheduler.getPoolSize()).isEqualTo(1);
    }

    @Test
    void aRowBothQueriesReturnIsSubmittedOnce() {
        // A row whose answer was lost comes back from the firing query, and
        // the next due slot brings the same row back from the armed query.
        // Deduping on (tenant, schedule) is the only thing keeping it one
        // task: without it the second task races the first row's claim.
        PublicAutomation automation = define("* * * * *", "skip", "none", null,
                true);
        fake.failNextFire = new IllegalStateException("answer lost");
        clock.set(T0 + MINUTE + 1_000);
        assertThat(scanner.tick(clock.get())).isZero();
        // Past the lost answer's retry backoff, the same row answers both
        // queries: the firing one for the stuck occurrence, the armed one
        // for the slot that came due meanwhile.
        clock.set(T0 + 2 * MINUTE + 1_000);
        assertThat(ledger.findFiringSchedules(clock.get(), 100))
                .extracting(ScheduleRow::scheduleId)
                .contains(automation.id());
        assertThat(ledger.findArmed(clock.get(), 100))
                .extracting(ScheduleRow::scheduleId)
                .contains(automation.id());
        AtomicInteger claims = new AtomicInteger();
        AutomationLedgerStore counting = new AutomationLedgerStore(jdbc) {
            @Override
            public long claim(String tenantId, String scheduleId, String owner,
                    long leaseUntil, long now) {
                if (scheduleId.equals(automation.id())) {
                    claims.incrementAndGet();
                }
                return super.claim(tenantId, scheduleId, owner, leaseUntil,
                        now);
            }
        };
        ThreadPoolTaskExecutor rows = rowPool(2);
        try {
            AutomationScanner pooled = new AutomationScanner(counting,
                    connector, settings, clock::get, "scanner-dedupe",
                    rows.getThreadPoolExecutor());
            pooled.tick(clock.get());
        } finally {
            rows.destroy();
        }
        assertThat(claims.get()).isEqualTo(1);
        // The armed task is the one that has to win: only it derives slots,
        // so a tick that kept just the firing task would still claim once
        // yet never record the slot that came due meanwhile.
        assertThat(ledger.listOccurrences(tenant, automation.id(), null, 100)
                .rows().stream()
                .map(OccurrenceView::occurrence)
                .map(AutomationLedgerStore.OccurrenceRow::occurrenceKey))
                .contains("schedule:2026-06-01T10:02:00Z");
    }

    @Test
    void anInterruptedJoinReportsTheInterruptAndLeavesTheRowItsClaim() {
        // Context close interrupts the joining thread. The tick stops
        // joining, re-asserts the interrupt and reports it as the tick's
        // failure; the row task already running keeps its own durable claim
        // instead of being shut down under it.
        PublicAutomation automation = define("* * * * *", "allow", "none",
                null, true);
        CountDownLatch claimEntered = new CountDownLatch(1);
        CountDownLatch releaseClaim = new CountDownLatch(1);
        CountDownLatch rowReleased = new CountDownLatch(1);
        AtomicLong fence = new AtomicLong(-1);
        AutomationLedgerStore slowClaim = new AutomationLedgerStore(jdbc) {
            @Override
            public long claim(String tenantId, String scheduleId, String owner,
                    long leaseUntil, long now) {
                claimEntered.countDown();
                awaitLatch(releaseClaim);
                long claimed = super.claim(tenantId, scheduleId, owner,
                        leaseUntil, now);
                fence.set(claimed);
                return claimed;
            }

            @Override
            public void release(String tenantId, String scheduleId,
                    String owner, long released, long now) {
                try {
                    super.release(tenantId, scheduleId, owner, released, now);
                } finally {
                    rowReleased.countDown();
                }
            }
        };
        ThreadPoolTaskExecutor rows = rowPool(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicBoolean interrupted = new AtomicBoolean();
        try {
            AutomationScanner blocked = new AutomationScanner(slowClaim,
                    connector, settings, clock::get, "scanner-interrupted",
                    rows.getThreadPoolExecutor());
            clock.set(T0 + MINUTE + 1_000);
            Thread joining = new Thread(() -> {
                try {
                    blocked.tick(clock.get());
                } catch (RuntimeException error) {
                    failure.set(error);
                    interrupted.set(Thread.currentThread().isInterrupted());
                }
            }, "automation-join-under-test");
            joining.start();
            awaitLatch(claimEntered);
            joining.interrupt();
            try {
                joining.join(TimeUnit.SECONDS.toMillis(10));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
            }
            assertThat(joining.isAlive()).isFalse();
            assertThat(failure.get()).isInstanceOf(IllegalStateException.class)
                    .hasCauseInstanceOf(InterruptedException.class);
            assertThat(interrupted).isTrue();
            releaseClaim.countDown();
            awaitLatch(rowReleased);
            assertThat(fence.get()).isGreaterThanOrEqualTo(0);
            assertThat(occurrence(automation.id(),
                    "schedule:2026-06-01T10:01:00Z").outcome())
                    .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        } finally {
            releaseClaim.countDown();
            rows.destroy();
        }
    }

    /** A fake connector whose fires run a test hook before answering. */
    static final class HookedConnector extends FakeConnector {
        private volatile Consumer<Map<String, Object>> onFire = body -> {};

        HookedConnector(AutomationHarnessFake fake) {
            super(fake);
        }

        @Override
        public Map<String, Object> runAutomationOperation(String tenantId,
                String sessionId, Map<String, Object> body) {
            if ("fire_run".equals(body.get("kind"))) {
                onFire.accept(body);
            }
            return super.runAutomationOperation(tenantId, sessionId, body);
        }
    }

    /** The connector the control plane sees: only the automation verb answers. */
    static class FakeConnector implements HarnessConnector {
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
