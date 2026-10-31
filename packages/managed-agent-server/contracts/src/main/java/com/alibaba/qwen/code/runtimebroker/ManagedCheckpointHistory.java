package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/** Physical checkpoint pages; logical execution state remains Harness v1. */
public final class ManagedCheckpointHistory {
    public static final String PROFILE = "managed-checkpoint-paged/1";
    public static final String KIND = "managed-checkpoint-history";
    public static final int PAGE_BYTES = 48 * 1024;
    public static final int PAGE_ITEMS = 32;
    private static final int MAX_PAGES = 4096;
    private static final long MAX_HISTORY_BYTES = 64L * 1024 * 1024;

    private ManagedCheckpointHistory() {}

    public record PageBytes(byte[] bytes, long revision) {}

    @FunctionalInterface
    public interface HistoricalPages {
        public PageBytes read(JsonNode ref, long maximumRevision);
    }

    public interface Reader extends Function<JsonNode, byte[]> {
        public PageBytes historicalPage(JsonNode ref, long maximumRevision);

        public long revision();
    }

    public static Reader reader(Function<JsonNode, byte[]> current, HistoricalPages history, long revision) {
        return new Reader() {
            @Override
            public byte[] apply(JsonNode ref) {
                return current.apply(ref);
            }

            @Override
            public PageBytes historicalPage(JsonNode ref, long maximumRevision) {
                require(KIND.equals(ref.path("kind").asText()));
                return history.read(ref, maximumRevision);
            }

            @Override
            public long revision() {
                return revision;
            }
        };
    }

    public static boolean paged(JsonNode state) {
        return state.has("storageProfile");
    }

    public static JsonNode page(byte[] bytes) {
        require(bytes.length <= PAGE_BYTES);
        JsonNode page = CsiNativeActivationProof.readObject(bytes);
        CsiNativeActivationProof.closed(page, Set.of("storageProfile", "sessionKey", "turnId", "promptId",
                "previous", "toolCount", "bindingCount", "items", "bindings"));
        require((KIND + "/1").equals(page.path("storageProfile").asText())
                && page.path("items").isArray() && page.path("bindings").isArray()
                && page.path("items").size() <= PAGE_ITEMS && page.path("bindings").size() <= PAGE_ITEMS
                && page.path("items").size() + page.path("bindings").size() > 0);
        CsiNativeActivationProof.closed(page.path("sessionKey"), Set.of("tenantId", "workspaceId", "sessionId"));
        for (String field : List.of("tenantId", "workspaceId", "sessionId")) {
            CsiNativeActivationProof.text(page.path("sessionKey"), field);
        }
        CsiNativeActivationProof.number(page.path("toolCount"));
        CsiNativeActivationProof.number(page.path("bindingCount"));
        for (JsonNode item : page.path("items")) {
            require("settled".equals(item.path("state").asText()) && item.path("consumed").isBoolean()
                    && item.path("consumed").booleanValue() && item.hasNonNull("outcomeRef"));
        }
        for (JsonNode binding : page.path("bindings")) {
            require(Set.of("settled", "committed").contains(binding.path("state").asText()));
        }
        if (!page.path("previous").isNull()) {
            pageRef(page.path("previous"));
        }
        return page;
    }

    public static JsonNode hydrate(JsonNode physical, Function<JsonNode, byte[]> resources) {
        if (!paged(physical)) {
            return physical;
        }
        require(PROFILE.equals(physical.path("storageProfile").asText()));
        JsonNode history = physical.path("history");
        CsiNativeActivationProof.closed(history, Set.of("ref", "toolCount", "bindingCount"));
        long tools = CsiNativeActivationProof.number(history.path("toolCount"));
        long bindings = CsiNativeActivationProof.number(history.path("bindingCount"));
        require(tools > 0 && physical.path("tools").path("items").isArray());
        JsonNode next = history.path("ref");
        pageRef(next);
        var pages = new ArrayDeque<JsonNode>();
        var visited = new HashSet<String>();
        long ceiling = resources instanceof Reader reader ? reader.revision() : Long.MAX_VALUE;
        long bytesRead = 0;
        while (!next.isNull()) {
            pageRef(next);
            require(visited.add(next.path("resourceId").asText()) && visited.size() <= MAX_PAGES);
            PageBytes stored = resources instanceof Reader reader ? reader.historicalPage(next, ceiling)
                    : new PageBytes(CsiNativeActivationProof.reference(next, KIND, resources), ceiling);
            require(stored.revision() > 0 && stored.revision() <= ceiling);
            ceiling = stored.revision();
            JsonNode checkedRef = next;
            byte[] raw = CsiNativeActivationProof.reference(checkedRef, KIND, ignored -> stored.bytes());
            bytesRead += raw.length;
            require(bytesRead <= MAX_HISTORY_BYTES);
            JsonNode page = page(raw);
            JsonNode identity = physical.path("identity");
            require(page.path("sessionKey").equals(identity.path("sessionKey"))
                    && page.path("turnId").equals(identity.path("turnId"))
                    && page.path("promptId").equals(identity.path("promptId"))
                    && CsiNativeActivationProof.number(page.path("toolCount")) == tools
                    && CsiNativeActivationProof.number(page.path("bindingCount")) == bindings);
            tools -= page.path("items").size();
            bindings -= page.path("bindings").size();
            require(tools >= 0 && bindings >= 0);
            pages.addFirst(page);
            next = page.path("previous");
        }
        require(tools == 0 && bindings == 0);
        ObjectNode logical = physical.deepCopy();
        logical.remove(List.of("storageProfile", "history"));
        var items = logical.arrayNode();
        var runtime = logical.arrayNode();
        for (JsonNode page : pages) {
            page.path("items").forEach(items::add);
            page.path("bindings").forEach(runtime::add);
        }
        logical.path("tools").path("items").forEach(items::add);
        ((ObjectNode) logical.path("tools")).set("items", items);
        require(logical.path("runtime").isObject() || history.path("bindingCount").longValue() == 0);
        if (logical.path("runtime").isObject()) {
            require(logical.path("runtime").path("bindings").isArray());
            logical.path("runtime").path("bindings").forEach(runtime::add);
            ((ObjectNode) logical.path("runtime")).set("bindings", runtime);
        }
        var executions = new HashSet<String>();
        var calls = new HashSet<String>();
        var ordinals = new HashSet<Long>();
        for (JsonNode item : items) {
            require(executions.add(CsiNativeActivationProof.id(item, "executionCallId"))
                    && calls.add(CsiNativeActivationProof.id(item, "functionCallId"))
                    && ordinals.add(CsiNativeActivationProof.number(item.path("ordinal"))));
        }
        var runtimeIds = new HashSet<String>();
        for (JsonNode binding : runtime) {
            String id = CsiNativeActivationProof.id(binding, "executionCallId");
            require(executions.contains(id) && runtimeIds.add(id));
        }
        return logical;
    }

    public static void pageRef(JsonNode ref) {
        CsiNativeActivationProof.closed(ref, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        CsiNativeActivationProof.id(ref, "resourceId");
        require(KIND.equals(ref.path("kind").asText())
                && CsiNativeActivationProof.number(ref.path("schemaVersion")) == 1
                && CsiNativeActivationProof.number(ref.path("byteLength")) <= PAGE_BYTES);
        require(ref.path("digest").isTextual() && ref.path("digest").textValue().matches("[0-9a-f]{64}"));
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw new IllegalArgumentException("Invalid Managed checkpoint history");
        }
    }
}
