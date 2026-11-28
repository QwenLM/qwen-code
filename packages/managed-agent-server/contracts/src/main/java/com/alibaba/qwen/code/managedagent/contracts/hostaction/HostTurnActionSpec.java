package com.alibaba.qwen.code.managedagent.contracts.hostaction;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * Typed host-owned action specification registered for one authorized
 * {@code hosted-workspace-external-files/1} Turn.
 */
public record HostTurnActionSpec(
        String name,
        String description,
        Map<String, Object> inputSchema,
        String contextRef) {
    public static final int MAX_ACTIONS_PER_TURN = 16;
    public static final int MAX_TOTAL_BYTES = 65_536;
    public static final int MAX_DESCRIPTION_BYTES = 4_096;
    public static final int MAX_SCHEMA_BYTES = 16_384;
    public static final int MAX_CONTEXT_REF_LENGTH = 512;

    private static final Pattern NAME_PATTERN = Pattern.compile("^[A-Za-z_][A-Za-z0-9_-]{0,63}$");
    private static final Set<String> RESERVED_TOOL_NAMES = Set.of(
            "read_file", "write_file", "edit", "glob", "skill",
            "run_shell_command", "web_fetch", "todo_write", "agent",
            "workflow", "send_message", "ask_user_question", "exit_plan_mode",
            "monitor", "loop_wakeup", "cron_create", "cron_list", "cron_delete",
            "team_create", "team_delete", "managed_automation_gate");
    private static final Set<String> ALLOWED_SCHEMA_TYPES = Set.of(
            "string", "number", "integer", "boolean", "array", "object");

    public HostTurnActionSpec {
        if (name == null || !NAME_PATTERN.matcher(name).matches()
                || RESERVED_TOOL_NAMES.contains(name) || name.startsWith("mcp_")) {
            throw new IllegalArgumentException("Invalid or reserved host action name: " + name);
        }
        if (description == null || description.isBlank()
                || description.getBytes(StandardCharsets.UTF_8).length > MAX_DESCRIPTION_BYTES
                || hasDisallowedControl(description, true)) {
            throw new IllegalArgumentException("Invalid host action description for " + name);
        }
        inputSchema = canonicalRootSchema(inputSchema, name);
        if (contextRef != null) {
            if (contextRef.isBlank() || contextRef.length() > MAX_CONTEXT_REF_LENGTH
                    || hasDisallowedControl(contextRef, false)) {
                throw new IllegalArgumentException("Invalid host action contextRef for " + name);
            }
        }
    }

    public HostTurnActionSpec(String name, String description, Map<String, Object> inputSchema) {
        this(name, description, inputSchema, null);
    }

    @Override
    public Map<String, Object> inputSchema() {
        return inputSchema;
    }

    /** Wire declaration sent to the Hosted Harness; strips {@code contextRef}. */
    public Map<String, Object> wireDeclaration() {
        Map<String, Object> wire = new LinkedHashMap<>();
        wire.put("name", name);
        wire.put("description", description);
        wire.put("inputSchema", inputSchema);
        return Collections.unmodifiableMap(wire);
    }

    /** Canonical value included in command idempotency digests and SQL storage. */
    public Map<String, Object> semanticValue() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("name", name);
        map.put("description", description);
        map.put("inputSchema", inputSchema);
        if (contextRef != null) {
            map.put("contextRef", contextRef);
        }
        return Collections.unmodifiableMap(map);
    }

    /** Validates and copies model-supplied arguments against {@link #inputSchema()}. */
    public Map<String, Object> validateArguments(Map<String, Object> rawArguments) {
        if (rawArguments == null) {
            throw new IllegalArgumentException("Host action arguments must be an object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> validated = (Map<String, Object>) validateValue(
                inputSchema, rawArguments, "$", 0);
        return validated;
    }

    public static List<HostTurnActionSpec> validateList(List<HostTurnActionSpec> specs) {
        if (specs == null || specs.isEmpty()) {
            return List.of();
        }
        if (specs.size() > MAX_ACTIONS_PER_TURN) {
            throw new IllegalArgumentException("At most " + MAX_ACTIONS_PER_TURN + " host actions are permitted per Turn");
        }
        Set<String> names = new LinkedHashSet<>();
        List<HostTurnActionSpec> copy = new ArrayList<>(specs.size());
        for (HostTurnActionSpec spec : specs) {
            Objects.requireNonNull(spec, "HostTurnActionSpec must not be null");
            if (!names.add(spec.name())) {
                throw new IllegalArgumentException("Duplicate host action name: " + spec.name());
            }
            copy.add(spec);
        }
        return Collections.unmodifiableList(copy);
    }

    private static boolean hasDisallowedControl(String text, boolean allowWhitespace) {
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (Character.isSurrogate(ch)) {
                if (Character.isHighSurrogate(ch) && i + 1 < text.length()
                        && Character.isLowSurrogate(text.charAt(i + 1))) {
                    i++;
                    continue;
                }
                return true;
            }
            if (Character.isISOControl(ch)) {
                if (allowWhitespace && (ch == '\n' || ch == '\t')) {
                    continue;
                }
                return true;
            }
        }
        return false;
    }

    private static Map<String, Object> canonicalRootSchema(Map<String, Object> raw, String actionName) {
        if (raw == null) {
            throw new IllegalArgumentException("Host action inputSchema is required for " + actionName);
        }
        Map<String, Object> normalized = normalizeSchemaNode(raw, true, 0);
        int approxBytes = estimateJsonBytes(normalized);
        if (approxBytes > MAX_SCHEMA_BYTES) {
            throw new IllegalArgumentException("Host action inputSchema exceeds byte bound for " + actionName);
        }
        return normalized;
    }

    private static Map<String, Object> normalizeSchemaNode(Map<?, ?> node, boolean root, int depth) {
        if (depth > 8) {
            throw new IllegalArgumentException("Host action inputSchema exceeds maximum nesting depth");
        }
        Object typeValue = node.get("type");
        if (!(typeValue instanceof String type) || !ALLOWED_SCHEMA_TYPES.contains(type)) {
            throw new IllegalArgumentException("Host action schema requires a supported type");
        }
        if (root && !"object".equals(type)) {
            throw new IllegalArgumentException("Root host action inputSchema must have type \"object\"");
        }
        Map<String, Object> result = new TreeMap<>();
        result.put("type", type);
        Object description = node.get("description");
        if (description != null) {
            if (!(description instanceof String desc) || hasDisallowedControl(desc, true) || desc.length() > 2048) {
                throw new IllegalArgumentException("Invalid schema description");
            }
            result.put("description", desc);
        }
        if ("object".equals(type)) {
            Object rawProps = node.get("properties");
            if (!(rawProps instanceof Map<?, ?> propsMap)) {
                throw new IllegalArgumentException("Object schema requires a properties map");
            }
            Map<String, Object> properties = new TreeMap<>();
            for (Map.Entry<?, ?> entry : propsMap.entrySet()) {
                if (!(entry.getKey() instanceof String propName) || propName.isEmpty() || propName.length() > 128
                        || hasDisallowedControl(propName, false) || !(entry.getValue() instanceof Map<?, ?> child)) {
                    throw new IllegalArgumentException("Invalid property schema in host action");
                }
                properties.put(propName, normalizeSchemaNode(child, false, depth + 1));
            }
            result.put("properties", Collections.unmodifiableMap(properties));
            Object rawRequired = node.get("required");
            if (rawRequired != null) {
                if (!(rawRequired instanceof List<?> reqList)) {
                    throw new IllegalArgumentException("Schema required must be a string list");
                }
                List<String> required = new ArrayList<>(reqList.size());
                Set<String> seen = new LinkedHashSet<>();
                for (Object item : reqList) {
                    if (!(item instanceof String reqName) || !properties.containsKey(reqName) || !seen.add(reqName)) {
                        throw new IllegalArgumentException("Schema required names an unknown or duplicate property");
                    }
                    required.add(reqName);
                }
                result.put("required", Collections.unmodifiableList(required));
            }
            Object additional = node.get("additionalProperties");
            if (additional != null && !(additional instanceof Boolean)) {
                throw new IllegalArgumentException("Schema additionalProperties must be a boolean");
            }
            result.put("additionalProperties", Boolean.TRUE.equals(additional));
        } else if ("array".equals(type)) {
            Object items = node.get("items");
            if (!(items instanceof Map<?, ?> itemSchema)) {
                throw new IllegalArgumentException("Array schema requires an items schema object");
            }
            result.put("items", normalizeSchemaNode(itemSchema, false, depth + 1));
        } else if ("string".equals(type)) {
            copyNonNegativeInt(node, result, "minLength");
            copyNonNegativeInt(node, result, "maxLength");
            if (result.containsKey("minLength") && result.containsKey("maxLength")
                    && ((Integer) result.get("minLength")) > ((Integer) result.get("maxLength"))) {
                throw new IllegalArgumentException("Schema minLength exceeds maxLength");
            }
            Object rawEnum = node.get("enum");
            if (rawEnum != null) {
                if (!(rawEnum instanceof List<?> enumList) || enumList.isEmpty() || enumList.size() > 64) {
                    throw new IllegalArgumentException("String enum must be a non-empty list of up to 64 values");
                }
                List<String> values = new ArrayList<>(enumList.size());
                for (Object item : enumList) {
                    if (!(item instanceof String text) || hasDisallowedControl(text, true)) {
                        throw new IllegalArgumentException("String enum entries must be valid strings");
                    }
                    values.add(text);
                }
                result.put("enum", Collections.unmodifiableList(values));
            }
        }
        for (Object key : node.keySet()) {
            if (!(key instanceof String keyName) || !Set.of("type", "description", "properties",
                    "required", "additionalProperties", "items", "minLength", "maxLength", "enum").contains(keyName)) {
                throw new IllegalArgumentException("Unsupported JSON Schema keyword: " + key);
            }
        }
        return Collections.unmodifiableMap(result);
    }

    private static void copyNonNegativeInt(Map<?, ?> source, Map<String, Object> target, String key) {
        Object raw = source.get(key);
        if (raw == null) {
            return;
        }
        if (!(raw instanceof Number num) || num.doubleValue() != Math.rint(num.doubleValue())
                || num.longValue() < 0 || num.longValue() > 1_048_576L) {
            throw new IllegalArgumentException("Invalid integer bound for " + key);
        }
        target.put(key, num.intValue());
    }

    private static Object validateValue(Map<String, Object> schema, Object value, String path, int depth) {
        if (depth > 16) {
            throw new IllegalArgumentException("Argument nesting depth exceeded at " + path);
        }
        if (value == null) {
            throw new IllegalArgumentException("Null value is not allowed at " + path);
        }
        String type = (String) schema.get("type");
        switch (type) {
            case "string" -> {
                if (!(value instanceof String text) || hasDisallowedControl(text, true)) {
                    throw new IllegalArgumentException(path + " must be a valid string");
                }
                Integer min = (Integer) schema.get("minLength");
                Integer max = (Integer) schema.get("maxLength");
                if (min != null && text.length() < min) {
                    throw new IllegalArgumentException(path + " must be at least " + min + " characters");
                }
                if (max != null && text.length() > max) {
                    throw new IllegalArgumentException(path + " must be at most " + max + " characters");
                }
                @SuppressWarnings("unchecked")
                List<String> allowed = (List<String>) schema.get("enum");
                if (allowed != null && !allowed.contains(text)) {
                    throw new IllegalArgumentException(path + " must be one of " + allowed);
                }
                return text;
            }
            case "boolean" -> {
                if (!(value instanceof Boolean bool)) {
                    throw new IllegalArgumentException(path + " must be a boolean");
                }
                return bool;
            }
            case "integer" -> {
                if (!(value instanceof Number num) || Double.isNaN(num.doubleValue())
                        || Double.isInfinite(num.doubleValue())
                        || num.doubleValue() != Math.rint(num.doubleValue())
                        || Math.abs(num.doubleValue()) > 9_007_199_254_740_991D) {
                    throw new IllegalArgumentException(path + " must be a safe integer");
                }
                return num.longValue();
            }
            case "number" -> {
                if (!(value instanceof Number num) || Double.isNaN(num.doubleValue())
                        || Double.isInfinite(num.doubleValue())) {
                    throw new IllegalArgumentException(path + " must be a finite number");
                }
                return num;
            }
            case "array" -> {
                if (!(value instanceof List<?> list)) {
                    throw new IllegalArgumentException(path + " must be an array");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> itemSchema = (Map<String, Object>) schema.get("items");
                List<Object> copy = new ArrayList<>(list.size());
                for (int i = 0; i < list.size(); i++) {
                    copy.add(validateValue(itemSchema, list.get(i), path + "[" + i + "]", depth + 1));
                }
                return Collections.unmodifiableList(copy);
            }
            case "object" -> {
                if (!(value instanceof Map<?, ?> map)) {
                    throw new IllegalArgumentException(path + " must be an object");
                }
                @SuppressWarnings("unchecked")
                Map<String, Map<String, Object>> props = (Map<String, Map<String, Object>>) schema.get("properties");
                @SuppressWarnings("unchecked")
                List<String> required = (List<String>) schema.getOrDefault("required", List.of());
                boolean allowAdditional = Boolean.TRUE.equals(schema.get("additionalProperties"));
                for (String req : required) {
                    if (!map.containsKey(req) || map.get(req) == null) {
                        throw new IllegalArgumentException("Missing required property " + path + "." + req);
                    }
                }
                Map<String, Object> copy = new LinkedHashMap<>();
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String key)) {
                        throw new IllegalArgumentException(path + " contains a non-string key");
                    }
                    Map<String, Object> propSchema = props.get(key);
                    if (propSchema == null) {
                        if (!allowAdditional) {
                            throw new IllegalArgumentException("Unsupported property " + path + "." + key);
                        }
                        copy.put(key, copyUntyped(entry.getValue(), path + "." + key, depth + 1));
                    } else {
                        copy.put(key, validateValue(propSchema, entry.getValue(), path + "." + key, depth + 1));
                    }
                }
                return Collections.unmodifiableMap(copy);
            }
            default -> throw new IllegalArgumentException("Unsupported schema type " + type);
        }
    }

    private static Object copyUntyped(Object value, String path, int depth) {
        if (depth > 16) {
            throw new IllegalArgumentException("Argument nesting depth exceeded at " + path);
        }
        if (value == null || value instanceof Boolean) {
            return value;
        }
        if (value instanceof String text) {
            if (hasDisallowedControl(text, true)) {
                throw new IllegalArgumentException("Invalid string at " + path);
            }
            return text;
        }
        if (value instanceof Number num) {
            if (Double.isNaN(num.doubleValue()) || Double.isInfinite(num.doubleValue())) {
                throw new IllegalArgumentException("Non-finite number at " + path);
            }
            return num;
        }
        if (value instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            for (int i = 0; i < list.size(); i++) {
                copy.add(copyUntyped(list.get(i), path + "[" + i + "]", depth + 1));
            }
            return Collections.unmodifiableList(copy);
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new IllegalArgumentException("Non-string key at " + path);
                }
                copy.put(key, copyUntyped(entry.getValue(), path + "." + key, depth + 1));
            }
            return Collections.unmodifiableMap(copy);
        }
        throw new IllegalArgumentException("Unsupported JSON value at " + path);
    }

    private static int estimateJsonBytes(Object value) {
        if (value == null) {
            return 4;
        }
        if (value instanceof String text) {
            return text.getBytes(StandardCharsets.UTF_8).length + 2;
        }
        if (value instanceof Boolean || value instanceof Number) {
            return value.toString().length();
        }
        if (value instanceof List<?> list) {
            int sum = 2;
            for (Object item : list) {
                sum += estimateJsonBytes(item) + 1;
            }
            return sum;
        }
        if (value instanceof Map<?, ?> map) {
            int sum = 2;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                sum += estimateJsonBytes(String.valueOf(entry.getKey()))
                        + estimateJsonBytes(entry.getValue()) + 2;
            }
            return sum;
        }
        return 16;
    }
}
