package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonException;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.AutomationDefinitionRequest;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicAutomation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicAutomationRun;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.CommandRow;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.OccurrenceCursor;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.OccurrencePage;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.OccurrenceRow;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.OccurrenceView;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.ScheduleCursor;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.SchedulePage;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * H6b: the control plane's automation service. Public mutations are
 * relayed to the target Session's Hosted Harness, whose authority commits
 * the definition revision or the manual run; the answer is mirrored into
 * the V53 ledger and replayed by Idempotency-Key. Reads answer from the
 * ledger alone. See docs/design/2026-10-07-managed-automation-runtime.md,
 * decisions 11 and 12.
 */
@Service
public class ManagedAutomationService {
    private static final Pattern SCHEDULE_ID = Pattern.compile(
            "^asch_[0-9a-f]{32}$");
    private static final DateTimeFormatter SLOT = DateTimeFormatter
            .ofPattern("uuuu-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);
    private static final int MAX_DEFINITIONS = 32;

    private final AutomationLedgerStore ledger;
    private final ManagedAgentStore sessions;
    private final ManagedWorkspaceRegistry workspaces;
    private final HarnessConnector harness;
    private final AutomationScanner scanner;
    private final RequestDigests digests;
    private final ObjectMapper mapper;
    private final ManagedAgentProperties.Automation settings;
    private final boolean sessionStoreEnabled;
    private final Supplier<Long> clock;
    /** The lease this instance holds a definition under for a manual run. */
    private final String owner = "automation-api-" + UUID.randomUUID();

    @Autowired
    public ManagedAutomationService(AutomationLedgerStore ledger,
            ManagedAgentStore sessions, ManagedWorkspaceRegistry workspaces,
            HarnessConnector harness, AutomationScanner scanner,
            RequestDigests digests, ObjectMapper mapper,
            ManagedAgentProperties properties) {
        this(ledger, sessions, workspaces, harness, scanner, digests, mapper,
                properties.getAutomation(),
                properties.getSessionStore().isEnabled(),
                System::currentTimeMillis);
    }

    ManagedAutomationService(AutomationLedgerStore ledger,
            ManagedAgentStore sessions, ManagedWorkspaceRegistry workspaces,
            HarnessConnector harness, AutomationScanner scanner,
            RequestDigests digests, ObjectMapper mapper,
            ManagedAgentProperties.Automation settings,
            boolean sessionStoreEnabled, Supplier<Long> clock) {
        this.ledger = ledger;
        this.sessions = sessions;
        this.workspaces = workspaces;
        this.harness = harness;
        this.scanner = scanner;
        this.digests = digests;
        this.mapper = mapper;
        this.settings = settings;
        this.sessionStoreEnabled = sessionStoreEnabled;
        this.clock = clock;
    }

    public record Result<T>(T body, boolean replayed) {
    }

    // --- mutations ---

    public Result<PublicAutomation> create(String tenantId, String actorId,
            String idempotencyKey, AutomationDefinitionRequest request) {
        requireActor(actorId);
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        if (request.sessionId() == null || request.sessionId().isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_automation", "session_id is required.");
        }
        Map<String, Object> definition = definition(request, true);
        String requestDigest = digests.digest(Map.of("operation", "create",
                "sessionId", request.sessionId(), "definition", definition));
        Optional<Result<PublicAutomation>> replay = replay(tenantId, actorId,
                idempotencyKey, requestDigest, PublicAutomation.class);
        if (replay.isPresent()) {
            return replay.get();
        }
        SessionRecord session = requireCreatorSession(tenantId, actorId,
                request.sessionId());
        requireEnabled();
        if (ledger.countLive(tenantId, session.sessionId())
                >= MAX_DEFINITIONS) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "automation_count_limit", "A Session holds at most "
                    + MAX_DEFINITIONS + " live automation definitions.");
        }
        // The definition id is derived from the key, so a retry after a
        // crash between the Harness answer and the command row meets the
        // same definition (the funnel answers unchanged content as a
        // replay) instead of minting a second one. The identity is
        // tenant-scoped while a journal is Session-scoped, so the lost
        // row case is checked against the durable mirror first: the key
        // having landed on another Session is a conflict, never a relay
        // that would mint a second definition the mirror then shadows.
        String scheduleId = scheduleIdFor(tenantId, idempotencyKey);
        Optional<ScheduleRow> landed = ledger.findSchedule(tenantId,
                scheduleId);
        if (landed.isPresent()
                && !landed.get().sessionId().equals(request.sessionId())) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "automation_operation_conflict",
                    "The Idempotency-Key already landed on another Session.");
        }
        Map<String, Object> answer = define(session, actorId, scheduleId,
                definition, operationIdFor(tenantId, idempotencyKey));
        PublicAutomation created = mirror(session, actorId, answer);
        remember(tenantId, actorId, idempotencyKey, requestDigest, scheduleId,
                created);
        return new Result<>(created, replayed(answer));
    }

    public Result<PublicAutomation> update(String tenantId, String actorId,
            String automationId, String idempotencyKey,
            AutomationDefinitionRequest request) {
        requireActor(actorId);
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        requireScheduleId(automationId);
        Map<String, Object> definition = definition(request, false);
        String requestDigest = digests.digest(Map.of("operation", "update",
                "automationId", automationId,
                "sessionId", request.sessionId() == null ? ""
                        : request.sessionId(),
                "definition", definition));
        Optional<Result<PublicAutomation>> replay = replay(tenantId, actorId,
                idempotencyKey, requestDigest, PublicAutomation.class);
        if (replay.isPresent()) {
            return replay.get();
        }
        ScheduleRow row = requireReadable(tenantId, actorId, automationId);
        SessionRecord session = requireCreatorSession(tenantId, actorId,
                row.sessionId());
        requireLive(row);
        if (request.sessionId() != null
                && !request.sessionId().equals(row.sessionId())) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_automation",
                    "session_id cannot change after creation.");
        }
        requireEnabled();
        Map<String, Object> answer = define(session, actorId, automationId,
                definition, operationIdFor(tenantId, idempotencyKey));
        PublicAutomation revised = mirror(session, actorId, answer);
        remember(tenantId, actorId, idempotencyKey, requestDigest,
                automationId, revised);
        return new Result<>(revised, replayed(answer));
    }

    public Result<PublicAutomation> retire(String tenantId, String actorId,
            String automationId, String idempotencyKey) {
        requireActor(actorId);
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        requireScheduleId(automationId);
        String requestDigest = digests.digest(Map.of("operation", "retire",
                "automationId", automationId));
        Optional<Result<PublicAutomation>> replay = replay(tenantId, actorId,
                idempotencyKey, requestDigest, PublicAutomation.class);
        if (replay.isPresent()) {
            return replay.get();
        }
        ScheduleRow row = requireReadable(tenantId, actorId, automationId);
        SessionRecord session = requireCreatorSession(tenantId, actorId,
                row.sessionId());
        requireEnabled();
        if (!AutomationLedgerStore.STATE_LIVE.equals(row.state())) {
            // Retiring a retired definition is its own replay.
            PublicAutomation already = publicAutomation(row);
            remember(tenantId, actorId, idempotencyKey, requestDigest,
                    automationId, already);
            return new Result<>(already, true);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", operationIdFor(tenantId, idempotencyKey));
        body.put("kind", "retire_schedule");
        body.put("scheduleId", automationId);
        Map<String, Object> answer = relay(tenantId, session.sessionId(), body);
        PublicAutomation retired = mirror(session, actorId, answer);
        ledger.retire(tenantId, automationId, clock.get());
        remember(tenantId, actorId, idempotencyKey, requestDigest,
                automationId, retired);
        return new Result<>(retired, replayed(answer));
    }

    /**
     * A manual run: the Idempotency-Key is the occurrence, so a retry meets
     * the same run; the overlap policy applies as it does to a scheduled
     * occurrence, and the ledger row is durable before the Harness fires.
     */
    public Result<PublicAutomationRun> run(String tenantId, String actorId,
            String automationId, String idempotencyKey) {
        requireActor(actorId);
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        requireScheduleId(automationId);
        ScheduleRow row = requireReadable(tenantId, actorId, automationId);
        requireCreatorSession(tenantId, actorId, row.sessionId());
        requireEnabled();
        requireLive(row);
        String occurrenceKey = "manual:" + idempotencyKey;
        // The decision and the fire run under the definition's lease, as
        // the scanner's do: the overlap count and the occurrence row are
        // taken by one holder at a time.
        long fence = claimForManualRun(tenantId, automationId);
        boolean replayed;
        try {
            long now = clock.get();
            ScheduleRow held = ledger.findSchedule(tenantId, automationId)
                    .orElse(row);
            Optional<OccurrenceRow> existing = ledger.findOccurrence(tenantId,
                    automationId, occurrenceKey);
            replayed = existing.isPresent();
            if (existing.isEmpty()) {
                String refusal = scanner.admissionRefusal(held);
                if (refusal != null) {
                    ledger.recordOccurrence(OccurrenceRow.decision(held,
                            occurrenceKey, null, AutomationScanner.TRIGGER_MANUAL,
                            AutomationLedgerStore.OUTCOME_SKIPPED, refusal,
                            fence, now), owner);
                    throw new ApiException(HttpStatus.CONFLICT,
                            "automation_run_skipped",
                            "The manual run was skipped: " + refusal + ".");
                }
            }
            OccurrenceRow occurrence = existing.or(() -> ledger
                    .recordOccurrence(OccurrenceRow.decision(held,
                            occurrenceKey, null, AutomationScanner.TRIGGER_MANUAL,
                            AutomationLedgerStore.OUTCOME_FIRING, null, fence,
                            now), owner))
                    .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT,
                            "automation_busy",
                            "The automation is being scanned; retry."));
            if (AutomationLedgerStore.OUTCOME_FIRING.equals(
                    occurrence.outcome())) {
                try {
                    scanner.fire(held, occurrence, owner, fence, now);
                } catch (RuntimeException error) {
                    // The claim is durable and re-driven by the scanner
                    // with backoff; the same key answers it once known.
                    scanner.defer(held, occurrence, owner, fence, error, now);
                    throw unobtained(error);
                }
                // A definitive route refusal settles the decision as
                // skipped under the claim: the first attempt is told so.
                if (AutomationLedgerStore.OUTCOME_SKIPPED.equals(
                        ledger.findOccurrence(tenantId, automationId,
                                occurrenceKey).orElse(occurrence).outcome())) {
                    String reason = ledger.findOccurrence(tenantId,
                            automationId, occurrenceKey).orElse(occurrence)
                            .reason();
                    throw new ApiException(HttpStatus.CONFLICT,
                            "automation_run_skipped",
                            "The manual run was skipped: " + reason + ".");
                }
            }
        } finally {
            ledger.release(tenantId, automationId, owner, fence, clock.get());
        }
        OccurrenceView view = ledger.findOccurrenceView(tenantId, automationId,
                occurrenceKey).orElseThrow();
        return new Result<>(publicRun(view), replayed);
    }

    // --- reads ---

    public PublicAutomation get(String tenantId, String actorId,
            String automationId) {
        requireScheduleId(automationId);
        return publicAutomation(requireReadable(tenantId, actorId,
                automationId));
    }

    public PublicList<PublicAutomation> list(String tenantId, String actorId,
            String cursor, int limit) {
        requireLimit(limit);
        ScheduleCursor decoded = null;
        if (cursor != null && !cursor.isEmpty()) {
            String[] parts = decodeCursor(cursor,
                    "Automation cursor is invalid.");
            decoded = new ScheduleCursor(Long.parseLong(parts[0]), parts[1]);
        }
        SchedulePage page = ledger.listReadableSchedules(tenantId, actorId,
                decoded, limit);
        List<PublicAutomation> data = new ArrayList<>();
        for (ScheduleRow row : page.rows()) {
            data.add(publicAutomation(row));
        }
        String next = null;
        if (page.hasMore() && !page.rows().isEmpty()) {
            ScheduleRow last = page.rows().getLast();
            next = encodeCursor(last.createdAt(), last.scheduleId());
        }
        return new PublicList<>("list", data, page.hasMore(), next);
    }

    public PublicList<PublicAutomationRun> listRuns(String tenantId,
            String actorId, String automationId, String cursor, int limit) {
        requireLimit(limit);
        requireScheduleId(automationId);
        requireReadable(tenantId, actorId, automationId);
        OccurrenceCursor decoded = null;
        if (cursor != null && !cursor.isEmpty()) {
            String[] parts = decodeCursor(cursor, "Run cursor is invalid.");
            decoded = new OccurrenceCursor(Long.parseLong(parts[0]), parts[1]);
        }
        OccurrencePage page = ledger.listOccurrences(tenantId, automationId,
                decoded, limit);
        List<PublicAutomationRun> data = page.rows().stream()
                .map(ManagedAutomationService::publicRun).toList();
        String next = null;
        if (page.hasMore() && !page.rows().isEmpty()) {
            OccurrenceRow last = page.rows().getLast().occurrence();
            next = encodeCursor(last.createdAt(), last.occurrenceKey());
        }
        return new PublicList<>("list", data, page.hasMore(), next);
    }

    // --- the Harness relay ---

    private Map<String, Object> define(SessionRecord session, String actorId,
            String scheduleId, Map<String, Object> definition,
            String operationId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", operationId);
        body.put("kind", "define_schedule");
        body.put("scheduleId", scheduleId);
        body.put("definition", definition);
        return relay(session.tenantId(), session.sessionId(), body);
    }

    /** The operation answer's replay mark, carried through to the caller. */
    private static boolean replayed(Map<String, Object> answer) {
        return Boolean.TRUE.equals(answer.get("replayed"));
    }

    private Map<String, Object> relay(String tenantId, String sessionId,
            Map<String, Object> body) {
        try {
            return harness.runAutomationOperation(tenantId, sessionId, body);
        } catch (RuntimeException error) {
            throw unobtained(error);
        }
    }

    /** The answer to an operation whose outcome the Harness did not settle. */
    private static RuntimeException unobtained(RuntimeException error) {
        if (error instanceof DaemonHttpException refusal) {
            return translate(refusal);
        }
        if (error instanceof UnsupportedOperationException) {
            return new ApiException(HttpStatus.SERVICE_UNAVAILABLE,
                    "automation_unavailable",
                    "The Hosted Harness is not available.");
        }
        if (error instanceof DaemonException) {
            return new ApiException(HttpStatus.SERVICE_UNAVAILABLE,
                    "automation_operation_unknown",
                    "The Hosted Harness answer was lost; retry the same key.");
        }
        return error;
    }

    /**
     * Takes the definition's lease for one manual run, waiting out a
     * scanner tick that holds it; a lease that stays held answers busy.
     */
    private long claimForManualRun(String tenantId, String automationId) {
        for (int attempt = 0; attempt < 40; attempt++) {
            long now = clock.get();
            long fence = ledger.claim(tenantId, automationId, owner,
                    now + settings.getLease().toMillis(), now);
            if (fence >= 0) {
                return fence;
            }
            try {
                Thread.sleep(25);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new ApiException(HttpStatus.CONFLICT, "automation_busy",
                "The automation is being scanned; retry.");
    }

    /** The Harness answer's definition summary, mirrored into the ledger. */
    private PublicAutomation mirror(SessionRecord session, String actorId,
            Map<String, Object> answer) {
        JsonNode schedule = mapper.valueToTree(answer.get("schedule"));
        if (schedule == null || !schedule.isObject()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,
                    "automation_operation_failed",
                    "The Hosted Harness answered without the definition.");
        }
        long now = clock.get();
        long recordRevision = schedule.required("revision").asLong();
        ScheduleRow row = ledger.upsertSchedule(new ScheduleRow(
                session.tenantId(), schedule.required("scheduleId").asText(),
                session.sessionId(), session.workspace() == null ? ""
                        : session.workspace().getWorkspaceId(), actorId,
                recordRevision,
                schedule.required("definitionRevision").asLong(),
                schedule.required("definitionDigest").asText(),
                schedule.required("goal").asText(),
                schedule.required("cron").asText(),
                schedule.required("timezone").asText(),
                schedule.required("sessionMode").asText(),
                schedule.required("overlap").asText(),
                schedule.required("catchUp").asText(),
                schedule.required("catchUpLimit").isNull() ? null
                        : schedule.required("catchUpLimit").asLong(),
                schedule.required("enabled").asBoolean(),
                List.of("settled", "failed", "cancelled").contains(
                        schedule.required("state").asText())
                        ? AutomationLedgerStore.STATE_RETIRED
                        : AutomationLedgerStore.STATE_LIVE,
                null, 0, null, null, null, 0, 0, 0), now);
        if (row.recordRevision() > recordRevision) {
            // The answer replays an operation committed before the
            // revision the mirror already tracks: the ledger row kept the
            // newer truth, but the remembered result is the operation's
            // own committed one, or a later replay answers with another
            // request's revision.
            return new PublicAutomation(
                    schedule.required("scheduleId").asText(),
                    "agent.automation", session.sessionId(),
                    schedule.required("definitionRevision").asLong(),
                    schedule.required("definitionDigest").asText(),
                    schedule.required("goal").asText(),
                    schedule.required("cron").asText(),
                    schedule.required("timezone").asText(),
                    schedule.required("sessionMode").asText(),
                    schedule.required("overlap").asText(),
                    schedule.required("catchUp").asText(),
                    schedule.required("catchUpLimit").isNull() ? null
                            : schedule.required("catchUpLimit").asLong(),
                    schedule.required("enabled").asBoolean(), row.state(),
                    row.createdAt(), row.updatedAt());
        }
        return publicAutomation(row);
    }

    // --- helpers ---

    private Map<String, Object> definition(AutomationDefinitionRequest request,
            boolean create) {
        Map<String, Object> definition = new LinkedHashMap<>();
        put(definition, "goal", request.goal());
        put(definition, "cron", request.cron());
        put(definition, "timezone", request.timezone());
        put(definition, "prompt", request.prompt());
        put(definition, "sessionMode", request.sessionMode());
        put(definition, "overlap", request.overlap());
        put(definition, "catchUp", request.catchUp());
        if (request.catchUpLimit() != null) {
            definition.put("catchUpLimit", request.catchUpLimit());
        }
        if (request.enabled() != null) {
            definition.put("enabled", request.enabled());
        }
        if (create) {
            for (String field : List.of("goal", "cron", "timezone", "prompt")) {
                if (!definition.containsKey(field)) {
                    throw new ApiException(HttpStatus.BAD_REQUEST,
                            "invalid_automation", field + " is required.");
                }
            }
        }
        if (request.prompt() != null && request.prompt()
                .getBytes(StandardCharsets.UTF_8).length > 64 * 1024) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_automation", "prompt exceeds 64 KiB.");
        }
        if (request.timezone() != null
                && CronSlots.resolve(request.timezone()).isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "automation_timezone_unknown",
                    "The timezone does not resolve on this deployment.");
        }
        if (request.cron() != null) {
            try {
                CronSlots.compile(request.cron());
            } catch (IllegalArgumentException error) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "invalid_automation", "The cron is invalid.");
            }
        }
        if (request.sessionMode() != null
                && !"persistent".equals(request.sessionMode())) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "automation_mode_disabled",
                    "Only the persistent target mode is enabled.");
        }
        return definition;
    }

    private static void put(Map<String, Object> definition, String key,
            String value) {
        if (value != null) {
            definition.put(key, value);
        }
    }

    private static void requireLive(ScheduleRow row) {
        if (!AutomationLedgerStore.STATE_LIVE.equals(row.state())) {
            throw new ApiException(HttpStatus.CONFLICT, "automation_retired",
                    "The automation is retired.");
        }
    }

    private void requireEnabled() {
        // The hosted Session store is where the committed records the
        // scanner reads and the overlap count joins on live; without it a
        // fired run would never be seen to end.
        if (!settings.isEnabled() || !sessionStoreEnabled) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "automation_unavailable",
                    "Automation is not enabled on this deployment.");
        }
    }

    private static void requireActor(String actorId) {
        if (actorId == null || actorId.isEmpty()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "actor_required",
                    "A trusted actor is required.");
        }
    }

    private static void requireScheduleId(String automationId) {
        if (automationId == null || !SCHEDULE_ID.matcher(automationId)
                .matches()) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "automation_not_found", "The automation was not found.");
        }
    }

    private static void requireLimit(int limit) {
        if (limit < 1 || limit > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
    }

    /**
     * The target Session must be a Workspace-bound Session the caller
     * created, active, and in a Workspace the caller may create in — the
     * rule later Turns and cwd changes apply. Invisibility first: a caller
     * without read access learns only 404.
     */
    private SessionRecord requireCreatorSession(String tenantId,
            String actorId, String sessionId) {
        Optional<SessionRecord> found = sessions.findSession(tenantId,
                sessionId);
        ApiException notFound = new ApiException(HttpStatus.NOT_FOUND,
                "session_not_found", "The Session was not found.");
        if (found.isEmpty() || "DELETED".equals(found.get().status())
                || found.get().workspace() == null
                || !workspaces.canRead(tenantId, actorId,
                        found.get().workspace().getWorkspaceId())) {
            throw notFound;
        }
        SessionRecord session = found.get();
        // The owner family's refusal, as lifecycle and cwd answer a
        // non-creator (SurfaceRegistry rule class OWNER).
        if (!workspaces.createdSession(tenantId, actorId, sessionId)) {
            throw new ApiException(HttpStatus.FORBIDDEN,
                    "session_operation_forbidden",
                    "Only the Session's creator manages its automations.");
        }
        ManagedWorkspaceRegistry.WorkspaceSummary summary = workspaces
                .findReadable(tenantId, actorId,
                        session.workspace().getWorkspaceId());
        if (summary == null || !summary.canCreateSession()) {
            throw new ApiException(HttpStatus.FORBIDDEN,
                    "session_operation_forbidden",
                    "The caller may not create in the Session's Workspace.");
        }
        if (!"ACTIVE".equals(session.status())) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "session_not_active", "The Session is not active.");
        }
        return session;
    }

    private ScheduleRow requireReadable(String tenantId, String actorId,
            String automationId) {
        ScheduleRow row = ledger.findSchedule(tenantId, automationId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "automation_not_found",
                        "The automation was not found."));
        if (!workspaces.canRead(tenantId, actorId, row.workspaceId())) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "automation_not_found", "The automation was not found.");
        }
        return row;
    }

    private <T> Optional<Result<T>> replay(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, Class<T> type) {
        Optional<CommandRow> command = ledger.findCommand(tenantId,
                idempotencyKey);
        if (command.isEmpty()) {
            return Optional.empty();
        }
        if (!command.get().requestDigest().equals(requestDigest)
                || !command.get().actorId().equals(actorId)) {
            throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict",
                    "The idempotency key was reused with different content.");
        }
        try {
            return Optional.of(new Result<>(mapper.readValue(
                    command.get().resultJson(), type), true));
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("automation command is unreadable",
                    error);
        }
    }

    private void remember(String tenantId, String actorId,
            String idempotencyKey, String requestDigest, String scheduleId,
            Object result) {
        try {
            ledger.recordCommand(new CommandRow(tenantId, idempotencyKey,
                    actorId, requestDigest, scheduleId,
                    mapper.writeValueAsString(result)), clock.get());
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("automation result is unwritable",
                    error);
        }
    }

    /**
     * The id a create mints: a derivation of the tenant and the
     * Idempotency-Key, so a retry after a crash between the Harness answer
     * and the command row meets the definition it already created.
     */
    public static String scheduleIdFor(String tenantId, String idempotencyKey) {
        return "asch_" + AutomationLedgerStore.sha256(tenantId + '\0'
                + idempotencyKey).substring(0, 32);
    }

    /**
     * The relayed operation's identity: derived from the same identity as
     * the definition id, so the same request re-sends it across a lost
     * answer and the Harness answers the original committed revision
     * instead of committing the content again over a newer one.
     */
    public static String operationIdFor(String tenantId,
            String idempotencyKey) {
        return UUID.nameUUIDFromBytes(("qwen-automation:\0" + tenantId + '\0'
                + idempotencyKey).getBytes(StandardCharsets.UTF_8))
                .toString();
    }

    static ApiException translate(DaemonHttpException error) {
        String code = AutomationScanner.errorCode(error);
        HttpStatus status = switch (error.getStatusCode()) {
            case 404 -> HttpStatus.NOT_FOUND;
            case 409 -> HttpStatus.CONFLICT;
            case 400 -> HttpStatus.BAD_REQUEST;
            default -> HttpStatus.SERVICE_UNAVAILABLE;
        };
        return new ApiException(status,
                code == null ? "automation_operation_failed" : code,
                "The Hosted Harness refused the automation operation.");
    }

    static PublicAutomation publicAutomation(ScheduleRow row) {
        return new PublicAutomation(row.scheduleId(), "agent.automation",
                row.sessionId(), row.definitionRevision(),
                row.definitionDigest(), row.goal(), row.cron(), row.timezone(),
                row.sessionMode(), row.overlap(), row.catchUp(),
                row.catchUpLimit(), row.enabled(), row.state(),
                row.createdAt(), row.updatedAt());
    }

    static PublicAutomationRun publicRun(OccurrenceView view) {
        OccurrenceRow row = view.occurrence();
        return new PublicAutomationRun(row.runId(), "agent.automation.run",
                row.scheduleId(), row.sessionId(), row.occurrenceKey(),
                row.slot() == null ? null
                        : SLOT.format(Instant.ofEpochMilli(row.slot())),
                row.trigger(), row.outcome(), row.reason(),
                row.definitionRevision(), view.taskState(), row.createdAt(),
                row.updatedAt());
    }

    private static String encodeCursor(long createdAt, String id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                (createdAt + "|" + id).getBytes(StandardCharsets.UTF_8));
    }

    private static String[] decodeCursor(String cursor, String message) {
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
            int separator = decoded.indexOf('|');
            if (separator <= 0 || separator == decoded.length() - 1) {
                throw new IllegalArgumentException(message);
            }
            String[] parts = {decoded.substring(0, separator),
                decoded.substring(separator + 1)};
            Long.parseLong(parts[0]);
            return parts;
        } catch (IllegalArgumentException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor",
                    message);
        }
    }
}
