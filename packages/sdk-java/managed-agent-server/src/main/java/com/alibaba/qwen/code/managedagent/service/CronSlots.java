package com.alibaba.qwen.code.managedagent.service;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * H6b: the slot evaluator of a Schedule definition — the minute instants in
 * a window at which a five-field cron fires in an IANA zone. The
 * TypeScript twin ({@code managed-automation-slots.ts}) pins the same
 * semantics through the shared {@code managed-automation-slots-v1}
 * fixtures: each UTC minute is read in the zone and matched under Vixie day
 * semantics, a wall-clock minute a DST gap skipped fires once at the first
 * instant after the gap, and a minute a DST fold repeats fires once, at
 * its first instant (design decision 9).
 */
public final class CronSlots {
    private static final long MINUTE_MS = 60_000L;
    /** The offset probe behind a candidate instant; no zone folds twice in it. */
    private static final int FOLD_PROBE_MINUTES = 180;
    private static final int[][] BOUNDS = {{0, 59}, {0, 23}, {1, 31}, {1, 12},
        {0, 7}};
    private static final DateTimeFormatter SLOT = DateTimeFormatter
            .ofPattern("uuuu-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);

    private CronSlots() {
    }

    /** The compiled cron: matched values per field and the Vixie wild flags. */
    public record Matcher(Set<Integer> minute, Set<Integer> hour,
            Set<Integer> dayOfMonth, Set<Integer> month, Set<Integer> dayOfWeek,
            boolean dayOfMonthWild, boolean dayOfWeekWild) {
    }

    /** The slots of one window, oldest first, and whether the oldest were cut. */
    public record Slots(List<Long> slots, boolean truncated) {
    }

    /** Whether the host's tz database resolves the zone name exactly. */
    public static Optional<ZoneId> resolve(String timezone) {
        if (timezone == null || !ZoneId.getAvailableZoneIds().contains(timezone)) {
            return Optional.empty();
        }
        return Optional.of(ZoneId.of(timezone));
    }

    /** Compiles a five-field cron the H6a contract accepted. */
    public static Matcher compile(String cron) {
        String[] fields = cron.split(" ", -1);
        if (fields.length != 5) {
            throw new IllegalArgumentException("cron must have exactly five fields.");
        }
        List<Set<Integer>> values = new ArrayList<>();
        for (int index = 0; index < 5; index++) {
            values.add(values(fields[index], BOUNDS[index][0], BOUNDS[index][1]));
        }
        Set<Integer> dayOfWeek = new TreeSet<>(values.get(4));
        if (dayOfWeek.remove(7)) {
            dayOfWeek.add(0);
        }
        return new Matcher(values.get(0), values.get(1), values.get(2),
                values.get(3), Collections.unmodifiableSet(dayOfWeek),
                fields[2].startsWith("*"), fields[4].startsWith("*"));
    }

    private static Set<Integer> values(String field, int min, int max) {
        Set<Integer> set = new TreeSet<>();
        for (String atom : field.split(",", -1)) {
            String[] parts = atom.split("/", -1);
            if (parts.length > 2) {
                throw new IllegalArgumentException("cron atom " + atom + " is malformed.");
            }
            String base = parts[0];
            long step = parts.length == 2 ? parseLong(parts[1], atom) : 1;
            long from;
            long to;
            if (base.equals("*")) {
                from = min;
                to = max;
            } else if (base.contains("-")) {
                String[] range = base.split("-", -1);
                if (range.length != 2) {
                    throw new IllegalArgumentException("cron atom " + atom + " is malformed.");
                }
                from = parseLong(range[0], atom);
                to = parseLong(range[1], atom);
                // The contract refuses a range that wraps or has equal ends.
                if (!(from < to)) {
                    throw new IllegalArgumentException(
                            "cron atom " + atom + " is not an ascending range.");
                }
            } else {
                from = parseLong(base, atom);
                // Vixie: `N/step` runs from N to the field maximum.
                to = parts.length == 2 ? max : from;
            }
            if (step < 1 || from < min || to > max || from > to) {
                throw new IllegalArgumentException(
                        "cron atom " + atom + " is outside " + min + "-" + max + ".");
            }
            for (long value = from; value <= to; value += step) {
                set.add((int) value);
            }
        }
        return Collections.unmodifiableSet(set);
    }

    private static long parseLong(String text, String atom) {
        if (text.isEmpty() || !text.chars().allMatch(Character::isDigit)
                || text.length() > 10) {
            throw new IllegalArgumentException("cron atom " + atom + " is malformed.");
        }
        return Long.parseLong(text);
    }

    /** Whether one wall-clock minute matches, under Vixie day semantics. */
    public static boolean matches(Matcher matcher, LocalDateTime wall) {
        if (!matcher.minute().contains(wall.getMinute())
                || !matcher.hour().contains(wall.getHour())
                || !matcher.month().contains(wall.getMonthValue())) {
            return false;
        }
        boolean dayOfMonth = matcher.dayOfMonth().contains(wall.getDayOfMonth());
        boolean dayOfWeek = matcher.dayOfWeek()
                .contains(wall.getDayOfWeek().getValue() % 7);
        return !matcher.dayOfMonthWild() && !matcher.dayOfWeekWild()
                ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
    }

    /**
     * The instants in {@code (afterMs, untilMs]} at which the cron fires in
     * the zone, each a whole minute; when the window holds more than
     * {@code limit} slots the oldest are cut.
     */
    public static Slots between(Matcher matcher, ZoneId zone, long afterMs,
            long untilMs, int limit) {
        if (limit < 1) {
            throw new IllegalArgumentException("slot window needs a positive limit.");
        }
        List<Long> slots = new ArrayList<>();
        long first = Math.floorDiv(afterMs, MINUTE_MS) * MINUTE_MS + MINUTE_MS;
        long last = Math.floorDiv(untilMs, MINUTE_MS) * MINUTE_MS;
        for (long instant = first; instant <= last; instant += MINUTE_MS) {
            if (isSlot(matcher, zone, instant)) {
                slots.add(instant);
            }
        }
        if (slots.size() > limit) {
            return new Slots(List.copyOf(slots.subList(slots.size() - limit,
                    slots.size())), true);
        }
        return new Slots(List.copyOf(slots), false);
    }

    /** Whether one whole-minute instant is a slot of the cron in the zone. */
    public static boolean isSlot(Matcher matcher, ZoneId zone, long instantMs) {
        ZonedDateTime wall = at(instantMs, zone);
        int offset = offsetMinutes(wall);
        // A fold repeats wall-clock minutes: this instant is the second
        // reading of its minute when an earlier instant, one pre-transition
        // offset back, read the same wall clock.
        int probe = offsetMinutes(at(instantMs - FOLD_PROBE_MINUTES * MINUTE_MS,
                zone));
        int drop = probe - offset;
        if (drop > 0 && offsetMinutes(at(instantMs - drop * MINUTE_MS, zone))
                == offset + drop) {
            return false;
        }
        if (matches(matcher, wall.toLocalDateTime())) {
            return true;
        }
        // A gap skips wall-clock minutes: the first instant after it fires
        // for any skipped minute the cron names, once.
        long local = localMinutes(wall.toLocalDateTime());
        long previous = localMinutes(at(instantMs - MINUTE_MS, zone)
                .toLocalDateTime());
        for (long skipped = previous + 1; skipped < local; skipped++) {
            if (matches(matcher, LocalDateTime.ofEpochSecond(skipped * 60, 0,
                    ZoneOffset.UTC))) {
                return true;
            }
        }
        return false;
    }

    /** The canonical {@code schedule:<slot>} occurrence key of a slot instant. */
    public static String occurrenceKey(long slotMs) {
        if (Math.floorMod(slotMs, MINUTE_MS) != 0) {
            throw new IllegalArgumentException("a slot is a whole-minute epoch instant.");
        }
        return "schedule:" + SLOT.format(Instant.ofEpochMilli(slotMs));
    }

    private static ZonedDateTime at(long instantMs, ZoneId zone) {
        return Instant.ofEpochMilli(instantMs).atZone(zone);
    }

    private static int offsetMinutes(ZonedDateTime zoned) {
        return zoned.getOffset().getTotalSeconds() / 60;
    }

    private static long localMinutes(LocalDateTime wall) {
        return wall.toEpochSecond(ZoneOffset.UTC) / 60;
    }
}
