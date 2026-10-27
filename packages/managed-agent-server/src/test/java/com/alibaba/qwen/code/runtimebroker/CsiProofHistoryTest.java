package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.RandomAccessFile;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CsiProofHistoryTest {
    @Test
    void oldPrefixAndFirstInsertionOrderSurviveTenThousandCompletedFacts() {
        try (var history = CsiProofHistory.create()) {
            Map<String, JsonNode> facts = history.map(1, JsonNode.class);
            for (int index = 0; index < 10_000; index++) {
                facts.put("id-" + index, value(index));
            }
            var frozen = CsiProofHistory.freeze(facts);
            var next = CsiProofHistory.mutable(frozen);
            next.put("id-0", value(20_000));
            next.put("id-10000", value(10_000));
            assertThat(frozen.size()).isEqualTo(10_000);
            assertThat(frozen.get("id-0")).isEqualTo(value(0));
            assertThat(frozen.get("id-10000")).isNull();
            assertThat(next.get("id-0")).isEqualTo(value(20_000));
            assertThat(next.size()).isEqualTo(10_001);
            AtomicInteger ordinal = new AtomicInteger();
            next.forEach((key, entry) -> assertThat(key).isEqualTo("id-" + ordinal.getAndIncrement()));
            assertThat(ordinal).hasValue(10_001);
            assertThatThrownBy(() -> frozen.put("forbidden", value(0))).isInstanceOf(IllegalArgumentException.class);
            ObjectNode returned = (ObjectNode) next.get("id-0");
            returned.put("ordinal", -1);
            assertThat(next.get("id-0")).isEqualTo(value(20_000));
        }
    }

    @Test
    void missingAndDamagedScratchNeverProduceTrustedAbsence() throws Exception {
        for (boolean truncate : java.util.List.of(true, false)) {
            try (var history = CsiProofHistory.create()) {
                Map<String, JsonNode> facts = history.map(1, JsonNode.class);
                facts.put("existing", value(1));
                try (var file = new RandomAccessFile(path(history).toFile(), "rw")) {
                    if (truncate) {
                        file.setLength(0);
                    } else {
                        file.seek(file.length() - 1);
                        int previous = file.readUnsignedByte();
                        file.seek(file.length() - 1);
                        file.writeByte(previous ^ 1);
                    }
                }
                assertThatThrownBy(() -> facts.get("existing")).isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> facts.get(sameBucketAbsent())).isInstanceOf(IllegalArgumentException.class);
            }
        }
    }

    @Test
    void scopeCleansSuccessfulAndRejectedProofsAndDirectoryMemoryStaysFixed() throws Exception {
        CsiProofHistory owner;
        Path path;
        try (var scope = CsiProofHistory.scope()) {
            owner = CsiProofHistory.create();
            path = path(owner);
            Map<String, JsonNode> facts = owner.map(1, JsonNode.class);
            for (int index = 0; index < 10_000; index++) {
                facts.put("id-" + index, value(index));
            }
            Field heads = CsiProofHistory.class.getDeclaredField("heads");
            heads.setAccessible(true);
            Field hashes = CsiProofHistory.class.getDeclaredField("hashes");
            hashes.setAccessible(true);
            assertThat(((long[]) heads.get(owner)).length * Long.BYTES + ((byte[]) hashes.get(owner)).length)
                    .isEqualTo(640 * 1024);
            assertThat(Files.exists(path)).isTrue();
        }
        assertThat(Files.exists(path)).isFalse();
        CsiProofHistory closed = owner;
        assertThatThrownBy(() -> closed.map(1, JsonNode.class).get("absent"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void closingHeadOrMiddleEarlyStillClosesAllThreeRequestOwners() throws Exception {
        for (boolean closeHead : java.util.List.of(true, false)) {
            Path[] paths;
            try (var scope = CsiProofHistory.scope()) {
                var first = CsiProofHistory.create();
                var middle = CsiProofHistory.create();
                var head = CsiProofHistory.create();
                paths = new Path[] {path(first), path(middle), path(head)};
                (closeHead ? head : middle).close();
                assertThat(Files.exists(paths[0])).isTrue();
            }
            for (Path path : paths) {
                assertThat(Files.exists(path)).isFalse();
            }
        }
    }

    @Test
    void maximumCompactNumericMessageRetainsTheOriginalBatchAndAllRefusals() throws Exception {
        int sourceLimit = 8 * 1024 * 1024;
        String prompt = "550e8400-e29b-41d4-a716-446655440001";
        String message = "550e8400-e29b-41d4-a716-446655440002";
        ObjectNode wire = CsiNativeActivationProof.JSON.createObjectNode().put("uuid", message).putNull("parentUuid")
                .put("sessionId", "550e8400-e29b-41d4-a716-446655440003").put("timestamp", "2026-01-01T00:00:00Z")
                .put("type", "assistant").put("cwd", "/workspace").put("version", "hosted-harness/1")
                .put("daemonPromptId", prompt).put("model", "test");
        var parts = wire.putObject("message").put("role", "model").putArray("parts");
        for (int index = 0; index < 256; index++) {
            String id = "call-" + index + "-" + "x".repeat(500);
            var args = parts.addObject().putObject("functionCall").put("id", id).put("name", "read_file")
                    .putObject("args").put("file_path", false);
            if (index == 0) {
                args.putArray("extra");
            }
        }
        String compact = CsiNativeActivationProof.JSON.writeValueAsString(wire);
        int numbers = (sourceLimit - compact.getBytes(java.nio.charset.StandardCharsets.UTF_8).length + 1) / 4;
        compact = compact.replace("\"extra\":[]", "\"extra\":[" + "1e6,".repeat(numbers - 1) + "1e6]");
        byte[] source = compact.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(source.length).isBetween(sourceLimit - 4, sourceLimit);
        JsonNode parsed = CsiNativeActivationProof.readObject(source);
        var calls = new java.util.ArrayList<CsiNativeActivationProof.FunctionCall>();
        var refused = new java.util.HashSet<String>();
        for (int index = 0; index < 256; index++) {
            JsonNode call = parsed.path("message").path("parts").get(index).path("functionCall");
            String id = CsiNativeActivationProof.id(call, "id");
            calls.add(new CsiNativeActivationProof.FunctionCall(id, "read_file", call.path("args"), index, index));
            refused.add(id);
        }
        ObjectNode ref = CsiNativeActivationProof.JSON.createObjectNode().put("resourceId", "message-body")
                .put("kind", "managed-message-chunks").put("schemaVersion", 1).put("byteLength", 64).put("digest", "a".repeat(64));
        var original = new CsiNativeActivationProof.OriginalBatch(prompt,
                new CsiNativeActivationProof.PendingBatch(message, ref, calls, refused));
        int derivedBytes = CsiNativeActivationProof.JSON.writeValueAsBytes(original).length;
        assertThat(derivedBytes).isGreaterThan(sourceLimit + 512 * 1024).isLessThan(32 * 1024 * 1024);
        try (var history = CsiProofHistory.temporary()) {
            Map<String, CsiNativeActivationProof.OriginalBatch> facts = history.map(1, CsiNativeActivationProof.OriginalBatch.class);
            facts.put(message, original);
            var restored = facts.get(message);
            assertThat(restored.batch().calls()).hasSize(256);
            assertThat(restored.batch().refusedFunctionIds()).isEqualTo(refused);
            JsonNode extra = restored.batch().calls().getFirst().args().path("extra");
            assertThat(extra.size()).isEqualTo(numbers);
            assertThat(extra.get(0).isFloatingPointNumber()).isTrue();
            assertThat(extra.get(extra.size() - 1).doubleValue()).isEqualTo(1_000_000.0);
        }
    }

    @Test
    void outOfRangeNumericPathsStayNumericWhileThePublicParserRemainsStrict() {
        String session = "550e8400-e29b-41d4-a716-446655440003";
        var request = CsiFilesRetirementProfile.request(new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", session);
        JsonNode args = CsiNativeActivationProof.readObject("{\"file_path\":1e309}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var call = new CsiNativeActivationProof.FunctionCall("call", "read_file", args, 0, 0);
        var source = new CsiNativeActivationProof.OriginalBatch("prompt", new CsiNativeActivationProof.PendingBatch(
                "message", value(0), java.util.List.of(call)));
        assertThat(CsiNativeToolReservation.refusalReason(request, call)).isEqualTo("CSI file input is invalid.");
        try (var history = CsiProofHistory.temporary()) {
            Map<String, CsiNativeActivationProof.OriginalBatch> facts = history.map(1, CsiNativeActivationProof.OriginalBatch.class);
            facts.put("message", source);
            var restored = facts.get("message").batch().calls().getFirst();
            assertThat(restored.args().path("file_path").isNumber()).isTrue();
            assertThat(restored.args().path("file_path").isTextual()).isFalse();
            assertThat(Double.isInfinite(restored.args().path("file_path").doubleValue())).isTrue();
            assertThat(CsiNativeToolReservation.refusalReason(request, restored)).isEqualTo("CSI file input is invalid.");
        }
        assertThatThrownBy(() -> CsiNativeActivationProof.readObject(
                "{\"file_path\":Infinity}".getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("csi_original_activation_unavailable"));
    }

    @Test
    void receiptWrapperPreservesTheMaximumPublicResourceDepth() {
        String source = "{\"child\":".repeat(63) + "{\"leaf\":1}" + "}".repeat(63);
        JsonNode body = CsiNativeActivationProof.readObject(source.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var receipt = new CsiNativeActivationProof.ToolReceipt(value(0), body, 1, 1, 1);
        try (var history = CsiProofHistory.temporary()) {
            Map<String, CsiNativeActivationProof.ToolReceipt> facts = history.map(1, CsiNativeActivationProof.ToolReceipt.class);
            facts.put("execution", receipt);
            assertThat(facts.get("execution").body()).isEqualTo(body);
        }
        assertThat(CsiNativeActivationProof.JSON.getFactory().streamReadConstraints().getMaxNestingDepth()).isEqualTo(64);
        String tooDeep = "{\"child\":" + source + "}";
        assertThatThrownBy(() -> CsiNativeActivationProof.readObject(tooDeep.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("csi_original_activation_unavailable"));
    }

    @Test
    void terminalSnapshotsKeepSpilledFactsLazyAndIsolateReturnedBodies() {
        try (var prefix = CsiNativeActivationProof.Prefix.spilled()) {
            var receipts = CsiProofHistory.mutable(prefix.receipts());
            for (int index = 0; index < 10_000; index++) {
                receipts.put("execution-" + index, new CsiNativeActivationProof.ToolReceipt(
                        value(index), value(index), 1, index + 1, index + 1));
            }
            var populated = new CsiNativeActivationProof.Prefix(null, null, null, null, false, null,
                    prefix.usedIds(), null, prefix.batches(), null, prefix.intents(), receipts, 0);
            var activation = new CsiNativeActivationProof.Activation("activation", "worker", value(0), 10, 20, 1, 1, 1);
            try (var proof = new CsiNativeActivationProof.TerminalProof(activation, populated, value(0), 1, "record", "digest", 2, "next")) {
                var snapshot = proof.predecessorPrefix();
                assertThat(CsiProofHistory.spilled(snapshot.receipts())).isTrue();
                assertThat(snapshot.receipts().size()).isEqualTo(10_000);
                ((ObjectNode) snapshot.receipts().get("execution-0").body()).put("ordinal", -1);
                assertThat(proof.predecessorPrefix().receipts().get("execution-0").body()).isEqualTo(value(0));
            }
        }
    }

    private static String sameBucketAbsent() {
        byte[] wanted = org.apache.commons.codec.digest.DigestUtils.sha256("1:existing");
        int bucket = ((Byte.toUnsignedInt(wanted[0]) << 8) | Byte.toUnsignedInt(wanted[1])) & ((1 << 14) - 1);
        for (int index = 0; index < 1_000_000; index++) {
            String key = "missing-" + index;
            byte[] digest = org.apache.commons.codec.digest.DigestUtils.sha256("1:" + key);
            if ((((Byte.toUnsignedInt(digest[0]) << 8) | Byte.toUnsignedInt(digest[1])) & ((1 << 14) - 1)) == bucket) {
                return key;
            }
        }
        throw new AssertionError("No collision fixture");
    }

    private static ObjectNode value(int ordinal) {
        return CsiNativeActivationProof.JSON.createObjectNode().put("ordinal", ordinal);
    }

    private static Path path(CsiProofHistory history) throws Exception {
        Field path = CsiProofHistory.class.getDeclaredField("path");
        path.setAccessible(true);
        return (Path) path.get(history);
    }
}
