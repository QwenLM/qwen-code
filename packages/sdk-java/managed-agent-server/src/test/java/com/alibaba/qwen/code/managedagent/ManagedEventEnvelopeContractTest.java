package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Java fixture consumer for the frozen managed-event-envelope/1 contract:
 * reads the TypeScript fixtures and proves the Java mirror
 * ({@link ManagedEventEnvelopes}) derives, validates and dedupes identically.
 * The contract-first house pattern (see ManagedMcpRecordContractTest).
 */
class ManagedEventEnvelopeContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void derivationFromCommittedEventsMatchesTheFrozenFixtures()
            throws IOException {
        for (JsonNode fixture : fixtures().get("fromEventCases")) {
            String id = fixture.get("id").textValue();
            JsonNode event = fixture.get("event");
            JsonNode expected = fixture.get("envelope");

            ManagedEventEnvelope envelope = ManagedEventEnvelopes.from(event);

            assertEquals(expected.get("v").intValue(), envelope.v(), id);
            assertEquals(expected.get("sessionId").textValue(),
                    envelope.sessionId(), id);
            assertEquals(expected.get("tenantId").textValue(),
                    envelope.tenantId(), id);
            assertEquals(expected.get("workspaceId").textValue(),
                    envelope.workspaceId(), id);
            assertEquals(expected.get("stream").textValue(), envelope.stream(),
                    id);
            assertEquals(expected.get("sequence").longValue(),
                    envelope.sequence(), id);
            assertEquals(expected.get("eventId").textValue(),
                    envelope.eventId(), id);
            assertEquals(expected.get("kind").textValue(), envelope.kind(),
                    id);
            assertEquals(expected.get("occurredAt").longValue(),
                    envelope.occurredAt(), id);
            assertEquals(expected.get("payloadRef").get("digest").textValue(),
                    envelope.payloadRef().digest(), id);
        }
    }

    @Test
    void publicDerivationMatchesTheFrozenFixtures() throws IOException {
        for (JsonNode fixture : fixtures().get("fromPublicEventCases")) {
            String id = fixture.get("id").textValue();
            ManagedEventEnvelope envelope = ManagedEventEnvelopes
                    .fromPublicEventRow(fixture.get("row"),
                            fixture.get("workspaceId").textValue());

            assertEquals(ManagedEventEnvelopes.parse(fixture.get("envelope")),
                    envelope, id);
            assertEquals(fixture.get("envelope").get("payloadRef")
                    .get("digest").textValue(),
                    envelope.payloadRef().digest(), id);
        }
    }

    /**
     * The producer derives the row from the committed EventRecord, not from
     * JSON: the row it builds — data through the store's mapper — must be the
     * frozen row, so the producer's digest is the fixture's.
     */
    @Test
    void publicRowFromACommittedRecordMatchesTheFrozenRow()
            throws IOException {
        for (JsonNode fixture : fixtures().get("fromPublicEventCases")) {
            String id = fixture.get("id").textValue();
            JsonNode row = fixture.get("row");
            @SuppressWarnings("unchecked")
            Map<String, Object> data = JSON.convertValue(row.get("data"),
                    Map.class);
            EventRecord record = new EventRecord(
                    row.get("tenantId").textValue(),
                    row.get("sessionId").textValue(),
                    row.get("sequence").longValue(),
                    row.get("eventId").textValue(),
                    row.get("turnId").isNull() ? null
                            : row.get("turnId").textValue(),
                    row.get("type").textValue(), data,
                    row.get("terminal").booleanValue(), "source-key",
                    row.get("createdAt").longValue());

            ObjectNode built = ManagedEventEnvelopes.publicEventRow(record,
                    JSON);

            // Compared as JSON text re-read, so an int and a long node of the
            // same value are the same row.
            assertEquals(JSON.readTree(row.toString()),
                    JSON.readTree(built.toString()), id);
            assertEquals(fixture.get("envelope").get("payloadRef")
                    .get("digest").textValue(),
                    ManagedEventEnvelopes.fromPublicEventRow(built,
                            fixture.get("workspaceId").textValue())
                            .payloadRef().digest(), id);
        }
    }

    @Test
    void publicDerivationRefusesARowAnEnvelopeCannotName()
            throws IOException {
        ObjectNode row = (ObjectNode) fixtures().get("fromPublicEventCases")
                .get(0).get("row");
        List<ObjectNode> refused = List.of(
                row.deepCopy().put("itemId", "item-1"),
                withoutTurnId(row),
                row.deepCopy().put("sequence", 0),
                row.deepCopy().put("sequence", 1.5),
                row.deepCopy().put("terminal", "false"),
                row.deepCopy().put("type", "Turn.accepted"),
                row.deepCopy().put("turnId", ""),
                row.deepCopy().put("eventId", "evt\u0007"),
                row.deepCopy().put("createdAt", -1));
        for (ObjectNode variant : refused) {
            assertThrows(IllegalArgumentException.class,
                    () -> ManagedEventEnvelopes.fromPublicEventRow(variant,
                            "workspace-1"), variant.toString());
        }
        assertThrows(IllegalArgumentException.class,
                () -> ManagedEventEnvelopes.fromPublicEventRow(row, ""));
    }

    /**
     * The same depth line the TypeScript parse and derivation draw, built
     * from the same fixture limit: {@code data} sits two levels inside the
     * digested {@code [row]}, so a chain of maxJsonDepth - 1 objects is the
     * deepest accepted.
     */
    @Test
    void publicDerivationRefusesDataTooDeepToDigest() throws IOException {
        JsonNode fixtures = fixtures();
        int limit = fixtures.get("limits").get("maxJsonDepth").intValue();
        ObjectNode row = (ObjectNode) fixtures.get("fromPublicEventCases")
                .get(0).get("row");

        ManagedEventEnvelopes.fromPublicEventRow(
                row.deepCopy().set("data", nested(limit - 1)), "workspace-1");
        assertThrows(IllegalArgumentException.class,
                () -> ManagedEventEnvelopes.fromPublicEventRow(
                        row.deepCopy().set("data", nested(limit)),
                        "workspace-1"));
    }

    private static ObjectNode nested(int objects) {
        ObjectNode value = JSON.createObjectNode();
        for (int level = 1; level < objects; level++) {
            ObjectNode outer = JSON.createObjectNode();
            outer.set("a", value);
            value = outer;
        }
        return value;
    }

    private static ObjectNode withoutTurnId(ObjectNode row) {
        ObjectNode copy = row.deepCopy();
        copy.remove("turnId");
        return copy;
    }

    @Test
    void validationMatchesEveryFrozenEnvelopeCase() throws IOException {
        for (JsonNode fixture : fixtures().get("envelopeCases")) {
            String id = fixture.get("id").textValue();
            JsonNode envelope = fixture.get("envelope");
            if (fixture.get("valid").booleanValue()) {
                ManagedEventEnvelopes.parse(envelope);
            } else {
                assertThrows(IllegalArgumentException.class,
                        () -> ManagedEventEnvelopes.parse(envelope), id);
            }
        }
    }

    @Test
    void redeliverySemanticsMatchEveryFrozenDedupeCase() throws IOException {
        for (JsonNode fixture : fixtures().get("dedupeCases")) {
            String id = fixture.get("id").textValue();
            JsonNode first = fixture.get("first");
            JsonNode second = fixture.get("second");
            boolean[] parseable = {
                    fixture.get("parseable").get(0).booleanValue(),
                    fixture.get("parseable").get(1).booleanValue(),
            };
            assertEquals(parseable[0], parses(first), id + " first");
            assertEquals(parseable[1], parses(second), id + " second");
            assertEquals(fixture.get("same").booleanValue(),
                    ManagedEventEnvelopes.isRedelivered(first, second), id);
        }
    }

    private static boolean parses(JsonNode envelope) {
        try {
            ManagedEventEnvelopes.parse(envelope);
            return true;
        } catch (IllegalArgumentException notParseable) {
            return false;
        }
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve(
                    "packages/core/src/managed-runtime/contracts/managed-event-envelope-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("envelope contract fixtures not found");
    }
}
