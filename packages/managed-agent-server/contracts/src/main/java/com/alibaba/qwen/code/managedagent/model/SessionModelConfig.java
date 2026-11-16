package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.JsonNode;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

public final class SessionModelConfig {
    private static final Set<String> FIELDS = Set.of("protocol", "model", "base_url", "api_key", "generation_config");
    private static final Set<String> PROTOCOLS = Set.of("openai", "openai-responses", "anthropic", "gemini");
    private static final Set<String> SAMPLING = Set.of("temperature", "top_p", "top_k", "max_tokens",
            "presence_penalty", "frequency_penalty", "seed");
    private static final RequestDigests DIGESTS = new RequestDigests();
    private final Map<String, Object> value;

    private SessionModelConfig(Map<String, Object> value) {
        this.value = Collections.unmodifiableMap(value);
        if (DIGESTS.byteLength(value) > 8192) {
            throw invalid();
        }
    }

    public static SessionModelConfig parse(JsonNode node) {
        if (node == null) {
            return null;
        }
        if (!node.isObject()) {
            throw invalid();
        }
        node.fieldNames().forEachRemaining(key -> {
            if (!FIELDS.contains(key)) {
                throw invalid();
            }
        });
        String protocol = text(node, "protocol", 32);
        if (!PROTOCOLS.contains(protocol)) {
            throw invalid();
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("protocol", protocol);
        result.put("model", text(node, "model", 512));
        String baseUrl = text(node, "base_url", 2048);
        try {
            URI uri = URI.create(baseUrl);
            if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))
                    || uri.getHost() == null || uri.getUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw invalid();
            }
        } catch (IllegalArgumentException invalid) {
            throw invalid();
        }
        result.put("base_url", baseUrl);
        result.put("api_key", text(node, "api_key", 4096));
        JsonNode generation = node.get("generation_config");
        if (generation != null) {
            if (!generation.isObject()) {
                throw invalid();
            }
            var sampling = new TreeMap<String, Object>();
            generation.fields().forEachRemaining(entry -> {
                String key = entry.getKey();
                JsonNode number = entry.getValue();
                if (!SAMPLING.contains(key) || !number.isNumber() || !Double.isFinite(number.doubleValue())) {
                    throw invalid();
                }
                double n = number.doubleValue();
                boolean integer = Set.of("top_k", "max_tokens", "seed").contains(key);
                if (integer && (n != Math.rint(n) || n < ("seed".equals(key) ? Integer.MIN_VALUE : 1)
                        || n > Integer.MAX_VALUE)
                        || "temperature".equals(key) && (n < 0 || n > 2)
                        || "top_p".equals(key) && (n < 0 || n > 1)
                        || key.endsWith("_penalty") && (n < -2 || n > 2)) {
                    throw invalid();
                }
                if (integer) {
                    sampling.put(key, (int) n);
                } else {
                    sampling.put(key, n);
                }
            });
            result.put("generation_config", Collections.unmodifiableMap(sampling));
        }
        return new SessionModelConfig(result);
    }

    private static String text(JsonNode node, String name, int maximumBytes) {
        JsonNode field = node.get(name);
        if (field == null || !field.isTextual() || field.textValue().isBlank()
                || field.textValue().getBytes(StandardCharsets.UTF_8).length > maximumBytes
                || field.textValue().codePoints().anyMatch(Character::isISOControl)) {
            throw invalid();
        }
        return field.textValue();
    }

    public String baseUrl() {
        return (String) value.get("base_url");
    }

    public String digest() {
        return DIGESTS.digest(value);
    }

    public Map<String, Object> wireValue() {
        return value;
    }

    @Override
    public String toString() {
        return "SessionModelConfig[redacted]";
    }

    private static ManagedAgentException invalid() {
        return new ManagedAgentException(400, "invalid_model_config", "Invalid Session model configuration.");
    }
}
