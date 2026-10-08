package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.OccurrenceRow;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.OccurrenceView;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.StaleMirror;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * H6b: the automation scanner. It discovers candidates and claims them; it
 * never drives a model. Each tick refreshes the definition mirror from the
 * committed records, claims every armed definition under its lease and
 * fence, derives the slots of the window since the covered watermark on
 * the host tz database, records one decision per slot — fired, skipped or
 * missed, by the overlap and catch-up policies — and fires an occurrence as
 * one idempotent Harness operation whose claim row was durable first. A
 * claim whose answer was lost is re-driven by later ticks with bounded
 * backoff and, past the bound, recorded unknown — never guessed; a scanner
 * that lost its lease cannot move the ledger. See
 * docs/design/2026-10-07-managed-automation-runtime.md, decisions 5–8.
 */
@Service
public class AutomationScanner {
    private static final Logger LOG = LoggerFactory
            .getLogger(AutomationScanner.class);
    private static final int SCAN_LIMIT = 100;
    private static final int MIRROR_LIMIT = 200;
    /** Re-drives of one claim before its answer is recorded unknown. */
    static final int MAX_FIRE_ATTEMPTS = 64;
    public static final String TRIGGER_SCHEDULED = "scheduled";
    public static final String TRIGGER_MANUAL = "manual";
    public static final String TRIGGER_CATCH_UP = "catch_up";
    public static final String REASON_OVERLAP = "overlap";
    public static final String REASON_COUNT_LIMIT = "count_limit";
    public static final String REASON_SESSION_NOT_ACTIVE = "session_not_active";
    public static final String REASON_REVISION_STALE = "revision_stale";
    public static final String REASON_DEFINITION_RETIRED = "definition_retired";
    public static final String REASON_ANSWER_UNOBTAINABLE = "answer_unobtainable";

    private final AutomationLedgerStore store;
    private final HarnessConnector harness;
    private final ObjectMapper mapper;
    private final ManagedAgentProperties.Automation settings;
    private final Supplier<Long> clock;
    private final String owner;

    @Autowired
    public AutomationScanner(AutomationLedgerStore store,
            HarnessConnector harness, ObjectMapper mapper,
            ManagedAgentProperties properties) {
        this(store, harness, mapper, properties.getAutomation(),
                System::currentTimeMillis, "automation-" + UUID.randomUUID());
    }

    AutomationScanner(AutomationLedgerStore store, HarnessConnector harness,
            ObjectMapper mapper, ManagedAgentProperties.Automation settings,
            Supplier<Long> clock, String owner) {
        this.store = store;
        this.harness = harness;
        this.mapper = mapper;
        this.settings = settings;
        this.clock = clock;
        this.owner = owner;
    }

    @Scheduled(scheduler = "managedAutomationScheduler", fixedDelayString =
            "${qwen.managed-agent.automation.scan-delay:10s}")
    public void scan() {
        if (!settings.isEnabled()) {
            return;
        }
        try {
            tick(clock.get());
        } catch (RuntimeException error) {
            LOG.warn("automation scan failed failure={}", error.getMessage(),
                    error);
        }
    }

    /** One tick at {@code now}; answers how many occurrences fired. */
    public int tick(long now) {
        refreshMirrors(now);
        int fired = 0;
        for (ScheduleRow row : store.findArmed(now, SCAN_LIMIT)) {
            fired += claimed(row, now, true);
        }
        // Claims whose answer was lost belong to live definitions whether
        // or not they are still armed: a disabled definition's manual run
        // is re-driven here.
        for (ScheduleRow row : store.findFiringSchedules(now, SCAN_LIMIT)) {
            fired += claimed(row, now, false);
        }
        return fired;
    }

