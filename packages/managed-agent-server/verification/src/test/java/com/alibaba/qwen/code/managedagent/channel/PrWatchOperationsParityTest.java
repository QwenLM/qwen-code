package com.alibaba.qwen.code.managedagent.channel;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
            // A fractional component cannot reach the long-typed Java mirror;
            // JSON binding rejects it before the derivation. The TS refusal
            // stays pinned in the fixture for the TS-side test.
            if (prNumber != Math.rint(prNumber) || episode != Math.rint(episode)) {
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
}
