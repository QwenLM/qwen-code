package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayDeque;
import java.util.ArrayList;
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
    private static final int MAX_TOOL_OUTCOME_BYTES = 4 * 1024 * 1024;
    private static final long MAX_SAFE = 9_007_199_254_740_990L;
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64).build()).build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

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
        JsonNode page = readObject(bytes);
        closed(page, Set.of("storageProfile", "sessionKey", "turnId", "promptId",
                "previous", "toolCount", "bindingCount", "items", "bindings"));
        require((KIND + "/1").equals(page.path("storageProfile").asText())
                && page.path("items").isArray() && page.path("bindings").isArray()
                && page.path("items").size() <= PAGE_ITEMS && page.path("bindings").size() <= PAGE_ITEMS
                && page.path("items").size() + page.path("bindings").size() > 0);
        closed(page.path("sessionKey"), Set.of("tenantId", "workspaceId", "sessionId"));
        for (String field : List.of("tenantId", "workspaceId", "sessionId")) {
            text(page.path("sessionKey"), field);
        }
        number(page.path("toolCount"));
        number(page.path("bindingCount"));
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
        closed(history, Set.of("ref", "toolCount", "bindingCount"));
        long tools = number(history.path("toolCount"));
        long bindings = number(history.path("bindingCount"));
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
                    : new PageBytes(reference(next, KIND, resources), ceiling);
            require(stored.revision() > 0 && stored.revision() <= ceiling);
            ceiling = stored.revision();
            JsonNode checkedRef = next;
            byte[] raw = reference(checkedRef, KIND, ignored -> stored.bytes());
            bytesRead += raw.length;
            require(bytesRead <= MAX_HISTORY_BYTES);
            JsonNode page = page(raw);
            JsonNode identity = physical.path("identity");
            require(page.path("sessionKey").equals(identity.path("sessionKey"))
                    && page.path("turnId").equals(identity.path("turnId"))
                    && page.path("promptId").equals(identity.path("promptId"))
                    && number(page.path("toolCount")) == tools
                    && number(page.path("bindingCount")) == bindings);
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
            require(executions.add(id(item, "executionCallId"))
                    && calls.add(id(item, "functionCallId"))
                    && ordinals.add(number(item.path("ordinal"))));
        }
        var runtimeIds = new HashSet<String>();
        for (JsonNode binding : runtime) {
            String id = id(binding, "executionCallId");
            require(executions.contains(id) && runtimeIds.add(id));
        }
        return logical;
    }

    public static void pageRef(JsonNode ref) {
        closed(ref, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        id(ref, "resourceId");
        require(KIND.equals(ref.path("kind").asText())
                && number(ref.path("schemaVersion")) == 1
                && number(ref.path("byteLength")) <= PAGE_BYTES);
        require(ref.path("digest").isTextual() && ref.path("digest").textValue().matches("[0-9a-f]{64}"));
    }

    public static List<JsonNode> records(byte[] bytes) {
        requireProof(bytes != null && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
        try {
            String content = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            requireProof(content.endsWith("\n"));
            List<JsonNode> result = new ArrayList<>();
            for (String line : content.substring(0, content.length() - 1).split("\n", -1)) {
                JsonNode record = object(JSON.readTree(line));
                requireProof(line.getBytes(StandardCharsets.UTF_8).length
                        <= ("managed_session_commit_v1".equals(record.path("subtype").textValue()) ? 64 * 1024 : 1024 * 1024));
                result.add(record);
            }
            requireProof(result.size() <= 257);
            return List.copyOf(result);
        } catch (IOException error) {
            throw invalidProof();
        }
    }

    public static JsonNode readCheckpoint(JsonNode ref, Function<JsonNode, byte[]> resources) {
        JsonNode physical = readObject(reference(ref, "managed-checkpoint", resources));
        if (paged(physical)) {
            ObjectNode active = physical.deepCopy();
            active.remove("history");
            checkpointResources(active, resources);
        } else {
            checkpointResources(physical, resources);
        }
        try {
            return hydrate(physical, resources);
        } catch (IllegalArgumentException error) {
            throw invalidProof();
        }
    }

    public static JsonNode toolOutcomeBody(JsonNode ref, Function<JsonNode, byte[]> resources) {
        if ("managed-tool-outcome".equals(ref.path("kind").textValue())) {
            byte[] bytes = reference(ref, "managed-tool-outcome", resources);
            requireProof(bytes.length <= 64 * 1024);
            return readObject(bytes);
        }
        byte[] manifestBytes = reference(ref, "managed-tool-outcome-chunks", resources);
        requireProof(manifestBytes.length <= 64 * 1024);
        JsonNode manifest = readObject(manifestBytes);
        closed(manifest, Set.of("parts"));
        JsonNode parts = manifest.path("parts");
        requireProof(parts.isArray() && parts.size() > 1 && parts.size() <= 69);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < parts.size(); index++) {
            JsonNode part = parts.get(index);
            requireProof(ids.add(id(part, "resourceId")));
            byte[] content = reference(part, "managed-tool-outcome-part", resources);
            requireProof(content.length > 0 && content.length <= 60 * 1024
                    && (index == parts.size() - 1 || content.length == 60 * 1024)
                    && bytes.size() + content.length <= MAX_TOOL_OUTCOME_BYTES);
            bytes.writeBytes(content);
        }
        requireProof(bytes.size() > 64 * 1024);
        return readObject(bytes.toByteArray());
    }

    public static JsonNode readObject(byte[] bytes) {
        requireProof(bytes != null && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
        try {
            String content = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return object(JSON.readTree(content));
        } catch (IOException error) {
            throw invalidProof();
        }
    }

    public static byte[] reference(JsonNode ref, String kind, Function<JsonNode, byte[]> resources) {
        closed(ref, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        id(ref, "resourceId");
        requireProof(kind.equals(text(ref, "kind")) && number(ref.get("schemaVersion")) == 1);
        byte[] bytes = resources.apply(ref);
        requireProof(bytes != null && bytes.length == number(ref.get("byteLength"))
                && DigestUtils.sha256Hex(bytes).equals(text(ref, "digest")));
        return bytes;
    }

    public static void closed(JsonNode node, Set<String> fields) {
        object(node);
        requireProof(node.size() == fields.size());
        node.fieldNames().forEachRemaining(field -> requireProof(fields.contains(field)));
    }

    public static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        requireProof(value != null && value.isTextual() && !value.textValue().isEmpty()
                && value.textValue().length() <= 4096);
        return value.textValue();
    }

    public static long number(JsonNode value) {
        requireProof(value != null && value.isIntegralNumber() && value.canConvertToLong()
                && value.longValue() >= 0 && value.longValue() <= MAX_SAFE);
        return value.longValue();
    }

    public static String id(JsonNode node, String field) {
        String value = text(node, field);
        byte[] utf8 = value.getBytes(StandardCharsets.UTF_8);
        requireProof(utf8.length <= 512 && new String(utf8, StandardCharsets.UTF_8).equals(value)
                && Normalizer.isNormalized(value, Normalizer.Form.NFC)
                && value.codePoints().noneMatch(character -> character < 0x20 || character >= 0x7f && character <= 0x9f));
        return value;
    }

    private static void checkpointResources(JsonNode node, Function<JsonNode, byte[]> resources) {
        if (node.isObject() && node.has("resourceId")) {
            reference(node, text(node, "kind"), resources);
        } else if (node.isContainerNode()) {
            node.forEach(child -> checkpointResources(child, resources));
        }
    }

    private static JsonNode object(JsonNode node) {
        requireProof(node != null && node.isObject());
        return node;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw new IllegalArgumentException("Invalid Managed checkpoint history");
        }
    }

    private static void requireProof(boolean condition) {
        if (!condition) {
            throw invalidProof();
        }
    }

    private static RuntimeBrokerException invalidProof() {
        return new RuntimeBrokerException(409, "managed_checkpoint_invalid",
                "Managed checkpoint history is invalid.", false);
    }
}
