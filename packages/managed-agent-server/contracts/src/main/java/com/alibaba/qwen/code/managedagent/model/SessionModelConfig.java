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
    private final Value value;

    private SessionModelConfig(Value value) {
        this.value = value;
        if (DIGESTS.byteLength(wireValue()) > 8192) {
            throw invalid();
        }
    }

    private record Value(String protocol, String model, String baseUrl,
            String apiKey, Generation generation) {
        @Override
        public String toString() {
            return "Value[redacted]";
        }
    }

    private record Generation(Double temperature, Double topP, Integer topK,
            Integer maxTokens, Double presencePenalty, Double frequencyPenalty,
            Integer seed) {
        Map<String, Object> wireValue() {
            Map<String, Object> result = new TreeMap<>();
            put(result, "temperature", temperature);
            put(result, "top_p", topP);
            put(result, "top_k", topK);
            put(result, "max_tokens", maxTokens);
            put(result, "presence_penalty", presencePenalty);
            put(result, "frequency_penalty", frequencyPenalty);
            put(result, "seed", seed);
            return Collections.unmodifiableMap(result);
        }

        private static void put(Map<String, Object> target, String key,
                Object value) {
            if (value != null) {
                target.put(key, value);
            }
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
        // The model id lands in ma_session.model_id VARCHAR(128), counted in
        // characters; the shared text rule still bans blank/control content.
        String model = text(node, "model", 512);
        if (model.length() > 128) {
            throw invalid();
        }
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
        String apiKey = text(node, "api_key", 4096);
        JsonNode generationNode = node.get("generation_config");
        Generation generation = null;
        if (generationNode != null) {
            if (!generationNode.isObject()) {
                throw invalid();
            }
            var sampling = new TreeMap<String, Object>();
            generationNode.fields().forEachRemaining(entry -> {
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
            generation = new Generation((Double) sampling.get("temperature"),
                    (Double) sampling.get("top_p"), (Integer) sampling.get("top_k"),
                    (Integer) sampling.get("max_tokens"),
                    (Double) sampling.get("presence_penalty"),
                    (Double) sampling.get("frequency_penalty"),
                    (Integer) sampling.get("seed"));
        }
        return new SessionModelConfig(new Value(protocol, model, baseUrl,
                apiKey, generation));
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
        return value.baseUrl();
    }

    public String digest() {
        return DIGESTS.digest(wireValue());
    }

    public Map<String, Object> wireValue() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("protocol", value.protocol());
        result.put("model", value.model());
        result.put("base_url", value.baseUrl());
        result.put("api_key", value.apiKey());
        if (value.generation() != null) {
            result.put("generation_config", value.generation().wireValue());
        }
        return Collections.unmodifiableMap(result);
    }

    @Override
    public String toString() {
        return "SessionModelConfig[redacted]";
    }

    private static ManagedAgentException invalid() {
        return new ManagedAgentException(400, "invalid_model_config", "Invalid Session model configuration.");
    }
}
