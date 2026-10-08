package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.store.AutomationLedgerStore;
import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * H6b: a Hosted Harness automation funnel in memory, answering the three
 * automation operations the way {@code hosted-automation-session.ts} does —
 * append-only definition revisions with a content digest, an unchanged
 * definition answered as a replay, a retired chain refusing everything, a
 * run derived from its occurrence and answered again on a second fire, and
 * a stale definition revision refused. A mutation re-relayed under the
 * same operationId is answered with its originally committed revision:
 * the journal holds the operation, so a control plane retry after a lost
 * answer never rewrites a newer one. Refusals are the daemon's own HTTP
 * exception with the code the hosted route answers, so the control plane's
 * translation is exercised as in production.
 */
public final class AutomationHarnessFake {
    public final List<Map<String, Object>> operations = new ArrayList<>();
    private final Map<String, Map<String, Object>> schedules =
            new LinkedHashMap<>();
    private final Map<String, Map<String, Object>> runs = new LinkedHashMap<>();
    /** The definition summary each committed mutation operation answered. */
    private final Map<String, Map<String, Object>> mutations =
            new LinkedHashMap<>();
    /** A test seam: thrown once by the next fire_run, then cleared. */
    public volatile RuntimeException failNextFire;
    /** A test seam: the next fire_run commits its run, then loses its answer. */
    public volatile RuntimeException failAfterNextFireCommit;
    /**
     * A test seam: the next define_schedule commits (its operation, too)
     * and then has its answer lost once.
     */
    public volatile RuntimeException failAfterNextDefineCommit;
    /** The same seam for retire_schedule. */
    public volatile RuntimeException failAfterNextRetireCommit;

    public synchronized Map<String, Object> run(String sessionId,
            Map<String, Object> body) {
        operations.add(new LinkedHashMap<>(body));
        String kind = String.valueOf(body.get("kind"));
        String scheduleId = String.valueOf(body.get("scheduleId"));
        String key = sessionId + "|" + scheduleId;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("operationId", body.get("operationId"));
        result.put("state", "settled");
        switch (kind) {
            case "define_schedule" -> {
                String mutationKey = sessionId + "|define|"
                        + body.get("operationId");
                Map<String, Object> prior = mutations.get(mutationKey);
                Map<?, ?> definition = (Map<?, ?>) body.get("definition");
                if (prior != null) {
                    replayCheck(prior, scheduleId, definition);
                    result.put("schedule", new LinkedHashMap<>(prior));
                    result.put("replayed", true);
                    break;
                }
                // One idempotency key is one operation on the public
                // surface; the journal is the recoverable record, so a
                // cross-kind reuse conflicts instead of committing twice.
                if (mutations.containsKey(sessionId + "|retire|"
                        + body.get("operationId"))) {
                    throw refusal(409, "automation_operation_conflict");
                }
                Map<String, Object> schedule = schedules.get(key);
                boolean replayed = false;
                if (schedule == null) {
                    schedule = new LinkedHashMap<>();
                    schedule.put("scheduleId", scheduleId);
                    schedule.put("revision", 1L);
                    schedule.put("definitionRevision", 1L);
                    schedule.put("sessionMode", "persistent");
                    schedule.put("targetSessionId", sessionId);
                    schedule.put("overlap", "skip");
                    schedule.put("catchUp", "none");
                    schedule.put("catchUpLimit", null);
                    schedule.put("enabled", true);
                    schedule.put("state", "admitted");
                    apply(schedule, definition);
                    if (!"persistent".equals(schedule.get("sessionMode"))) {
                        schedules.remove(key);
                        throw refusal(409, "automation_mode_disabled");
                    }
                    schedule.put("definitionDigest", digest(schedule));
                    schedules.put(key, schedule);
                } else {
                    if ("cancelled".equals(schedule.get("state"))) {
                        throw refusal(409, "automation_retired");
                    }
                    Map<String, Object> next = new LinkedHashMap<>(schedule);
                    apply(next, definition);
                    String digest = digest(next);
                    if (digest.equals(schedule.get("definitionDigest"))) {
                        replayed = true;
                    } else {
                        next.put("definitionDigest", digest);
                        next.put("revision", (Long) schedule.get("revision") + 1);
                        next.put("definitionRevision",
                                (Long) schedule.get("definitionRevision") + 1);
                        schedules.put(key, next);
                        schedule = next;
                    }
                }
                // The operation is part of the commit, so a relay whose
                // answer is lost replays it instead of committing twice.
                mutations.put(mutationKey, new LinkedHashMap<>(schedule));
                RuntimeException failure = failAfterNextDefineCommit;
                if (failure != null) {
                    failAfterNextDefineCommit = null;
                    throw failure;
                }
                result.put("schedule", new LinkedHashMap<>(schedule));
                result.put("replayed", replayed);
            }
            case "retire_schedule" -> {
                String mutationKey = sessionId + "|retire|"
                        + body.get("operationId");
                Map<String, Object> prior = mutations.get(mutationKey);
                if (prior != null) {
                    replayCheck(prior, scheduleId, null);
                    result.put("schedule", new LinkedHashMap<>(prior));
                    result.put("replayed", true);
                    break;
                }
                // Same cross-kind rule as define: reusing the key for the
                // other operation kind conflicts, never commits.
                if (mutations.containsKey(sessionId + "|define|"
                        + body.get("operationId"))) {
                    throw refusal(409, "automation_operation_conflict");
                }
                Map<String, Object> schedule = schedules.get(key);
                if (schedule == null) {
                    throw refusal(404, "automation_not_found");
                }
                boolean replayed = "cancelled".equals(schedule.get("state"));
                if (!replayed) {
                    schedule.put("state", "cancelled");
                    schedule.put("enabled", false);
                    schedule.put("revision", (Long) schedule.get("revision") + 1);
                    schedule.put("definitionRevision",
                            (Long) schedule.get("definitionRevision") + 1);
                    mutations.put(mutationKey,
                            new LinkedHashMap<>(schedule));
                    RuntimeException failure = failAfterNextRetireCommit;
                    if (failure != null) {
                        failAfterNextRetireCommit = null;
                        throw failure;
                    }
                }
                result.put("schedule", new LinkedHashMap<>(schedule));
                result.put("replayed", replayed);
            }
            case "fire_run" -> {
                RuntimeException failure = failNextFire;
                if (failure != null) {
                    failNextFire = null;
                    throw failure;
                }
                String occurrenceKey = String.valueOf(body.get("occurrenceKey"));
                String runId = AutomationLedgerStore.automationRunId(scheduleId,
                        occurrenceKey);
                // The order the funnel keeps: a committed run answers
                // first — whatever the definition did since.
                Map<String, Object> existing = runs.get(sessionId + "|"
                        + runId);
                if (existing != null) {
                    result.put("run", new LinkedHashMap<>(existing));
                    result.put("inputId", AutomationLedgerStore
                            .automationInputId(runId));
                    result.put("replayed", true);
                    break;
                }
                Map<String, Object> schedule = schedules.get(key);
                if (schedule == null) {
                    throw refusal(404, "automation_not_found");
                }
                if ("cancelled".equals(schedule.get("state"))) {
                    throw refusal(409, "automation_retired");
                }
                long offered = ((Number) body.get("definitionRevision"))
                        .longValue();
                if (offered != (Long) schedule.get("definitionRevision")) {
                    throw refusal(409, "automation_revision_stale");
                }
                Map<String, Object> run = runs.computeIfAbsent(
                        sessionId + "|" + runId, ignored -> {
                            Map<String, Object> created = new LinkedHashMap<>();
                            created.put("automationRunId", runId);
                            created.put("scheduleId", scheduleId);
                            created.put("definitionRevision", offered);
                            created.put("occurrenceKey", occurrenceKey);
                            created.put("state", "running");
                            created.put("execution", "dispatch_started");
                            return created;
                        });
                RuntimeException lost = failAfterNextFireCommit;
                if (lost != null) {
                    failAfterNextFireCommit = null;
                    throw lost;
                }
                result.put("run", new LinkedHashMap<>(run));
                result.put("inputId", AutomationLedgerStore
                        .automationInputId(runId));
                result.put("replayed", false);
            }
            default -> throw refusal(400, "invalid_automation_operation");
        }
        return result;
    }

