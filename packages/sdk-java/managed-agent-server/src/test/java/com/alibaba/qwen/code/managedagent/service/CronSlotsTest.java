package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * H6b: the Java slot evaluator replays the shared slots fixture, so the
 * scanner's slots are exactly the ones the TypeScript twin derives.
 */
class CronSlotsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final DateTimeFormatter ISO = DateTimeFormatter
            .ofPattern("uuuu-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);

    @Test
    void replaysEverySharedSlotCase() throws IOException {
        JsonNode fixtures = fixtures();
        assertThat(fixtures.required("contract").asText())
                .isEqualTo("managed-automation-slots/1");
        for (JsonNode zone : fixtures.required("timezones")) {
            assertThat(CronSlots.resolve(zone.asText())).as(zone.asText())
                    .isPresent();
        }
        int replayed = 0;
        for (JsonNode slotCase : fixtures.required("cases")) {
            CronSlots.Slots result = CronSlots.between(
                    CronSlots.compile(slotCase.required("cron").asText()),
                    ZoneId.of(slotCase.required("timezone").asText()),
                    Instant.parse(slotCase.required("after").asText())
                            .toEpochMilli(),
                    Instant.parse(slotCase.required("until").asText())
                            .toEpochMilli(),
                    slotCase.required("limit").asInt());
            List<String> expected = new ArrayList<>();
            slotCase.required("slots").forEach(slot -> expected.add(slot.asText()));
            List<String> actual = result.slots().stream()
                    .map(slot -> ISO.format(Instant.ofEpochMilli(slot))).toList();
            assertThat(actual).as(slotCase.required("id").asText())
                    .isEqualTo(expected);
            assertThat(result.truncated()).as(slotCase.required("id").asText())
                    .isEqualTo(slotCase.required("truncated").asBoolean());
            replayed++;
        }
        assertThat(replayed).isGreaterThan(20);
    }

    @Test
    void replaysEverySharedWallClock() throws IOException {
        for (JsonNode wall : fixtures().required("wallClocks")) {
            ZoneId zone = ZoneId.of(wall.required("timezone").asText());
            var zoned = Instant.parse(wall.required("instant").asText())
                    .atZone(zone);
            String label = wall.required("instant").asText() + " " + zone;
            assertThat(zoned.getYear()).as(label).isEqualTo(wall.required("year").asInt());
            assertThat(zoned.getMonthValue()).as(label).isEqualTo(wall.required("month").asInt());
            assertThat(zoned.getDayOfMonth()).as(label).isEqualTo(wall.required("day").asInt());
            assertThat(zoned.getHour()).as(label).isEqualTo(wall.required("hour").asInt());
            assertThat(zoned.getMinute()).as(label).isEqualTo(wall.required("minute").asInt());
            assertThat(zoned.getDayOfWeek().getValue() % 7).as(label)
                    .isEqualTo(wall.required("weekday").asInt());
            assertThat(zoned.getOffset().getTotalSeconds() / 60).as(label)
                    .isEqualTo(wall.required("offsetMinutes").asInt());
        }
    }

    @Test
    void refusesWhatTheContractRefuses() {
        for (String expression : List.of("* * * *", "60 * * * *", "* * 0 * *",
                "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-5 * * * *",
                "9-5 * * * *")) {
            assertThatThrownBy(() -> CronSlots.compile(expression))
                    .as(expression).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> CronSlots.between(CronSlots.compile("* * * * *"),
                ZoneOffset.UTC, 0, 60_000, 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(CronSlots.resolve("Mars/Olympus_Mons")).isEmpty();
        assertThat(CronSlots.resolve("+08:00")).isEmpty();
    }

    @Test
    void firesSkippedAndRepeatedMinutesOnce() {
        ZoneId newYork = ZoneId.of("America/New_York");
        CronSlots.Matcher gap = CronSlots.compile("30 2 * * *");
        assertThat(CronSlots.isSlot(gap, newYork, at("2026-03-08T06:59:00Z"))).isFalse();
        assertThat(CronSlots.isSlot(gap, newYork, at("2026-03-08T07:00:00Z"))).isTrue();
        assertThat(CronSlots.isSlot(gap, newYork, at("2026-03-08T07:01:00Z"))).isFalse();
        CronSlots.Matcher fold = CronSlots.compile("30 1 * * *");
        assertThat(CronSlots.isSlot(fold, newYork, at("2026-11-01T05:30:00Z"))).isTrue();
        assertThat(CronSlots.isSlot(fold, newYork, at("2026-11-01T06:30:00Z"))).isFalse();
        assertThat(CronSlots.isSlot(fold, newYork, at("2026-11-02T06:30:00Z"))).isTrue();
        assertThat(CronSlots.occurrenceKey(at("2026-03-08T07:00:00Z")))
                .isEqualTo("schedule:2026-03-08T07:00:00Z");
        assertThatThrownBy(() -> CronSlots.occurrenceKey(at("2026-03-08T07:00:30Z")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static long at(String iso) {
        return Instant.parse(iso).toEpochMilli();
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve("packages/core/src/managed-runtime/contracts/managed-automation-slots-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("Automation slots fixtures not found");
    }
}
