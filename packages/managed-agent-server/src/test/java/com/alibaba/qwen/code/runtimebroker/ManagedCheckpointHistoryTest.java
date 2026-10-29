package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedCheckpointHistoryTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final Map<String, byte[]> resources = new HashMap<>();

    @Test
    void streamsCompleteArchiveWhileKeepingOnlyInlineTailAndOriginalIdentity() {
        ObjectNode physical = root(100, 2);
        var view = ManagedCheckpointHistory.open(physical, this::read);
        assertThat(view.state().path("tools").path("items").size()).isEqualTo(2);
        assertThat(view.state().path("runtime").path("bindings").size()).isEqualTo(2);
        assertThat(view.toolCount()).isEqualTo(102);
        assertThat(view.bindingCount()).isEqualTo(102);
        assertThat(view.maxOrdinal()).isEqualTo(101);
        assertThat(view.tool("execution-0")).isEqualTo(item(0));
        assertThat(view.binding("execution-0")).isEqualTo(binding(0));
        assertThat(view.tool("absent")).isNull();
        AtomicInteger ordinal = new AtomicInteger();
        view.tools(tool -> assertThat(tool.path("ordinal").intValue()).isEqualTo(ordinal.getAndIncrement()));
        assertThat(ordinal).hasValue(102);
        view.tools(tool -> ((ObjectNode) tool).put("ordinal", -1));
        view.bindings(binding -> ((ObjectNode) binding).put("state", "changed"));
        assertThat(view.tool("execution-100")).isEqualTo(item(100));
        assertThat(view.binding("execution-100")).isEqualTo(binding(100));
    }

    @Test
    void preservesUnknownUnpagedFieldsForTheClosedLogicalSchemaValidator() {
        ObjectNode physical = JSON.createObjectNode();
        physical.putNull("tools").putNull("runtime").putObject("history").put("untrusted", true);
        assertThat(ManagedCheckpointHistory.open(physical, this::read).state()).isEqualTo(physical);
    }

    @Test
    void comparesOrderedLogicalEntriesAcrossRepagingWithoutHydratingEitherRoot() {
        ObjectNode before = root(64, 2);
        var previous = ManagedCheckpointHistory.open(before, this::read);
        ObjectNode after = root(65, 1);
        var current = ManagedCheckpointHistory.open(after, this::read);
        assertThat(current.matches(previous.state(), previous)).isTrue();
        ObjectNode changed = previous.state().deepCopy();
        ((ObjectNode) changed.path("tools").path("items").get(0)).put("functionCallId", "different");
        assertThat(current.matches(changed, previous)).isFalse();
        var reversed = previous.state().deepCopy();
        ((ObjectNode) reversed.path("tools")).putArray("items").add(item(65)).add(item(64));
        assertThat(current.matches(reversed, previous)).isFalse();
    }

    @Test
    void rejectsCrossArchiveDuplicatesAndBindingsWithoutTheirOriginalTool() {
        for (String field : java.util.List.of("executionCallId", "functionCallId", "ordinal")) {
            ObjectNode physical = root(2, 1);
            ObjectNode inline = (ObjectNode) physical.path("tools").path("items").get(0);
            inline.set(field, item(0).path(field));
            assertThatThrownBy(() -> ManagedCheckpointHistory.open(physical, this::read))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        ObjectNode physical = root(2, 1);
        ((ObjectNode) physical.path("runtime").path("bindings").get(0)).put("executionCallId", "missing");
        assertThatThrownBy(() -> ManagedCheckpointHistory.open(physical, this::read))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void missingOrCorruptPageCannotTurnAValidatedNegativeIntoAMiss() {
        for (boolean missing : java.util.List.of(true, false)) {
            ObjectNode physical = root(3, 1);
            var view = ManagedCheckpointHistory.open(physical, this::read);
            if (missing) {
                resources.remove("page-0");
            } else {
                resources.get("page-0")[0] ^= 1;
            }
            if (missing) {
                assertThatThrownBy(() -> view.tool("absent")).isInstanceOf(IllegalArgumentException.class);
            } else {
                assertThatThrownBy(() -> view.tool("absent"))
                        .isInstanceOfSatisfying(RuntimeBrokerException.class,
                                error -> assertThat(error.getCode()).isEqualTo("csi_original_activation_unavailable"));
            }
        }
    }

    @Test
    void rejectsScopeCountAndBrokenArchiveChain() {
        ObjectNode physical = root(3, 1);
        ((ObjectNode) physical.path("identity")).put("promptId", "another-prompt");
        ObjectNode wrongScope = physical;
        assertThatThrownBy(() -> ManagedCheckpointHistory.open(wrongScope, this::read))
                .isInstanceOf(IllegalArgumentException.class);
        physical = root(3, 1);
        ((ObjectNode) physical.path("history")).put("toolCount", 4);
        ObjectNode wrongCount = physical;
        assertThatThrownBy(() -> ManagedCheckpointHistory.open(wrongCount, this::read))
                .isInstanceOf(IllegalArgumentException.class);
        physical = root(3, 1);
        resources.remove("page-1");
        ObjectNode broken = physical;
        assertThatThrownBy(() -> ManagedCheckpointHistory.open(broken, this::read))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private ObjectNode root(int archived, int inline) {
        resources.clear();
        ObjectNode root = JSON.createObjectNode().put("storageProfile", ManagedCheckpointHistory.PROFILE);
        ObjectNode identity = root.putObject("identity").put("turnId", "turn").put("promptId", "prompt");
        ObjectNode key = identity.putObject("sessionKey").put("tenantId", "tenant")
                .put("workspaceId", "workspace").put("sessionId", "session");
        JsonNode previous = JSON.getNodeFactory().nullNode();
        for (int index = 0; index < archived; index++) {
            ObjectNode page = JSON.createObjectNode().put("storageProfile", ManagedCheckpointHistory.KIND + "/1")
                    .put("turnId", "turn").put("promptId", "prompt").put("toolCount", index + 1).put("bindingCount", index + 1);
            page.set("sessionKey", key);
            page.set("previous", previous);
            page.putArray("items").add(item(index));
            page.putArray("bindings").add(binding(index));
            byte[] bytes = page.toString().getBytes(StandardCharsets.UTF_8);
            String id = "page-" + index;
            resources.put(id, bytes);
            previous = JSON.createObjectNode().put("resourceId", id).put("kind", ManagedCheckpointHistory.KIND)
                    .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", CsiNativeActivationProof.sha256(bytes));
        }
        root.putObject("history").put("toolCount", archived).put("bindingCount", archived).set("ref", previous);
        var tools = root.putObject("tools").put("batchId", "batch").putArray("items");
        var bindings = root.putObject("runtime").putArray("bindings");
        for (int index = archived; index < archived + inline; index++) {
            tools.add(item(index));
            bindings.add(binding(index));
        }
        return root;
    }

    private static ObjectNode item(int ordinal) {
        ObjectNode item = JSON.createObjectNode().put("executionCallId", "execution-" + ordinal)
                .put("functionCallId", "call-" + ordinal).put("ordinal", ordinal).put("state", "settled").put("consumed", true);
        item.putObject("outcomeRef").put("resourceId", "outcome-" + ordinal);
        return item;
    }

    private static ObjectNode binding(int ordinal) {
        return JSON.createObjectNode().put("executionCallId", "execution-" + ordinal).put("state", "settled");
    }

    private byte[] read(JsonNode ref) {
        byte[] bytes = resources.get(ref.path("resourceId").textValue());
        if (bytes == null) {
            throw new IllegalArgumentException("Missing checkpoint page");
        }
        return bytes;
    }
}
