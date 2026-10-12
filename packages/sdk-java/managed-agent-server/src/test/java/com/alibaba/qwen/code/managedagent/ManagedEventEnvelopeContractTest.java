package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

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
