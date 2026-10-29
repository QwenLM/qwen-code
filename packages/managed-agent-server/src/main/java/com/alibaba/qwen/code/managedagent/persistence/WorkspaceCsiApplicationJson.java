package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;

final class WorkspaceCsiApplicationJson {
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64)
                    .maxStringLength(32 * 1024 * 1024).maxNumberLength(16).build()).build())
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final ObjectMapper TYPED = JSON.copy()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_CREATOR_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS);

    private WorkspaceCsiApplicationJson() {
    }

    static JsonNode object(byte[] bytes, int limit) {
        require(bytes != null && bytes.length > 0 && bytes.length <= limit);
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            JsonNode value = JSON.readTree(text);
            require(value != null && value.isObject());
            return value;
        } catch (IOException malformed) {
            throw new IllegalArgumentException("Invalid original CSI application JSON", malformed);
        }
    }

    static void closed(JsonNode value, Set<String> fields) {
        require(value != null && value.isObject());
        Set<String> actual = new HashSet<>();
        value.fieldNames().forEachRemaining(actual::add);
        require(actual.equals(fields));
    }

    static <T> T typedObject(byte[] bytes, int limit, Class<T> type) {
        JsonNode value = object(bytes, limit);
        try {
            return TYPED.treeToValue(value, type);
        } catch (IOException malformed) {
            throw new IllegalArgumentException("Invalid saved CSI application object", malformed);
        }
    }

    static byte[] base64(JsonNode value, int limit) {
        require(value != null && value.isTextual() && value.textValue().length() <= ((long) limit + 2) / 3 * 4);
        byte[] bytes = Base64.getDecoder().decode(value.textValue());
        require(bytes.length > 0 && bytes.length <= limit && Base64.getEncoder().encodeToString(bytes).equals(value.textValue()));
        return bytes;
    }

    static byte[] encode(Object value) {
        try {
            return JSON.writeValueAsBytes(value);
        } catch (IOException error) {
            throw new IllegalArgumentException("Invalid original CSI application JSON", error);
        }
    }

    static void require(boolean valid) {
        if (!valid) {
            throw new IllegalArgumentException("Invalid original CSI application evidence");
        }
    }
}