    private int claimed(ScheduleRow row, long now, boolean deriveSlots) {
        long fence = store.claim(row.tenantId(), row.scheduleId(), owner,
                now + settings.getLease().toMillis(), now);
        if (fence < 0) {
            return 0;
        }
        try {
            // The row as it stands under the lease, not the pre-claim
            // snapshot: a definition disabled or retired meanwhile derives
            // no slots.
            ScheduleRow fresh = store.findSchedule(row.tenantId(),
                    row.scheduleId()).orElse(row);
            int fired = redrive(fresh, fence, now);
            if (deriveSlots && fresh.enabled() && fresh.blockedReason() == null
                    && AutomationLedgerStore.STATE_LIVE.equals(fresh.state())) {
                fired += work(fresh, fence, now);
            }
            return fired;
        } catch (RuntimeException error) {
            LOG.warn("automation scan of definition failed tenant={}"
                    + " schedule={} failure={}", row.tenantId(),
                    row.scheduleId(), error.getMessage(), error);
            return 0;
        } finally {
            store.release(row.tenantId(), row.scheduleId(), owner, fence,
                    clock.get());
        }
    }

    /**
     * The mirror follows the committed records: a definition the service
     * committed but did not mirror (a crash between the two), or a revision
     * another instance committed, is read from its record resource.
     */
    void refreshMirrors(long now) {
        for (StaleMirror stale : store.findStaleMirrors(MIRROR_LIMIT)) {
            refreshMirror(stale, now);
        }
    }

    private Optional<ScheduleRow> refreshMirror(StaleMirror stale, long now) {
        try {
            String content = store.readResource(stale.tenantId(),
                    stale.recordResourceId());
            if (content == null) {
                return Optional.empty();
            }
            JsonNode record = mapper.readTree(content);
            return Optional.of(store.upsertSchedule(mirror(stale, record),
                    now));
        } catch (Exception error) {
            LOG.warn("automation mirror refresh failed tenant={}"
                    + " schedule={} failure={}", stale.tenantId(),
                    stale.scheduleId(), error.getMessage());
            return Optional.empty();
        }
    }

    /** The mirror row of one committed schedule record. */
    public static ScheduleRow mirror(StaleMirror stale, JsonNode record) {
        return scheduleRow(stale.tenantId(), stale.workspaceId(),
                stale.sessionId(), "", stale.revision(), record);
    }

    public static ScheduleRow scheduleRow(String tenantId, String workspaceId,
            String sessionId, String actorId, long recordRevision,
            JsonNode record) {
        String runState = record.required("run").required("state").asText();
        boolean terminal = List.of("settled", "failed", "cancelled")
                .contains(runState);
        JsonNode limit = record.required("catchUpLimit");
        return new ScheduleRow(tenantId, record.required("scheduleId").asText(),
                sessionId, workspaceId, actorId, recordRevision,
                record.required("definitionRevision").asLong(),
                record.required("definitionDigest").asText(),
                record.required("goal").asText(),
                record.required("cron").asText(),
                record.required("timezone").asText(),
                record.required("sessionMode").asText(),
                record.required("overlap").asText(),
                record.required("catchUp").asText(),
                limit.isNull() ? null : limit.asLong(),
                record.required("enabled").asBoolean(),
                terminal ? AutomationLedgerStore.STATE_RETIRED
                        : AutomationLedgerStore.STATE_LIVE,
                null, 0, null, null, null, 0, 0, 0);
    }

    /** Claims whose answer was lost: the same operation, re-driven, each
     * on its own so one refusing row never blocks the others or the slots. */
    private int redrive(ScheduleRow row, long fence, long now) {
        int fired = 0;
        for (OccurrenceRow firing : store.findFiring(row.tenantId(),
                row.scheduleId(), now)) {
            try {
                if (fire(row, firing, owner, fence, now)) {
                    fired++;
                }
            } catch (RuntimeException error) {
                defer(row, firing, owner, fence, error, now);
            }
        }
        return fired;
    }

