package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

class ManagedAutomationRecordContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void pinsTheKeysVocabulariesAndProjections() throws IOException {
        JsonNode fixtures = fixtures();
        assertEquals("managed-automation-record/1",
                fixtures.required("contract").textValue());
        assertEquals(List.of("catchUp", "catchUpLimit", "cron",
                "definitionDigest", "definitionRevision", "enabled", "goal",
                "kind", "overlap", "ownerScopeId", "promptRef", "run",
                "scheduleId", "sessionMode", "targetSessionId", "timezone"),
                jsonList(fixtures.required("keys").required("schedule")));
        assertEquals(List.of("automationRunId", "definitionRevision", "kind",
                "occurrenceKey", "run", "scheduleId", "sessionMode",
                "targetSessionId"),
                jsonList(fixtures.required("keys").required("automation_run")));
        assertEquals(List.of("kind", "ownerScopeId", "scheduleId"),
                jsonList(fixtures.required("fixedKeys").required("schedule")));
        assertEquals(List.of("automationRunId", "definitionRevision", "kind",
                "occurrenceKey", "scheduleId", "sessionMode", "targetSessionId"),
                jsonList(fixtures.required("fixedKeys").required("automation_run")));
        assertEquals(ManagedExtensionRecords.SCHEDULE_OVERLAP_POLICIES,
                jsonList(fixtures.required("overlapPolicies")));
        assertEquals(ManagedExtensionRecords.SCHEDULE_CATCH_UP_POLICIES,
                jsonList(fixtures.required("catchUpPolicies")));
        assertEquals(ManagedExtensionRecords.SCHEDULE_SESSION_MODES,
                jsonList(fixtures.required("sessionModes")));
        var schedule = ManagedExtensionProjection.RECORD_BODIES.get("schedule");
        var automation = ManagedExtensionProjection.RECORD_BODIES.get("automation_run");
        assertEquals(null, schedule.taskKindOf().apply(
                fixtures.get("templates").get("schedule")));
        assertEquals("automation_run", automation.taskKindOf().apply(
                fixtures.get("templates").get("automation_run")));
        JsonNode run = fixtures.get("templates").get("automation_run");
        assertEquals("run-1", automation.recordId().apply(run));
        // The run block holds no definition pin of its own, so an
        // automation_run task row always reads definitionRevision: null;
        // the authoritative revision lives on the record itself.
        assertEquals(null, ManagedExtensionProjection
                .project(null, run.get("run"), 1_000).definitionRevision());
        assertEquals(3, run.get("definitionRevision").intValue());
        assertTrue(fixtures.required("domains").required("schedule")
                .required("taskKind").isNull());
        assertEquals("automation_run", fixtures.required("domains")
                .required("automation_run").required("taskKind").textValue());
    }

    private static List<String> jsonList(JsonNode node) {
        List<String> values = new java.util.ArrayList<>();
        node.forEach(each -> values.add(each.textValue()));
        return values;
    }

    @Test
    void anchorsEveryFixtureTimezoneInTheHostTzDatabase() throws IOException {
        for (JsonNode zone : fixtures().required("validatedTimezones")) {
            assertTrue(ZoneId.getAvailableZoneIds().contains(zone.textValue()),
                    zone.textValue());
        }
    }

    @Test
    void validatesTheSharedRecordsAndStarts() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("cases")) {
            String domain = fixture.get("domain").textValue();
            String id = fixture.get("id").textValue();
            var body = ManagedExtensionProjection.RECORD_BODIES.get(domain);
            JsonNode record = ManagedChildRunRecordContractTest
                    .merge(fixtures.get("templates").get(domain),
                            fixture.get("patch"));
            if (fixture.get("valid").booleanValue()) {
                body.require().accept(record);
            } else {
                InvalidRecordException refused = assertThrows(InvalidRecordException.class,
                        () -> body.require().accept(record), id);
                // Every invalid case names the clause that must refuse it,
                // so a masked guard can never slip a fixture green.
                assertTrue(refused.getMessage().contains(fixture.get("error").textValue()),
                        id + ": " + refused.getMessage());
            }
            assertEquals(fixture.get("start").booleanValue(), body.isStart().test(record), id);
        }
    }

    @Test
    void validatesTheSharedSuccessors() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("successors")) {
            String domain = fixture.get("domain").textValue();
            JsonNode template = fixtures.get("templates").get(domain);
            assertEquals(fixture.get("valid").booleanValue(),
                    ManagedExtensionProjection.RECORD_BODIES.get(domain).isSuccessor().test(
                            ManagedChildRunRecordContractTest.merge(template, fixture.get("before")),
                            ManagedChildRunRecordContractTest.merge(template, fixture.get("after"))),
                    fixture.get("id").textValue());
        }
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve("packages/core/src/managed-runtime/contracts/managed-automation-record-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("Automation record contract fixtures not found");
    }
}