    public synchronized int fires() {
        return (int) operations.stream()
                .filter(operation -> "fire_run".equals(operation.get("kind")))
                .count();
    }

    /** The committed definition summary, or null when none committed. */
    public synchronized Map<String, Object> scheduleOf(String sessionId,
            String scheduleId) {
        Map<String, Object> schedule = schedules.get(sessionId + "|"
                + scheduleId);
        return schedule == null ? null : new LinkedHashMap<>(schedule);
    }

    public synchronized List<String> firedOccurrences() {
        return operations.stream()
                .filter(operation -> "fire_run".equals(operation.get("kind")))
                .map(operation -> String.valueOf(operation.get("occurrenceKey")))
                .toList();
    }

    private static void apply(Map<String, Object> schedule,
            Map<?, ?> definition) {
        for (String field : List.of("goal", "cron", "timezone", "sessionMode",
                "overlap", "catchUp", "catchUpLimit", "enabled", "prompt")) {
            if (definition.containsKey(field)) {
                Object value = definition.get(field);
                schedule.put(field, value instanceof Integer integer
                        ? integer.longValue() : value);
            }
        }
    }

    /**
     * The replay check the funnel applies: the operation's target, and for
     * a define every field the request names, must be the ones the
     * operation committed — a retry under one id naming another is a
     * conflict, never another request's result.
     */
    private static void replayCheck(Map<String, Object> prior,
            String scheduleId, Map<?, ?> definition) {
        if (!scheduleId.equals(prior.get("scheduleId"))) {
            throw refusal(409, "automation_operation_conflict");
        }
        if (definition == null) {
            return;
        }
        for (String field : List.of("goal", "cron", "timezone", "sessionMode",
                "overlap", "catchUp", "catchUpLimit", "enabled", "prompt")) {
            if (definition.containsKey(field)) {
                Object value = definition.get(field);
                Object committed = prior.get(field);
                Object normalized = value instanceof Integer integer
                        ? integer.longValue() : value;
                if (!java.util.Objects.equals(normalized, committed)) {
                    throw refusal(409, "automation_operation_conflict");
                }
            }
        }
    }

    private static String digest(Map<String, Object> schedule) {
        StringBuilder content = new StringBuilder();
        for (String field : List.of("goal", "cron", "timezone", "prompt",
                "sessionMode", "overlap", "catchUp", "catchUpLimit", "enabled")) {
            content.append(field).append('=').append(schedule.get(field))
                    .append('\n');
        }
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(content.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    /** The daemon client's HTTP refusal, as the hosted route answers it. */
    public static DaemonHttpException refusal(int status, String code) {
        try {
            Constructor<DaemonHttpException> constructor = DaemonHttpException.class
                    .getDeclaredConstructor(String.class, int.class, String.class);
            constructor.setAccessible(true);
            return constructor.newInstance(
                    "POST /session/:id/automations/operations", status,
                    "{\"error\":\"" + code + "\",\"code\":\"" + code + "\"}");
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException(error);
        }
    }
}