    private int work(ScheduleRow row, long fence, long now) {
        ZoneId zone = CronSlots.resolve(row.timezone()).orElse(null);
        CronSlots.Matcher matcher;
        try {
            matcher = zone == null ? null : CronSlots.compile(row.cron());
        } catch (IllegalArgumentException error) {
            matcher = null;
        }
        if (zone == null || matcher == null) {
            store.block(row.tenantId(), row.scheduleId(), owner, fence,
                    zone == null ? "timezone " + row.timezone()
                            + " does not resolve on this host"
                            : "cron " + row.cron() + " does not compile",
                    now);
            return 0;
        }
        long from = Math.max(row.armedAt(), now - settings.getLookback()
                .toMillis());
        if (row.watermarkSlot() != null) {
            from = Math.max(from, row.watermarkSlot());
        }
        CronSlots.Slots window = CronSlots.between(matcher, zone, from, now,
                settings.getMaxSlotsPerTick());
        if (window.truncated()) {
            LOG.warn("automation window cut at its oldest end tenant={}"
                    + " schedule={} kept={}", row.tenantId(), row.scheduleId(),
                    window.slots().size());
        }
        int fired = 0;
        Set<Long> catchUp = catchUpSlots(row, window.slots(), now);
        for (long slot : window.slots()) {
            boolean timely = now - slot <= settings.getLateTolerance()
                    .toMillis();
            if (timely || catchUp.contains(slot)) {
                if (decide(row, fence, slot, timely ? TRIGGER_SCHEDULED
                        : TRIGGER_CATCH_UP, now)) {
                    fired++;
                }
            } else if (record(row, fence, CronSlots.occurrenceKey(slot), slot,
                    TRIGGER_SCHEDULED, AutomationLedgerStore.OUTCOME_MISSED,
                    null, now).isEmpty()) {
                return fired;
            }
        }
        // Every minute up to now is covered: the next tick starts here, and
        // a later revision never re-arms a covered slot.
        long covered = Math.floorDiv(now, 60_000L) * 60_000L;
        if (covered > from) {
            store.advanceWatermark(row.tenantId(), row.scheduleId(), owner,
                    fence, covered, now);
        }
        return fired;
    }

    /** The late slots the catch-up policy fires: none, the newest, or N. */
    private Set<Long> catchUpSlots(ScheduleRow row, List<Long> slots,
            long now) {
        List<Long> late = new ArrayList<>();
        for (long slot : slots) {
            if (now - slot > settings.getLateTolerance().toMillis()) {
                late.add(slot);
            }
        }
        Set<Long> chosen = new HashSet<>();
        int keep = switch (row.catchUp()) {
            case "latest" -> 1;
            case "bounded" -> row.catchUpLimit() == null ? 0
                    : (int) Math.min(row.catchUpLimit(), late.size());
            default -> 0;
        };
        for (int index = Math.max(0, late.size() - keep); index < late.size();
                index++) {
            chosen.add(late.get(index));
        }
        return chosen;
    }

