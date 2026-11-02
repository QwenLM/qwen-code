package com.alibaba.qwen.code.managedagent.automation;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.OccurrenceRow;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * #15418: the row pool's multi-node invariants under real InnoDB. The H2
 * unit suite pins the logic; only the production database's row locks and
 * isolation prove the claim guard, the fenced settle and the two-scanner
 * one-run-per-occurrence contract once rows are worked in parallel.
 */
class AutomationScannerConcurrencyMySqlIT {
    private static final long T0 = Instant.parse("2026-06-01T10:00:00Z")
            .toEpochMilli();
    private static final String TENANT = "tenant-pool-it";
    private static final String SESSION = "session-pool-it";

    private IsolatedManagedSchemaMySqlTestDatabase database;
    private JdbcTemplate jdbc;
    private AutomationLedgerStore store;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        store = new AutomationLedgerStore(jdbc);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id,"
                        + " agent_id, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'agent', 0, 0)",
                TENANT, SESSION);
    }

    @AfterEach
    void cleanUp() {
        if (database != null) {
            database.close();
        }
    }

    private void arm(String scheduleId, long now) {
        jdbc.update("INSERT INTO ma_schedule (tenant_id, schedule_id,"
                        + " session_id, workspace_id, actor_id,"
                        + " record_revision, definition_revision,"
                        + " definition_digest, goal, cron, timezone,"
                        + " session_mode, overlap, catch_up, enabled, state,"
                        + " armed_at, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, 'workspace', 'actor', 1, 1,"
                        + " 'digest', 'Goal', '* * * * *', 'UTC', 'default',"
                        + " 'allow', 'none', TRUE, 'live', ?, ?, ?)",
                TENANT, scheduleId, SESSION, T0, now, now);
    }

    @Test
    void racingClaimsReachExactlyOneFenceWinner() throws Exception {
        arm("schedule-race", T0);
        ExecutorService threads = Executors.newFixedThreadPool(2);
        try {
            for (int round = 0; round < 20; round++) {
                CountDownLatch start = new CountDownLatch(1);
                Future<Long> first = threads.submit(() -> {
                    start.await();
                    return store.claim(TENANT, "schedule-race", "owner-one",
                            T0 + 60_000, T0);
                });
                Future<Long> second = threads.submit(() -> {
                    start.await();
                    return store.claim(TENANT, "schedule-race", "owner-two",
                            T0 + 60_000, T0);
                });
                start.countDown();
                long one = first.get(10, TimeUnit.SECONDS);
                long two = second.get(10, TimeUnit.SECONDS);
                assertThat(one > 0).as("round %d: exactly one wins", round)
                        .isNotEqualTo(two > 0);
                jdbc.update("UPDATE ma_schedule SET lease_owner = NULL,"
                                + " lease_until = NULL, fence = 0"
                                + " WHERE tenant_id = ? AND schedule_id = ?",
                        TENANT, "schedule-race");
            }
        } finally {
            threads.shutdownNow();
        }
    }

    @Test
    void aStaleOwnerCannotMoveTheLedgerAfterATakeover() {
        arm("schedule-stale", T0);
        long stale = store.claim(TENANT, "schedule-stale", "owner-stale",
                T0 + 5_000, T0);
        assertThat(stale).isPositive();
        long takenAt = T0 + 6_000;
        long live = store.claim(TENANT, "schedule-stale", "owner-live",
                takenAt + 60_000, takenAt);
        assertThat(live).isGreaterThan(stale);
        ScheduleRow row = store.findSchedule(TENANT, "schedule-stale")
                .orElseThrow();
        String key = "schedule:2026-06-01T10:01:00Z";
        store.recordOccurrence(OccurrenceRow.decision(row, key,
                T0 + 60_000L, AutomationScanner.TRIGGER_MANUAL,
                AutomationLedgerStore.OUTCOME_FIRING, null, live, takenAt),
                "owner-live");
        assertThat(store.settleOccurrence(TENANT, "schedule-stale", key,
                AutomationLedgerStore.OUTCOME_FIRED, null, "owner-stale",
                stale, takenAt)).isFalse();
        assertThat(store.settleOccurrence(TENANT, "schedule-stale", key,
                AutomationLedgerStore.OUTCOME_FIRED, null, "owner-live",
                live, takenAt)).isTrue();
        assertThat(store.findOccurrence(TENANT, "schedule-stale", key)
                .orElseThrow().outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
    }

    @Test
    void twoScannersSettleOneRunPerOccurrenceAcrossThePool() throws Exception {
        arm("schedule-shared", T0);
        ManagedAgentProperties.Automation settings =
                new ManagedAgentProperties.Automation();
        settings.setEnabled(true);
        settings.setLease(Duration.ofSeconds(60));
        settings.setLateTolerance(Duration.ofMinutes(5));
        settings.setLookback(Duration.ofHours(24));
        DeliveredConnector connector = new DeliveredConnector();
        AtomicLong clock = new AtomicLong(T0 + 61_000);
        ExecutorService firstPool = Executors.newFixedThreadPool(2);
        ExecutorService secondPool = Executors.newFixedThreadPool(2);
        try {
            AutomationScanner first = new AutomationScanner(store, connector,
                    settings, clock::get, "scanner-mysql-first", firstPool);
            AutomationScanner second = new AutomationScanner(store, connector,
                    settings, clock::get, "scanner-mysql-second", secondPool);
            ExecutorService ticks = Executors.newFixedThreadPool(2);
            try {
                CountDownLatch start = new CountDownLatch(1);
                Future<Integer> firstTick = ticks.submit(() -> {
                    start.await();
                    return first.tick(clock.get());
                });
                Future<Integer> secondTick = ticks.submit(() -> {
                    start.await();
                    return second.tick(clock.get());
                });
                start.countDown();
                int fired = firstTick.get(15, TimeUnit.SECONDS)
                        + secondTick.get(15, TimeUnit.SECONDS);
                assertThat(fired).isEqualTo(1);
            } finally {
                ticks.shutdownNow();
            }
        } finally {
            firstPool.shutdownNow();
            secondPool.shutdownNow();
        }
        assertThat(store.findOccurrence(TENANT, "schedule-shared",
                "schedule:2026-06-01T10:01:00Z").orElseThrow().outcome())
                .isEqualTo(AutomationLedgerStore.OUTCOME_FIRED);
        assertThat(connector.fires.get()).isEqualTo(1);
    }

    /** The automation verb answers delivered; everything else is out of scope here. */
    private static final class DeliveredConnector implements HarnessConnector {
        private final AtomicInteger fires = new AtomicInteger();

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public Map<String, Object> runAutomationOperation(String tenantId,
                String sessionId, Map<String, Object> body) {
            if ("fire_run".equals(body.get("kind"))) {
                fires.incrementAndGet();
            }
            return Map.of("operationId", String.valueOf(body.get("operationId")),
                    "state", "settled");
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
