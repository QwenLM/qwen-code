package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
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
        PageBytes read(JsonNode ref, long maximumRevision);
    }

    public interface Reader extends Function<JsonNode, byte[]> {
        PageBytes historicalPage(JsonNode ref, long maximumRevision);

        long revision();
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

    /** A verified immutable prefix. Only the physical root and one page are resident. */
    public static final class View {
        private final JsonNode physical;
        private final Function<JsonNode, byte[]> resources;
        private final JsonNode state;
        private long toolCount;
        private long bindingCount;
        private long maxOrdinal = -1;

        private View(JsonNode physical, Function<JsonNode, byte[]> resources) {
            this.physical = physical.deepCopy();
            this.resources = resources;
            ObjectNode compact = physical.deepCopy();
            if (paged(physical)) {
                compact.remove(List.of("storageProfile", "history"));
            }
            state = compact;
            long archivedTools = paged(physical) ? number(physical.path("history"), "toolCount") : 0;
            long archivedBindings = paged(physical) ? number(physical.path("history"), "bindingCount") : 0;
            require(archivedTools <= (long) MAX_PAGES * PAGE_ITEMS
                    && archivedBindings <= (long) MAX_PAGES * PAGE_ITEMS);
            try (var scratch = CsiProofHistory.temporary()) {
                Set<String> identities = scratch.identities();
                Consumer<JsonNode> tool = item -> {
                    require(identities.add("execution:" + CsiNativeActivationProof.id(item, "executionCallId")));
                    require(identities.add("function:" + CsiNativeActivationProof.id(item, "functionCallId")));
                    long ordinal = number(item, "ordinal");
                    require(identities.add("ordinal:" + ordinal));
                    maxOrdinal = Math.max(maxOrdinal, ordinal);
                    toolCount++;
                };
                // Bindings can precede their tools in a backwards page walk. Validate the
                // foreign keys only after the entire execution identity prefix is present.
                archived((page, ref, revision) -> page.path("items").forEach(tool));
                state.path("tools").path("items").forEach(tool);
                Consumer<JsonNode> binding = value -> {
                    String id = CsiNativeActivationProof.id(value, "executionCallId");
                    require(identities.contains("execution:" + id));
                    require(identities.add("binding:" + id));
                    bindingCount++;
                };
                archived((page, ref, revision) -> page.path("bindings").forEach(binding));
                state.path("runtime").path("bindings").forEach(binding);
            }
        }

        public JsonNode state() {
            return state.deepCopy();
        }

        public JsonNode physical() {
            return physical.deepCopy();
        }

        public long toolCount() {
            return toolCount;
        }

        public long bindingCount() {
            return bindingCount;
        }

        public long maxOrdinal() {
            return maxOrdinal;
        }

        public JsonNode tool(String executionCallId) {
            JsonNode[] result = {null};
            tools(item -> {
                if (executionCallId.equals(CsiNativeActivationProof.id(item, "executionCallId"))) {
                    require(result[0] == null);
                    result[0] = item.deepCopy();
                }
            });
            return result[0];
        }

        public JsonNode binding(String executionCallId) {
            JsonNode[] result = {null};
            bindings(item -> {
                if (executionCallId.equals(CsiNativeActivationProof.id(item, "executionCallId"))) {
                    require(result[0] == null);
                    result[0] = item.deepCopy();
                }
            });
            return result[0];
        }

        public void tools(Consumer<JsonNode> consumer) {
            chronological("items", item -> consumer.accept(item.deepCopy()));
            state.path("tools").path("items").forEach(item -> consumer.accept(item.deepCopy()));
        }

        public void bindings(Consumer<JsonNode> consumer) {
            chronological("bindings", item -> consumer.accept(item.deepCopy()));
            state.path("runtime").path("bindings").forEach(item -> consumer.accept(item.deepCopy()));
        }

        /** Expected inline mutations retain the prior archive, regardless of repaging. */
        public boolean matches(JsonNode expected, View prior) {
            if (!CsiNativeActivationProof.canonical(header(state)).equals(CsiNativeActivationProof.canonical(header(expected)))) {
                return false;
            }
            return matchesItems(expected, prior, true) && matchesItems(expected, prior, false);
        }

        private boolean matchesItems(JsonNode expected, View prior, boolean tools) {
            var actual = DigestUtils.getSha256Digest();
            var wanted = DigestUtils.getSha256Digest();
            Consumer<JsonNode> actualItem = item -> digest(actual, item);
            if (tools) {
                tools(actualItem);
            } else {
                bindings(actualItem);
            }
            if (prior != null) {
                prior.chronological(tools ? "items" : "bindings", item -> digest(wanted, item));
            }
            expected.path(tools ? "tools" : "runtime").path(tools ? "items" : "bindings")
                    .forEach(item -> digest(wanted, item));
            return MessageDigest.isEqual(actual.digest(), wanted.digest());
        }

        private void chronological(String field, Consumer<JsonNode> consumer) {
            if (!paged(physical)) {
                return;
            }
            // Each footer locates just the preceding page. No in-memory page/ref directory.
            try (var spool = new PageSpool()) {
                archived((page, raw, revision) -> spool.append(raw));
                spool.reverse(page -> page.path(field).forEach(consumer));
            } catch (IOException error) {
                throw failure(error);
            }
        }

        private void archived(PageConsumer consumer) {
            if (!paged(physical)) {
                return;
            }
            require(PROFILE.equals(physical.path("storageProfile").asText()));
            JsonNode history = physical.path("history");
            CsiNativeActivationProof.closed(history, Set.of("ref", "toolCount", "bindingCount"));
            long tools = number(history, "toolCount");
            long bindings = number(history, "bindingCount");
            require(tools > 0 && physical.path("tools").path("items").isArray()
                    && (physical.path("runtime").isObject() || bindings == 0));
            if (physical.path("runtime").isObject()) {
                require(physical.path("runtime").path("bindings").isArray());
            }
            JsonNode next = history.path("ref");
            pageRef(next);
            long ceiling = resources instanceof Reader reader ? reader.revision() : Long.MAX_VALUE;
            long bytesRead = 0;
            int pages = 0;
            while (!next.isNull()) {
                pageRef(next);
                require(++pages <= MAX_PAGES);
                PageBytes stored = resources instanceof Reader reader ? reader.historicalPage(next, ceiling)
                        : new PageBytes(CsiNativeActivationProof.reference(next, KIND, resources), ceiling);
                require(stored.revision() > 0 && stored.revision() <= ceiling);
                ceiling = stored.revision();
                byte[] raw = CsiNativeActivationProof.reference(next, KIND, ignored -> stored.bytes());
                bytesRead += raw.length;
                require(bytesRead <= MAX_HISTORY_BYTES);
                JsonNode current = page(raw);
                JsonNode identity = physical.path("identity");
                require(current.path("sessionKey").equals(identity.path("sessionKey"))
                        && current.path("turnId").equals(identity.path("turnId"))
                        && current.path("promptId").equals(identity.path("promptId"))
                        && number(current, "toolCount") == tools && number(current, "bindingCount") == bindings);
                tools -= current.path("items").size();
                bindings -= current.path("bindings").size();
                require(tools >= 0 && bindings >= 0);
                consumer.accept(current, raw, ceiling);
                next = current.path("previous");
            }
            require(tools == 0 && bindings == 0);
        }
    }

    public static View open(JsonNode physical, Function<JsonNode, byte[]> resources) {
        return new View(physical, resources);
    }

    private static ObjectNode header(JsonNode state) {
        ObjectNode header = state.deepCopy();
        if (header.path("tools").isObject()) {
            ((ObjectNode) header.path("tools")).remove("items");
        }
        if (header.path("runtime").isObject()) {
            ((ObjectNode) header.path("runtime")).remove("bindings");
        }
        return header;
    }

    private static long number(JsonNode node, String field) {
        return CsiNativeActivationProof.number(node.path(field));
    }

    private static void digest(MessageDigest digest, JsonNode item) {
        byte[] bytes = CsiNativeActivationProof.canonical(item).getBytes(StandardCharsets.UTF_8);
        digest.update(java.nio.ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
        digest.update(bytes);
    }

    @FunctionalInterface
    private interface PageConsumer {
        void accept(JsonNode page, byte[] raw, long revision);
    }

    private static IllegalArgumentException failure(IOException error) {
        return new IllegalArgumentException("Managed checkpoint history I/O failed", error);
    }

    private static final class PageSpool implements AutoCloseable {
        private final Path path;
        private final RandomAccessFile file;
        private final MessageDigest digest = DigestUtils.getSha256Digest();
        private long length;

        private PageSpool() throws IOException {
            path = Files.createTempFile("qwen-checkpoint-pages-", ".scratch");
            RandomAccessFile opened;
            try {
                opened = new RandomAccessFile(path.toFile(), "rw");
            } catch (IOException error) {
                Files.deleteIfExists(path);
                throw error;
            }
            file = opened;
        }

        private void append(byte[] raw) {
            byte[] checksum = DigestUtils.sha256(raw);
            try {
                file.write(raw);
                file.write(checksum);
                file.writeInt(raw.length);
                digest.update(raw);
                digest.update(checksum);
                digest.update(java.nio.ByteBuffer.allocate(Integer.BYTES).putInt(raw.length).array());
                length += raw.length + checksum.length + Integer.BYTES;
            } catch (IOException error) {
                throw failure(error);
            }
        }

        private void reverse(Consumer<JsonNode> consumer) throws IOException {
            require(file.length() == length);
            // Qualify the entire derived spool before exposing any item from it.
            var actual = DigestUtils.getSha256Digest();
            file.seek(0);
            byte[] buffer = new byte[8192];
            long remaining = length;
            while (remaining > 0) {
                int count = (int) Math.min(buffer.length, remaining);
                file.readFully(buffer, 0, count);
                actual.update(buffer, 0, count);
                remaining -= count;
            }
            require(MessageDigest.isEqual(actual.digest(), digest.digest()));
            long offset = length;
            while (offset > 0) {
                require(offset >= Integer.BYTES + 32);
                file.seek(offset - Integer.BYTES);
                int size = file.readInt();
                require(size > 0 && size <= PAGE_BYTES && offset >= size + 32L + Integer.BYTES);
                offset -= size + 32L + Integer.BYTES;
                file.seek(offset);
                byte[] raw = new byte[size];
                byte[] checksum = new byte[32];
                file.readFully(raw);
                file.readFully(checksum);
                require(MessageDigest.isEqual(checksum, DigestUtils.sha256(raw)));
                consumer.accept(page(raw));
            }
        }

        @Override
        public void close() throws IOException {
            try {
                file.close();
            } finally {
                Files.deleteIfExists(path);
            }
        }
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