    /**
     * One due slot: an existing decision stands; a target that is not
     * active skips; the overlap policy admits against the active count; an
     * admitted occurrence is recorded firing before the Harness is asked.
     */
    private boolean decide(ScheduleRow row, long fence, long slot,
            String trigger, long now) {
        String key = CronSlots.occurrenceKey(slot);
        if (store.findOccurrence(row.tenantId(), row.scheduleId(), key)
                .isPresent()) {
            return false;
        }
        String refusal = admissionRefusal(row);
        if ((REASON_OVERLAP.equals(refusal) || REASON_COUNT_LIMIT
                .equals(refusal)) && !store.hasOpenTurn(row.tenantId(),
                row.sessionId())) {
            // A run stuck with its Harness dead holds this refusal — and
            // its wake turn's parked lease on the Workspace — for as long
            // as no fire or Turn loads the Session: under overlap `skip`
            // nothing ever will. Ask the Harness to reconcile the blocking
            // runs first: a live one answers unchanged and the refusal
            // stands; a crashed one settles and frees the slot chain and
            // the lease; a definition the Harness reports retired refresh-
            // retires here instead of standing forever.
            ReconcileOutcome outcome = reconcileBlockingRuns(row);
            if (outcome.definitionEnded()) {
                record(row, fence, key, slot, trigger,
                        AutomationLedgerStore.OUTCOME_SKIPPED,
                        REASON_DEFINITION_RETIRED, now);
                return false;
            }
            if (!outcome.resolved().isEmpty()) {
                // The mirror's correction rides the event stream the
                // commit that answered just applied (the host store's
                // commit applies the record synchronously); a mirror that
                // lags is the unit-fake's shape. Price off the recounted
                // active, subtracting only what STILL appears blocking:
                // resolving what the answer proved terminal while the
                // mirror already drops it must not subtract twice.
                int fanOut = Math.max(2, settings.getConcurrency() + 1);
                int after = store.countActive(row.tenantId(),
                        row.scheduleId());
                int lagging = 0;
                Set<String> still = new HashSet<>();
                for (OccurrenceView blocking : store.findBlockingRuns(
                        row.tenantId(), row.scheduleId(), fanOut)) {
                    still.add(blocking.occurrence().occurrenceKey());
                }
                for (String asked : outcome.resolved()) {
                    if (still.contains(asked)) {
                        lagging++;
                    }
                }
                refusal = countRefusal(row, after - lagging);
            }
        }
        if (refusal != null) {
            record(row, fence, key, slot, trigger,
                    AutomationLedgerStore.OUTCOME_SKIPPED, refusal, now);
            return false;
        }
        Optional<OccurrenceRow> occurrence = record(row, fence, key, slot,
                trigger, AutomationLedgerStore.OUTCOME_FIRING, null, now);
        if (occurrence.isEmpty() || !AutomationLedgerStore.OUTCOME_FIRING
                .equals(occurrence.get().outcome())) {
            return false;
        }
        try {
            return fire(row, occurrence.get(), owner, fence, now);
        } catch (RuntimeException error) {
            defer(row, occurrence.get(), owner, fence, error, now);
            return false;
        }
    }

    /**
     * What one decision learned by reconciling: the occurrence keys whose
     * runs the pass provably unblocked, and whether the Harness told the
     * definition — or its Session — is gone for good.
     */
    private record ReconcileOutcome(Set<String> resolved,
            boolean definitionEnded) {
    }

