package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.store.ManagedTeamRecords;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.junit.jupiter.api.Test;

/**
 * Replays the language-neutral managed-team-record/1 fixtures (H4e of
 * #12827) that the TypeScript module replays too.
 */
class ManagedTeamRecordContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> RECORD_ID = Map.of(
            "team_state", "teamId", "team_task", "taskId",
            "team_message", "messageId", "team_plan", "requestId");

    @Test
    void pinsTheContractTheKeysAndTheLimits() throws IOException {
        JsonNode fixtures = fixtures();
        assertEquals("managed-team-record/1",
                fixtures.required("contract").textValue());
        assertEquals(ManagedTeamRecords.LEADER,
                fixtures.required("leader").textValue());
        JsonNode limits = fixtures.required("limits");
        assertEquals(ManagedTeamRecords.MAX_MEMBERS,
                limits.required("maxMembers").intValue());
        assertEquals(ManagedTeamRecords.MAX_NAME_LENGTH,
                limits.required("maxNameLength").intValue());
        assertEquals(ManagedTeamRecords.MAX_BLOCKERS,
                limits.required("maxBlockers").intValue());
        assertEquals(ManagedTeamRecords.MAX_CONTENT_BYTES,
                limits.required("maxContentBytes").longValue());
        assertEquals(ManagedTeamRecords.MAX_METADATA_BYTES,
                limits.required("maxMetadataBytes").longValue());
        assertEquals(List.of("leadSessionId", "lifecycle", "members",
                "membershipRevision", "name", "run", "teamId"),
                jsonList(fixtures.at("/keys/team_state")));
        assertEquals(List.of("activeForm", "blockedBy", "descriptionRef",
                "metadataRef", "number", "owner", "run", "status", "subject",
                "taskId", "teamId"), jsonList(fixtures.at("/keys/team_task")));
        assertEquals(List.of("contentDigest", "contentRef", "from", "inputId",
                "kind", "messageId", "run", "targetSessionId", "teamId", "to"),
                jsonList(fixtures.at("/keys/team_message")));
        assertEquals(List.of("decision", "feedbackRef", "member", "planRef",
                "planRevision", "requestId", "run", "teamId"),
                jsonList(fixtures.at("/keys/team_plan")));
        assertEquals(List.of("leadSessionId", "name", "teamId"),
                jsonList(fixtures.at("/fixedKeys/team_state")));
        assertEquals(List.of("number", "taskId", "teamId"),
                jsonList(fixtures.at("/fixedKeys/team_task")));
        assertEquals(List.of("contentDigest", "contentRef", "from", "kind",
                "messageId", "teamId", "to"),
                jsonList(fixtures.at("/fixedKeys/team_message")));
        assertEquals(List.of("member", "planRef", "planRevision", "requestId",
                "teamId"), jsonList(fixtures.at("/fixedKeys/team_plan")));
        fixtures.required("domains").fieldNames().forEachRemaining(domain -> {
            assertNotNull(ManagedExtensionProjection.RECORD_BODIES.get(domain),
                    domain);
            assertTrue(fixtures.at("/domains/" + domain + "/taskKind")
                    .isNull(), domain);
        });
    }

    @Test
    void validatesTheSharedRecordsAndStarts() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("cases")) {
            String id = fixture.get("id").textValue();
            String domain = fixture.get("domain").textValue();
            var body = ManagedExtensionProjection.RECORD_BODIES.get(domain);
            JsonNode record = merge(template(fixtures, fixture),
                    fixture.get("patch"));
            if (fixture.get("valid").booleanValue()) {
                body.require().accept(record);
                assertNull(body.taskKindOf().apply(record), id);
                assertEquals(record.get(RECORD_ID.get(domain)).textValue(),
                        body.recordId().apply(record), id);
            } else {
                InvalidRecordException refused = assertThrows(
                        InvalidRecordException.class,
                        () -> body.require().accept(record), id);
                // Every invalid case names the clause that must refuse it,
                // so a masked guard can never slip a fixture green.
                assertTrue(refused.getMessage()
                        .contains(fixture.get("error").textValue()),
                        id + ": " + refused.getMessage());
            }
            assertEquals(fixture.get("start").booleanValue(),
                    body.isStart().test(record), id);
        }
    }

    @Test
    void validatesTheSharedSuccessors() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("successors")) {
            JsonNode base = template(fixtures, fixture);
            assertEquals(fixture.get("valid").booleanValue(),
                    ManagedExtensionProjection.RECORD_BODIES
                            .get(fixture.get("domain").textValue())
                            .isSuccessor().test(
                                    merge(base, fixture.get("before")),
                                    merge(base, fixture.get("after"))),
                    fixture.get("id").textValue());
        }
    }

    private static JsonNode template(JsonNode fixtures, JsonNode fixture) {
        return Objects.requireNonNull(fixtures.get("templates")
                .get(fixture.get("template").textValue()),
                () -> fixture.get("id").textValue()
                        + " names an unknown template");
    }

    private static List<String> jsonList(JsonNode node) {
        List<String> values = new ArrayList<>();
        node.forEach(each -> values.add(each.textValue()));
        return values;
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve(
                    "packages/core/src/managed-runtime/contracts/managed-team-record-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("Team contract fixtures not found");
    }

    static JsonNode merge(JsonNode base, JsonNode patch) {
        ObjectNode value = base == null || !base.isObject()
                ? JSON.createObjectNode() : base.deepCopy();
        patch.fields().forEachRemaining(entry -> value.set(entry.getKey(),
                entry.getValue().isObject()
                        ? merge(value.get(entry.getKey()), entry.getValue())
                        : entry.getValue().deepCopy()));
        return value;
    }
}
