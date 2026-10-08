package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

class ManagedSessionStoreContractFixtureTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path FIXTURE = findFixture();

    @Test
    void consumesSharedHeadersAndLimits() throws IOException {
        JsonNode contract = read();
        JsonNode headers = contract.required("headers");
        JsonNode limits = contract.required("limits");

        assertEquals(1, contract.required("contractVersion").intValue());
        // Every header and limit is read: a key nobody asserts cannot hide.
        assertEquals(Set.of("tenant", "writerToken"),
                fieldNames(headers).keySet());
        assertEquals(Set.of("maxInlineResourceBytes",
                "maxResourcesPerTransaction", "maxTransactionBytes",
                "maxTransactionEvents", "maxJsonDepth", "maxEventBytes",
                "maxCommitMarkerBytes",
                "minimumWriterTokenLength", "maximumWriterTokenLength",
                "minimumLeaseDurationMs", "maximumLeaseDurationMs"),
                fieldNames(limits).keySet());
        assertEquals(TenantContextFilter.HEADER,
                headers.required("tenant").textValue());
        assertEquals(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                headers.required("writerToken").textValue());
        assertEquals(ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES,
                limits.required("maxInlineResourceBytes").intValue());
        assertEquals(ManagedSessionStoreModels.MAX_RESOURCES_PER_TRANSACTION,
                limits.required("maxResourcesPerTransaction").intValue());
        assertEquals(ManagedSessionStoreModels.MAX_TRANSACTION_BYTES,
                limits.required("maxTransactionBytes").intValue());
        assertEquals(ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS,
                limits.required("maxTransactionEvents").intValue());
        assertEquals(ManagedSessionStoreModels.MAX_JSON_DEPTH,
                limits.required("maxJsonDepth").intValue());
        assertEquals(ManagedSessionStoreModels.MAX_EVENT_BYTES,
                limits.required("maxEventBytes").intValue());
        assertEquals(ManagedSessionStoreModels.MAX_COMMIT_MARKER_BYTES,
                limits.required("maxCommitMarkerBytes").intValue());
        assertEquals(ManagedSessionStoreModels.MIN_WRITER_TOKEN_LENGTH,
                limits.required("minimumWriterTokenLength").intValue());
        assertEquals(ManagedSessionStoreModels.MAX_WRITER_TOKEN_LENGTH,
                limits.required("maximumWriterTokenLength").intValue());
        assertEquals(ManagedSessionStoreModels.MIN_LEASE_MILLIS,
                limits.required("minimumLeaseDurationMs").longValue());
        assertEquals(ManagedSessionStoreModels.MAX_LEASE_MILLIS,
                limits.required("maximumLeaseDurationMs").longValue());
        assertEquals(JSON.valueToTree(ManagedExtensionRecords.EVENT_KINDS),
                contract.required("eventKinds"));
    }

    @Test
    void reconstructsSharedExactBytesAndDigests() throws IOException {
        JsonNode contract = read();
        for (JsonNode resource : contract.required("resources")) {
            byte[] bytes = resource.required("utf8").textValue()
                    .getBytes(StandardCharsets.UTF_8);
            assertEquals(resource.required("bytesBase64").textValue(),
                    Base64.getEncoder().encodeToString(bytes));
            assertEquals(resource.required("byteLength").longValue(),
                    bytes.length);
            assertEquals(resource.required("digest").textValue(),
                    sha256(bytes));
        }

        JsonNode transaction = contract.required("genesisTransaction");
        JsonNode request = transaction.required("expectedRequest");
        // Internal coherence of the published shape, not only of the digest:
        // an edit regenerating one field must not keep the fixture green
        // while its request summary disagrees with its records.
        assertEquals(request.required("recordCount").intValue(),
                transaction.required("records").size());
        String sessionId = contract.required("sessionKey")
                .required("sessionId").textValue();
        for (JsonNode record : transaction.required("records")) {
            assertEquals(sessionId, record.required("sessionId").textValue());
        }
        long firstSequence = request.required("firstSequence").longValue();
        long lastSequence = request.required("lastSequence").longValue();
        long eventCount = request.required("eventCount").longValue();
        assertEquals("session.create",
                request.required("operation").textValue());
        assertEquals(0L, eventCount);
        assertEquals(0L, firstSequence);
        assertEquals(0L, lastSequence);
        assertEquals(2, request.required("recordCount").intValue());
        assertTrue(request.path("eventsDigest").isMissingNode()
                || request.required("eventsDigest").isNull());
        assertTrue(request.path("previousCommitDigest").isMissingNode()
                || request.required("previousCommitDigest").isNull());
        assertTrue(request.path("commitDigest").isMissingNode()
                || request.required("commitDigest").isNull());
        StringBuilder jsonl = new StringBuilder();
        for (JsonNode record : transaction.required("records")) {
            jsonl.append(JSON.writeValueAsString(record)).append('\n');
        }
        byte[] bytes = jsonl.toString().getBytes(StandardCharsets.UTF_8);
        assertEquals(transaction.required("jsonl").textValue(),
                jsonl.toString());
        assertEquals(transaction.required("recordBytesBase64").textValue(),
                Base64.getEncoder().encodeToString(bytes));
        assertEquals(transaction.required("byteLength").longValue(),
                bytes.length);
        assertEquals(transaction.required("recordDigest").textValue(),
                sha256(bytes));
        assertEquals(transaction.required("recordDigest").textValue(),
                transaction.required("expectedRequest")
                        .required("contentDigest").textValue());
    }

    @Test
    void consumesSharedErrorClassifications() throws IOException {
        Map<String, ExpectedError> expected = new LinkedHashMap<>();
        expected.put("writerConflict", new ExpectedError(
                HttpStatus.CONFLICT.value(),
                ManagedSessionStoreModels.ERROR_WRITER_CONFLICT));
        expected.put("idempotencyConflict", new ExpectedError(
                HttpStatus.CONFLICT.value(),
                ManagedSessionStoreModels.ERROR_IDEMPOTENCY_CONFLICT));
        expected.put("recoveryConflict", new ExpectedError(
                HttpStatus.CONFLICT.value(),
                ManagedSessionStoreModels.ERROR_RECOVERY_CONFLICT));
        expected.put("resourceMissing", new ExpectedError(
                HttpStatus.CONFLICT.value(),
                ManagedSessionStoreModels.ERROR_RESOURCE_MISSING));
        expected.put("resourceNotFound", new ExpectedError(
                HttpStatus.NOT_FOUND.value(),
                ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND));
        expected.put("writerCredentialInvalid", new ExpectedError(
                HttpStatus.FORBIDDEN.value(),
                ManagedSessionStoreModels.ERROR_WRITER_CREDENTIAL_INVALID));
        expected.put("ossDisabled", new ExpectedError(
                HttpStatus.NOT_IMPLEMENTED.value(),
                ManagedSessionStoreModels.ERROR_OSS_DISABLED));
        expected.put("invalidRequest", new ExpectedError(
                HttpStatus.BAD_REQUEST.value(),
                ManagedSessionStoreModels.ERROR_INVALID_REQUEST));
        expected.put("payloadTooLarge", new ExpectedError(
                HttpStatus.PAYLOAD_TOO_LARGE.value(),
                ManagedSessionStoreModels.ERROR_PAYLOAD_TOO_LARGE));
        expected.put("journalCorrupt", new ExpectedError(
                HttpStatus.INTERNAL_SERVER_ERROR.value(),
                ManagedSessionStoreModels.ERROR_JOURNAL_CORRUPT));
        expected.put("headCorrupt", new ExpectedError(
                HttpStatus.INTERNAL_SERVER_ERROR.value(),
                ManagedSessionStoreModels.ERROR_HEAD_CORRUPT));

        JsonNode errors = read().required("errors");
        assertEquals(expected.keySet(), fieldNames(errors).keySet());
        expected.forEach((name, value) -> {
            JsonNode fixture = errors.required(name);
            assertEquals(value.status(),
                    fixture.required("status").intValue(), name);
            assertEquals(value.code(),
                    fixture.required("code").textValue(), name);
        });
    }

    private static JsonNode read() throws IOException {
        assertTrue(Files.isRegularFile(FIXTURE),
                () -> "missing shared contract fixture: " + FIXTURE);
        return JSON.readTree(FIXTURE.toFile());
    }

    private static Map<String, JsonNode> fieldNames(JsonNode object) {
        Map<String, JsonNode> fields = new LinkedHashMap<>();
        object.properties().forEach(field -> fields.put(field.getKey(),
                field.getValue()));
        return fields;
    }

    private static Path findFixture() {
        Path current = Path.of(System.getProperty("user.dir"))
                .toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            Path candidate = current.resolve(Path.of("packages", "core",
                    "src", "managed-runtime", "contracts",
                    "managed-session-store-v1.fixtures.json"));
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            current = current.getParent();
        }
        throw new AssertionError(
                "cannot locate shared Managed Session store fixture");
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest
                    .getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private record ExpectedError(int status, String code) {
    }
}