    /**
     * The blocking occurrences of a count-based refusal, reconciled with
     * the Harness: for each it loads its Session — the wake pump's crash
     * classification and aftermath run there — and answers whether the
     * crashed wake turn's run settled, its park cleared and its lease
     * came back. A live run reports untouched; an unanswered reconcile
     * keeps the refusal and the next due slot retries; a retired
     * definition or Session ends here, the way a fired answer's refusal
     * refresh-terminates its mirror.
     */
    private ReconcileOutcome reconcileBlockingRuns(ScheduleRow row) {
        Set<String> resolved = new HashSet<>();
        for (OccurrenceView blocking : store.findBlockingRuns(row.tenantId(),
                row.scheduleId(),
                Math.max(2, settings.getConcurrency() + 1))) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("operationId", UUID.randomUUID().toString());
            body.put("kind", "reconcile_run");
            body.put("scheduleId", row.scheduleId());
            body.put("occurrenceKey", blocking.occurrence().occurrenceKey());
            try {
                Map<String, Object> answer = harness.runAutomationOperation(
                        row.tenantId(), row.sessionId(), body);
                Object run = answer.get("run");
                // Resolution keys on what the ASKED occurrence's run
                // proves, never on the route's repaired flag: the route
                // may have settled a different, older pending input
                // while this run is still live, and the journal
                // vocabulary's `settled` is the mirror's `completed`.
                String state = run instanceof Map<?, ?> summary
                        ? String.valueOf(summary.get("state"))
                        : null;
                if ("settled".equals(state) || "completed".equals(state)
                        || "failed".equals(state) || "cancelled".equals(state)) {
                    resolved.add(blocking.occurrence().occurrenceKey());
                }
            } catch (DaemonHttpException error) {
                String code = errorCode(error);
                if ("automation_retired".equals(code)
                        || "automation_not_found".equals(code)
                        || "hosted_session_not_found".equals(code)) {
                    // The chain — or its Session — is gone for good:
                    // refresh the mirror like a fired answer does instead
                    // of recording skipped-overlap for every future slot.
                    store.retire(row.tenantId(), row.scheduleId(),
                            clock.get());
                    return new ReconcileOutcome(resolved, true);
                }
                // An unanswered reconcile tries nothing further this
                // decision: the refusal it stood behind is the accurate
                // record, and the next due slot re-drives the repair.
                LOG.warn("automation reconcile failed tenant={} schedule={}"
                        + " occurrence={} failure={}", row.tenantId(),
                        row.scheduleId(), blocking.occurrence()
                                .occurrenceKey(), error.getMessage());
            } catch (RuntimeException error) {
                LOG.warn("automation reconcile failed tenant={} schedule={}"
                        + " occurrence={} failure={}", row.tenantId(),
                        row.scheduleId(), blocking.occurrence()
                                .occurrenceKey(), error.getMessage());
            }
        }
        return new ReconcileOutcome(resolved, false);
    }

    /** Why a due occurrence may not fire now, or null when it may. */
    public String admissionRefusal(ScheduleRow row) {
        if (!"ACTIVE".equals(store.sessionStatus(row.tenantId(),
                row.sessionId()))) {
            return REASON_SESSION_NOT_ACTIVE;
        }
        // A public Turn waiting on the Session is retried by the dispatcher
        // with backoff, while the wake pump starts a queued automation input
        // the moment the Session idles: under any overlap policy a new fire
        // would overtake the Turn, and a recurring definition could starve
        // it indefinitely. The waiting Turn goes first.
        if (store.hasOpenTurn(row.tenantId(), row.sessionId())) {
            return REASON_OVERLAP;
        }
        return countRefusal(row,
                store.countActive(row.tenantId(), row.scheduleId()));
    }

    /** The count-based arm of the admission, priced against {@code active}. */
    private String countRefusal(ScheduleRow row, int active) {
        return switch (row.overlap()) {
            case "queue_one" -> active < 2 ? null : REASON_OVERLAP;
            case "allow" -> active < settings.getConcurrency() ? null
                    : REASON_COUNT_LIMIT;
            default -> active < 1 ? null : REASON_OVERLAP;
        };
    }

    private Optional<OccurrenceRow> record(ScheduleRow row, long fence,
            String key, Long slot, String trigger, String outcome,
            String reason, long now) {
        return store.recordOccurrence(OccurrenceRow.decision(row, key, slot,
                trigger, outcome, reason, fence, now), owner);
    }

    /**
     * Fires one firing occurrence through the Harness and settles its row
     * under the caller's lease ({@code owner}, {@code fence}): fired on an
     * answer; a definition that moved under it is re-read once and the row
     * re-pinned to the live revision before a second try, else skipped; a
     * definition that ended skips and retires the mirror. Anything else
     * propagates to the caller's backoff.
     */
    public boolean fire(ScheduleRow row, OccurrenceRow occurrence,
            String owner, long fence, long now) {
        return fire(row, occurrence, owner, fence, now, true);
    }

    private boolean fire(ScheduleRow row, OccurrenceRow occurrence,
            String owner, long fence, long now, boolean mayRepin) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", UUID.randomUUID().toString());
        body.put("kind", "fire_run");
        body.put("scheduleId", row.scheduleId());
        body.put("definitionRevision", occurrence.definitionRevision());
        body.put("occurrenceKey", occurrence.occurrenceKey());
        body.put("trigger", occurrence.trigger());
        body.put("firedAt", now);
        try {
            harness.runAutomationOperation(row.tenantId(), row.sessionId(),
                    body);
        } catch (DaemonHttpException error) {
            String code = errorCode(error);
            if ("automation_revision_stale".equals(code)) {
                // The mirror lagged the committed definition: learn the
                // revision now live and re-pin the claim to it, once.
                Optional<ScheduleRow> moved = Optional.empty();
                if (mayRepin) {
                    store.findStaleMirror(row.tenantId(), row.scheduleId())
                            .ifPresent(stale -> refreshMirror(stale, now));
                    moved = store.findSchedule(row.tenantId(),
                            row.scheduleId());
                }
                if (moved.isPresent()
                        && AutomationLedgerStore.STATE_LIVE.equals(
                                moved.get().state())
                        && moved.get().definitionRevision()
                                != occurrence.definitionRevision()
                        && store.repinOccurrence(row.tenantId(),
                                row.scheduleId(), occurrence.occurrenceKey(),
                                moved.get().definitionRevision(), owner,
                                fence, now)) {
                    return fire(moved.get(), store.findOccurrence(
                            row.tenantId(), row.scheduleId(),
                            occurrence.occurrenceKey()).orElse(occurrence),
                            owner, fence, now, false);
                }
                store.settleOccurrence(row.tenantId(), row.scheduleId(),
                        occurrence.occurrenceKey(),
                        AutomationLedgerStore.OUTCOME_SKIPPED,
                        REASON_REVISION_STALE, owner, fence, now);
                return false;
            }
            if ("automation_retired".equals(code)
                    || "automation_not_found".equals(code)
                    || "hosted_session_not_found".equals(code)) {
                store.settleOccurrence(row.tenantId(), row.scheduleId(),
                        occurrence.occurrenceKey(),
                        AutomationLedgerStore.OUTCOME_SKIPPED,
                        REASON_DEFINITION_RETIRED, owner, fence, now);
                store.retire(row.tenantId(), row.scheduleId(), now);
                return false;
            }
            if (error.getStatusCode() >= 400 && error.getStatusCode() < 500) {
                // A definitive refusal (mode gate closed, conflict, a body
                // the route rejects): settle the decision instead of
                // re-driving it into `unknown` — the answer was obtained.
                store.settleOccurrence(row.tenantId(), row.scheduleId(),
                        occurrence.occurrenceKey(),
                        AutomationLedgerStore.OUTCOME_SKIPPED,
                        code == null ? "automation_refused" : code, owner,
                        fence, now);
                return false;
            }
            throw error;
        }
        return store.settleOccurrence(row.tenantId(), row.scheduleId(),
                occurrence.occurrenceKey(), AutomationLedgerStore.OUTCOME_FIRED,
                null, owner, fence, now);
    }

    /**
     * A fire whose answer could not be obtained: the claim stays firing
     * and is re-driven with backoff; past the bound it is recorded unknown
     * — visible, never re-driven, never counted as a run that ended.
     */
    void defer(ScheduleRow row, OccurrenceRow occurrence, String owner,
            long fence, RuntimeException error, long now) {
        int attempts = occurrence.attempts() + 1;
        if (attempts >= MAX_FIRE_ATTEMPTS) {
            store.settleOccurrence(row.tenantId(), row.scheduleId(),
                    occurrence.occurrenceKey(),
                    AutomationLedgerStore.OUTCOME_UNKNOWN,
                    REASON_ANSWER_UNOBTAINABLE, owner, fence, now);
            LOG.warn("automation claim gives up tenant={} schedule={}"
                    + " occurrence={} after={} failure={}", row.tenantId(),
                    row.scheduleId(), occurrence.occurrenceKey(), attempts,
                    error.getMessage());
            return;
        }
        long delay = Math.min(300_000L, 1_000L * (1L << Math.min(attempts, 8)));
        store.deferOccurrence(row.tenantId(), row.scheduleId(),
                occurrence.occurrenceKey(), attempts, now + delay,
                error.getMessage(), owner, fence, now);
        LOG.warn("automation fire deferred tenant={} schedule={} occurrence={}"
                + " attempt={} failure={}", row.tenantId(), row.scheduleId(),
                occurrence.occurrenceKey(), attempts, error.getMessage());
    }

    static String errorCode(DaemonHttpException error) {
        String body = error.getResponseBody();
        if (body == null) {
            return null;
        }
        int at = body.indexOf("\"code\":\"");
        if (at < 0) {
            return null;
        }
        int end = body.indexOf('"', at + 8);
        return end > at ? body.substring(at + 8, end) : null;
    }
}
