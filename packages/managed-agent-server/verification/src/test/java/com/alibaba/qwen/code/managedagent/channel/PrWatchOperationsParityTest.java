package com.alibaba.qwen.code.managedagent.channel;

import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchCreateRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchInjectRequest;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Cross-language parity of the PR-watch identity derivation. The fixture is
 * generated from the authoritative TS contract module
 * (packages/core/src/managed-runtime/managed-pr-watch-operations.ts), so the
 * expected ids are the TS derivation's own output, not this mirror's; the
 * Java mirror must reproduce them byte for byte (same sha256, same NUL-joined
 * tuple order) and refuse the same invalid identities with the same messages.
 */
class PrWatchOperationsParityTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode fixtures() throws IOException {
        try (InputStream stream = PrWatchOperationsParityTest.class
                .getResourceAsStream("/pr-watch/managed-pr-watch-v1.fixtures.json")) {
            assertThat(stream).isNotNull();
            return JSON.readTree(stream);
        }
    }

    @Test
    void pinsTheContractConstants() throws IOException {
        JsonNode fixtures = fixtures();
        assertThat(PrWatchOperations.PR_EVENT_INPUT_SOURCE)
                .isEqualTo(fixtures.get("source").asText());
        List<String> transitions = new ArrayList<>();
        fixtures.get("transitions").forEach(node -> transitions.add(node.asText()));
        assertThat(PrWatchOperations.PR_WATCH_TRANSITIONS).isEqualTo(transitions);
        JsonNode limits = fixtures.get("limits");
        assertThat(PrWatchOperations.MAX_TEXT_CHARS)
                .isEqualTo(limits.get("maxTextChars").asInt());
        assertThat(PrWatchOperations.MAX_ENVELOPE_BYTES)
                .isEqualTo(limits.get("maxEnvelopeBytes").asInt());
        assertThat(PrWatchOperations.MAX_EVIDENCE_CHARS)
                .isEqualTo(limits.get("maxEvidenceChars").asInt());
    }

    @Test
    void derivesTheTsInputAndBindingIdsByteForByte() throws IOException {
        for (JsonNode fixture : fixtures().get("cases")) {
            JsonNode identity = fixture.get("identity");
            String id = fixture.get("id").asText();
            assertThat(PrWatchOperations.prWatchInputId(
                    identity.get("tenantId").asText(),
                    identity.get("channelInstanceId").asText(),
                    identity.get("owner").asText(),
                    identity.get("repo").asText(),
                    identity.get("prNumber").asLong(),
                    identity.get("transition").asText(),
                    identity.get("headSha").asText(),
                    identity.get("episode").asLong()))
                    .as(id).isEqualTo(fixture.get("inputId").asText());
            assertThat(PrWatchOperations.prWatchBindingId(
                    identity.get("tenantId").asText(),
                    identity.get("channelInstanceId").asText(),
                    identity.get("owner").asText(),
                    identity.get("repo").asText(),
                    identity.get("prNumber").asLong()))
                    .as(id).isEqualTo(fixture.get("bindingId").asText());
        }
    }

    @Test
    void refusesTheSameInvalidIdentitiesWithTheSameMessages() throws IOException {
        for (JsonNode fixture : fixtures().get("refusals")) {
            JsonNode identity = fixture.get("identity");
            String id = fixture.get("id").asText();
            String message = fixture.get("message").asText();
            double prNumber = identity.get("prNumber").asDouble();
            double episode = identity.path("episode").asDouble(1);
            // A fractional component never reaches the long-typed Java
            // mirror: the MVC converter disables ACCEPT_FLOAT_AS_INT, so the
            // wire binding refuses the token (route-level 400, pinned by
            // SurfaceAdmissionAcceptanceTest). Pin the same refusal on the
            // request record the route binds; the TS refusal stays pinned in
            // the fixture for the TS-side test.
            if (prNumber != Math.rint(prNumber) || episode != Math.rint(episode)) {
                ObjectMapper strict = new ObjectMapper()
                        .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
                ObjectNode wire = JSON.createObjectNode();
                wire.put("owner", identity.get("owner").asText());
                wire.put("repo", identity.get("repo").asText());
                wire.set("prNumber", identity.get("prNumber"));
                if (identity.has("transition")) {
                    wire.put("transition", identity.get("transition").asText());
                    wire.put("headSha", identity.get("headSha").asText());
                    wire.set("episode", identity.path("episode"));
                    wire.put("evidence", "");
                    wire.put("text", "probe");
                    assertThatThrownBy(() -> strict.readValue(wire.toString(),
                            PrWatchInjectRequest.class))
                            .as(id).isInstanceOf(MismatchedInputException.class);
                } else {
                    wire.put("sessionId", "session-1");
                    wire.putArray("events").add("ci_failure");
                    assertThatThrownBy(() -> strict.readValue(wire.toString(),
                            PrWatchCreateRequest.class))
                            .as(id).isInstanceOf(MismatchedInputException.class);
                }
                continue;
            }
            if (identity.has("transition")) {
                assertThatThrownBy(() -> PrWatchOperations.prWatchInputId(
                        identity.get("tenantId").asText(),
                        identity.get("channelInstanceId").asText(),
                        identity.get("owner").asText(),
                        identity.get("repo").asText(),
                        (long) prNumber,
                        identity.get("transition").asText(),
                        identity.get("headSha").asText(),
                        (long) episode))
                        .as(id)
                        .isInstanceOf(IllegalArgumentException.class)
                        .hasMessage(message);
            } else {
                assertThatThrownBy(() -> PrWatchOperations.prWatchBindingId(
                        identity.get("tenantId").asText(),
                        identity.get("channelInstanceId").asText(),
                        identity.get("owner").asText(),
                        identity.get("repo").asText(),
                        (long) prNumber))
                        .as(id)
                        .isInstanceOf(IllegalArgumentException.class)
                        .hasMessage(message);
            }
        }
    }

    @Test
    void wrapsThePromptByteForByteLikeTheTsContract() throws IOException {
        // Expected values live in the shared fixture, generated from the
        // authoritative TS prWatchInputText; the TS test asserts the same
        // strings, so a wrapper change on either side turns both suites red.
        for (JsonNode fixture : fixtures().get("texts")) {
            JsonNode e = fixture.get("envelope");
            assertThat(PrWatchOperations.prWatchInputText(
                    e.get("owner").asText(),
                    e.get("repo").asText(),
                    e.get("prNumber").asLong(),
                    e.get("transition").asText(),
                    e.get("headSha").asText(),
                    e.get("evidence").asText(),
                    e.get("text").asText()))
                    .isEqualTo(fixture.get("expected").asText());
        }
    }

    @Test
    void pinsTheEventsBoundAgainstTheTransitionSet() throws Exception {
        // The events @Size cap must admit every authoritative transition; a
        // cap copied from today's set size would 400 a valid request once the
        // deferred state_change lands. Pin the bound against the fixture set.
        int transitionCount = fixtures().get("transitions").size();
        java.lang.reflect.RecordComponent events = null;
        for (java.lang.reflect.RecordComponent component
                : PrWatchCreateRequest.class.getRecordComponents()) {
            if (component.getName().equals("events")) {
                events = component;
            }
        }
        assertThat(events).isNotNull();
        // Record-component constraints propagate to the accessor and the
        // backing field, not to the RecordComponent reflection itself.
        jakarta.validation.constraints.Size size =
                events.getAccessor().getAnnotation(jakarta.validation.constraints.Size.class);
        if (size == null) {
            size = PrWatchCreateRequest.class.getDeclaredField("events")
                    .getAnnotation(jakarta.validation.constraints.Size.class);
        }
        assertThat(size).isNotNull();
        assertThat(size.max()).isGreaterThanOrEqualTo(transitionCount);
    }
}
