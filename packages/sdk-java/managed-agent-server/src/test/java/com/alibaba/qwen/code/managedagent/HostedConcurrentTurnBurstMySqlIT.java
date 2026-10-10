package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

// Reproduction driver for #13333: bursts of N concurrent managed Turns on
// the same tenant must keep making store-path progress and settle. The
// whole Spring stack runs for real (dispatcher, lease renewer, event
// batching, message materializer); only the Hosted Harness is a fixture
// that answers instantly, mirroring the report's fake provider. A lock
// convoy shows up as (a) turns still ACTIVE at the deadline, (b) a 20 s
// window with zero durable event progress, or (c) lease-renewal failures
// logged by the coordinator. InnoDB lock-wait samples and, on stall, the
// full InnoDB status are captured as evidence.
//
// Requires a real MySQL 8 server: pass -Dmysql.url/-Dmysql.user/
// -Dmysql.password (defaults match a local throwaway server on 13306).
@SpringBootTest(properties = {
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.runtime-broker.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=50ms",
        "qwen.managed-agent.events.poll-interval=10ms",
        "qwen.managed-agent.events.materialize-interval=10ms"})
@AutoConfigureMockMvc
@Import(HostedConcurrentTurnBurstMySqlIT.BurstHarnessConfiguration.class)
class HostedConcurrentTurnBurstMySqlIT {
    private static final Duration ROUND_DEADLINE = Duration.ofSeconds(150);
    private static final Duration SILENCE_LIMIT = Duration.ofSeconds(20);
    private static final int[] BURST_SIZES = {4, 8, 12};
    private static final int DELTAS_PER_TURN = Integer.getInteger(
            "issue13333.deltas", 400);
    // The stagger-0 phase pins the #13333 admission deadlock: concurrent
    // same-tenant admissions used to gap-lock the shared store indexes.
    // The staggered phase then serializes admissions so the probe reaches
    // the streaming phase and can watch for a store-path progress convoy.
    private static final long SUBMIT_STAGGER_MS = Long.getLong(
            "issue13333.stagger-ms", 500L);

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",
                HostedConcurrentTurnBurstMySqlIT::mysqlUrl);
        registry.add("spring.datasource.username",
                () -> System.getProperty("mysql.user", "root"));
        registry.add("spring.datasource.password",
                () -> System.getProperty("mysql.password", ""));
        registry.add("spring.datasource.driver-class-name",
                () -> "com.mysql.cj.jdbc.Driver");
    }

    private static String mysqlUrl() {
        return System.getProperty("mysql.url",
                "jdbc:mysql://127.0.0.1:13306/issue13333"
                        + "?createDatabaseIfNotExist=true"
                        + "&allowPublicKeyRetrieval=true&useSSL=false");
    }

    @Test
    @Timeout(600)
    void turnBurstsSettleWithoutLockConvoy() throws Exception {
        Map<String, Object> database = jdbc.queryForMap(
                "SELECT VERSION() AS version, @@version_comment AS engine");
        System.out.println("ISSUE13333 database " + database);
        assertThat(database.get("version").toString())
                .doesNotContainIgnoringCase("mariadb");
        assertThat(database.get("version").toString()).startsWith("8.");
        List<String> failures = new ArrayList<>();
        for (int burst : BURST_SIZES) {
            failures.addAll(runBurst(burst, 0));
        }
        for (int burst : BURST_SIZES) {
            failures.addAll(runBurst(burst, SUBMIT_STAGGER_MS));
        }
        assertThat(failures).as("burst rounds free of lock/stall failures")
                .isEmpty();
    }

    private List<String> runBurst(int burst, long staggerMs)
            throws Exception {
        String tenant = "burst-" + burst + "-" + UUID.randomUUID();
        Logger coordinator = (Logger) LoggerFactory.getLogger(
                HarnessCoordinator.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        coordinator.addAppender(logs);
        LockMonitor monitor = new LockMonitor();
        long[] releasedAt = new long[1];
        CyclicBarrier createBarrier = new CyclicBarrier(burst);
        CyclicBarrier submitBarrier = new CyclicBarrier(burst,
                () -> releasedAt[0] = System.nanoTime());
        ExecutorService clients = Executors.newFixedThreadPool(burst);
        monitor.start();
        try {
            List<Future<Submitted>> futures = new ArrayList<>();
            for (int slot = 0; slot < burst; slot++) {
                futures.add(clients.submit(participant(tenant, slot,
                        createBarrier, submitBarrier, staggerMs)));
            }
            clients.shutdown();
            List<Submitted> turns = new ArrayList<>();
            for (Future<Submitted> future : futures) {
                turns.add(future.get(90, TimeUnit.SECONDS));
            }
            return observe(tenant, burst, staggerMs, releasedAt[0], turns,
                    logs, monitor);
        } finally {
            coordinator.detachAppender(logs);
            monitor.close();
            clients.shutdownNow();
        }
    }

    private Callable<Submitted> participant(String tenant, int slot,
            CyclicBarrier createBarrier, CyclicBarrier submitBarrier,
            long staggerMs) {
        return () -> {
            createBarrier.await(60, TimeUnit.SECONDS);
            long createStart = System.nanoTime();
            MvcResult created = mvc.perform(post(
                            "/api/agent/web-shell/v1/sessions/create")
                            .header(TenantContextFilter.HEADER, tenant)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"idempotencyKey\":\""
                                    + UUID.randomUUID()
                                    + "\",\"agentId\":\"qwen-code\","
                                    + "\"input\":[]}")).andReturn();
            long createMs = elapsedMs(createStart);
            if (created.getResponse().getStatus() != 202) {
                submitBarrier.await(60, TimeUnit.SECONDS);
                return new Submitted(null, null, createMs, -1,
                        "create:" + created.getResponse().getStatus()
                                + " " + created.getResponse()
                                        .getContentAsString());
            }
            String sessionId = objectMapper.readTree(created.getResponse()
                    .getContentAsString()).get("sessionId").asText();
            submitBarrier.await(60, TimeUnit.SECONDS);
            if (staggerMs > 0) {
                Thread.sleep(slot * staggerMs);
            }
            long submitStart = System.nanoTime();
            MvcResult submitted = mvc.perform(post(
                            "/api/agent/web-shell/v1/turns/submit")
                            .header(TenantContextFilter.HEADER, tenant)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"idempotencyKey\":\""
                                    + UUID.randomUUID()
                                    + "\",\"sessionId\":\"" + sessionId
                                    + "\",\"input\":[{\"type\":\"text\","
                                    + "\"text\":\"burst-" + slot + "\"}]}"))
                    .andReturn();
            long submitMs = elapsedMs(submitStart);
            if (submitted.getResponse().getStatus() != 202) {
                return new Submitted(sessionId, null, createMs, submitMs,
                        "submit:" + submitted.getResponse().getStatus()
                                + " " + submitted.getResponse()
                                        .getContentAsString());
            }
            String turnId = objectMapper.readTree(submitted.getResponse()
                    .getContentAsString()).get("turnId").asText();
            return new Submitted(sessionId, turnId, createMs, submitMs,
                    null);
        };
    }

    private List<String> observe(String tenant, int burst, long staggerMs,
            long releasedAt, List<Submitted> turns,
            ListAppender<ILoggingEvent> logs, LockMonitor monitor)
            throws Exception {
        long deadline = releasedAt + ROUND_DEADLINE.toNanos();
        long lastProgressAt = releasedAt;
        long lastTotal = -1;
        Map<String, Long> firstDeltaAt = new HashMap<>();
        boolean stall = false;
        int pending = burst;
        observe:
        while (System.nanoTime() < deadline) {
            long now = System.nanoTime();
            long total = 0;
            for (Map<String, Object> row : jdbc.queryForList(
                    "SELECT session_id, COUNT(*) AS deltas FROM"
                            + " managed_agent_event WHERE tenant_id = ? AND"
                            + " event_type = 'item.output_text.delta' GROUP"
                            + " BY session_id", tenant)) {
                total += ((Number) row.get("deltas")).longValue();
                firstDeltaAt.putIfAbsent(
                        row.get("session_id").toString(), now);
            }
            if (total != lastTotal) {
                lastProgressAt = now;
                lastTotal = total;
            }
            pending = activeTurns(tenant);
            if (pending == 0) {
                break observe;
            }
            if (!stall && now - lastProgressAt > SILENCE_LIMIT.toNanos()) {
                stall = true;
                captureDiagnostics(tenant, burst, "silence");
            }
            Thread.sleep(200);
        }
        long settleMs = elapsedMs(releasedAt);
        int failed = countTurns(tenant, "FAILED")
                + countTurns(tenant, "CANCELLED");
        long renewFailures = logs.list.stream()
                .filter(event -> event.getFormattedMessage()
                        .contains("lease renewal failed"))
                .count();
        long cannotAcquire = logs.list.stream()
                .filter(event -> event.getFormattedMessage()
                        .contains("CannotAcquireLockException"))
                .count();
        List<String> admissionFailures = turns.stream()
                .map(Submitted::failure).filter(Objects::nonNull)
                .toList();
        long maxFirstDeltaMs = firstDeltaAt.values().stream()
                .mapToLong(at -> TimeUnit.NANOSECONDS.toMillis(
                        at - releasedAt)).max().orElse(-1);
        if (pending > 0 || !admissionFailures.isEmpty()) {
            captureDiagnostics(tenant, burst,
                    pending > 0 ? "deadline" : "admission");
        }
        System.out.printf("ISSUE13333 round staggerMs=%d burst=%d turns=%d"
                        + " pending=%d failed=%d admissionFailures=%d"
                        + " renewFailureLogs=%d cannotAcquireLock=%d"
                        + " firstDeltaMs<=" + maxFirstDeltaMs
                        + " settleMs=%d stall=%b%n",
                staggerMs, burst, turns.size() - admissionFailures.size(),
                pending, failed, admissionFailures.size(), renewFailures,
                cannotAcquire, settleMs, stall);
        System.out.println("ISSUE13333 locks burst=" + burst
                + " maxConcurrentLockWaits=" + monitor.maxWaiters()
                + " lockWaitSamples=" + monitor.waitSamples());
        admissionFailures.forEach(failure ->
                System.out.println("ISSUE13333 admission burst=" + burst
                        + " " + failure));
        List<String> failures = new ArrayList<>();
        if (!admissionFailures.isEmpty()) {
            failures.add("burst=" + burst + " admission failures: "
                    + admissionFailures.size());
        }
        if (stall) {
            failures.add("burst=" + burst + " store-path progress silence >"
                    + SILENCE_LIMIT);
        }
        if (failed > 0) {
            failures.add("burst=" + burst + " FAILED/CANCELLED turns: "
                    + failed);
        }
        if (renewFailures > 0) {
            failures.add("burst=" + burst + " dispatch lease renewal"
                    + " failures: " + renewFailures);
        }
        if (pending > 0) {
            failures.add("burst=" + burst + " turns still ACTIVE at the "
                    + ROUND_DEADLINE + " deadline: " + pending);
        }
        return failures;
    }

    private int activeTurns(String tenant) {
        return countTurns(tenant, "ACCEPTED") + countTurns(tenant, "RUNNING")
                + countTurns(tenant, "CANCELLING");
    }

    private int countTurns(String tenant, String status) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " status = ?", Integer.class, tenant, status);
        return count == null ? 0 : count;
    }

    private void captureDiagnostics(String tenant, int burst, String why) {
        try {
            String id = why + "-burst" + burst + "-" + tenant;
            List<Map<String, Object>> status = jdbc.queryForList(
                    "SHOW ENGINE INNODB STATUS");
            Object text = status.isEmpty() ? "" : status.getFirst().get("Status");
            Path directory = Path.of(System.getProperty("java.io.tmpdir"),
                    "issue13333");
            Files.createDirectories(directory);
            Files.writeString(directory.resolve(id + "-innodb-status.txt"),
                    text == null ? "" : text.toString(),
                    StandardCharsets.UTF_8);
            Files.writeString(directory.resolve(id + "-innodb-trx.txt"),
                    jdbc.queryForList("SELECT * FROM"
                            + " information_schema.innodb_trx").toString(),
                    StandardCharsets.UTF_8);
            Files.writeString(directory.resolve(id + "-processlist.txt"),
                    jdbc.queryForList("SHOW FULL PROCESSLIST").toString(),
                    StandardCharsets.UTF_8);
            System.out.println("ISSUE13333 diagnostics captured " + directory
                    + "/" + id + "-*.txt");
        } catch (Exception error) {
            System.out.println("ISSUE13333 diagnostics capture failed: "
                    + error);
        }
    }

    private static long elapsedMs(long startNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
    }

    private record Submitted(String sessionId, String turnId, long createMs,
            long submitMs, String failure) {
    }

    private static final class LockMonitor implements AutoCloseable {
        private final JdbcTemplate raw;
        private final Thread thread;
        private final AtomicBoolean running = new AtomicBoolean(true);
        private final AtomicInteger maxWaiters = new AtomicInteger();
        private final AtomicInteger waitSamples = new AtomicInteger();

        LockMonitor() {
            DataSource source = new DriverManagerDataSource(mysqlUrl(),
                    System.getProperty("mysql.user", "root"),
                    System.getProperty("mysql.password", ""));
            raw = new JdbcTemplate(source);
            raw.setQueryTimeout(5);
            thread = new Thread(this::sampleLoop, "issue13333-lock-monitor");
            thread.setDaemon(true);
        }

        void start() {
            thread.start();
        }

        int maxWaiters() {
            return maxWaiters.get();
        }

        int waitSamples() {
            return waitSamples.get();
        }

        private void sampleLoop() {
            while (running.get()) {
                try {
                    Integer waiting = raw.queryForObject("SELECT COUNT(*)"
                                    + " FROM information_schema.innodb_trx"
                                    + " WHERE trx_state = 'LOCK WAIT'",
                            Integer.class);
                    if (waiting != null && waiting > 0) {
                        waitSamples.incrementAndGet();
                        maxWaiters.accumulateAndGet(waiting, Math::max);
                    }
                } catch (RuntimeException error) {
                    System.out.println("ISSUE13333 lock monitor sample failed: "
                            + error);
                }
                try {
                    Thread.sleep(200);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }

        @Override
        public void close() throws InterruptedException {
            running.set(false);
            thread.join(5000);
        }
    }

    @TestConfiguration
    static class BurstHarnessConfiguration {
        @Bean
        @Primary
        BurstHarness burstHarness() {
            return new BurstHarness();
        }
    }

    // A Hosted Harness that behaves like the report's instantly-answered
    // model: every Turn streams DELTAS_PER_TURN text chunks and a
    // turn_complete with no delay.
    static final class BurstHarness implements HarnessConnector {
        static final String BOOT_ID = UUID.randomUUID().toString();
        private final Map<String, String> promptIds =
                new ConcurrentHashMap<>();

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public Attachment createOrLoad(String tenantId, String sessionId,
                boolean loadExisting) {
            return new Attachment(BOOT_ID, null);
        }

        @Override
        public Admission submit(String tenantId, String sessionId,
                String promptId, List<Map<String, Object>> input,
                String payloadDigest) {
            promptIds.put(sessionId, promptId);
            return new Admission(0, "epoch-1");
        }

        @Override
        public SourceStream stream(String tenantId, String sessionId,
                long lastEventId, String eventEpoch) {
            String promptId = promptIds.get(sessionId);
            AtomicLong sequence = new AtomicLong(lastEventId + 1);
            return new SourceStream() {
                @Override
                public String eventEpoch() {
                    return "epoch-1";
                }

                @Override
                public SourceEvent next() {
                    long id = sequence.getAndIncrement();
                    if (id <= DELTAS_PER_TURN) {
                        return new SourceEvent(id, "session_update", Map.of(
                                "update", Map.of(
                                        "sessionUpdate",
                                        "agent_message_chunk",
                                        "content", Map.of("type", "text",
                                                "text", "delta-" + id + "-"
                                                        + "x".repeat(48)))),
                                promptId, Map.of());
                    }
                    if (id == DELTAS_PER_TURN + 1) {
                        return new SourceEvent(id, "turn_complete",
                                Map.of("stopReason", "end_turn"), promptId,
                                Map.of());
                    }
                    return null;
                }

                @Override
                public void close() {
                }
            };
        }

        @Override
        public void cancel(String tenantId, String sessionId) {
        }

        @Override
        public void rename(String tenantId, String sessionId, String title) {
        }

        @Override
        public String closeSession(String tenantId, String sessionId) {
            return BOOT_ID;
        }
    }
}
