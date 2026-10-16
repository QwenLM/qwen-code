package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** The supported public extension shapes and their private Hosted pins. */
public final class AgentDefinitionExtensions {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern SKILL_NAME = Pattern.compile("^[\\p{L}\\p{N}_:.-]+$");
    private static final Pattern BLANK = Pattern.compile("^[\\s\\p{Zs}\\u2028\\u2029\\uFEFF]*$");
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");
    private static final Pattern DIGEST = Pattern.compile("^[0-9a-f]{64}$");
    private static final Set<String> SKILL_FIELDS = Set.of("name", "description", "body", "base_directory");

    private AgentDefinitionExtensions() {
    }

    public static List<Map<String, Object>> skills(Object value, boolean workspaceBound) {
        List<?> entries = list(value, "skills");
        if (entries.size() > 16 || !entries.isEmpty() && !workspaceBound) {
            throw unsupported("skills");
        }
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> names = new HashSet<>();
        for (Object entry : entries) {
            if (!(entry instanceof Map<?, ?> skill)
                    || !SKILL_FIELDS.containsAll(skill.keySet())
                    || !text(skill.get("name"), 128)
                    || !SKILL_NAME.matcher((String) skill.get("name")).matches()
                    || !text(skill.get("description"), 4096)
                    || !text(skill.get("body"), 32768)
                    || !names.add((String) skill.get("name"))) {
                throw unsupported("skills");
            }
            Map<String, Object> supported = new LinkedHashMap<>();
            supported.put("name", skill.get("name"));
            supported.put("description", skill.get("description"));
            supported.put("body", skill.get("body"));
            if (skill.containsKey("base_directory")) {
                Object directory = skill.get("base_directory");
                if (!relativeDirectory(directory)) {
                    throw unsupported("skills");
                }
                supported.put("base_directory", directory);
            }
            result.add(Collections.unmodifiableMap(supported));
        }
        skillsBytes(result);
        return List.copyOf(result);
    }

    public static byte[] skillsBytes(List<Map<String, Object>> skills) {
        byte[] bytes;
        try {
            bytes = JSON.writeValueAsBytes(skills);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Invalid admitted skills", error);
        }
        if (bytes.length > ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES) {
            throw unsupported("skills");
        }
        return bytes;
    }

    public static List<Map<String, Object>> mcpServers(Object value, String profile) {
        List<?> entries = list(value, "mcp_servers");
        if (entries.size() > 16 || entries.isEmpty() == WorkspaceToolProfiles.MCP.equals(profile)) {
            throw unsupported("mcp_servers");
        }
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (Object entry : entries) {
            Map<String, Object> pin = pin(entry, "server", "mcp_servers");
            if (!ids.add((String) pin.get("serverId"))) {
                throw unsupported("mcp_servers");
            }
            result.add(pin);
        }
        return List.copyOf(result);
    }

    public static Map<String, Object> hookCatalog(Object value, boolean workspaceBound) {
        if (value == null) {
            return null;
        }
        if (!workspaceBound) {
            throw unsupported("hook_catalog");
        }
        return pin(value, "catalog", "hook_catalog");
    }

    private static Map<String, Object> pin(Object value, String prefix, String field) {
        if (!(value instanceof Map<?, ?> pin)
                || !pin.keySet().equals(Set.of(prefix + "_id", prefix + "_revision", "definition_digest"))
                || !(pin.get(prefix + "_id") instanceof String id) || !ID.matcher(id).matches()
                || !(pin.get(prefix + "_revision") instanceof Number revision)
                || !Double.isFinite(revision.doubleValue()) || revision.doubleValue() != revision.longValue()
                || revision.longValue() < 1 || revision.longValue() > 9007199254740991L
                || !(pin.get("definition_digest") instanceof String digest) || !DIGEST.matcher(digest).matches()) {
            throw unsupported(field);
        }
        return Map.of(prefix + "Id", id, prefix + "Revision", revision.longValue(), "definitionDigest", digest);
    }

    private static List<?> list(Object value, String field) {
        if (value == null) {
            return List.of();
        }
        if (!(value instanceof List<?> entries)) {
            throw unsupported(field);
        }
        return entries;
    }

    private static boolean text(Object value, int maxBytes) {
        return value instanceof String text && !BLANK.matcher(text).matches()
                && StandardCharsets.UTF_8.newEncoder().canEncode(text)
                && text.getBytes(StandardCharsets.UTF_8).length <= maxBytes;
    }

    private static boolean relativeDirectory(Object value) {
        if (!text(value, 4096)) {
            return false;
        }
        String directory = (String) value;
        if (".".equals(directory)) {
            return true;
        }
        if (directory.indexOf('\\') >= 0 || directory.indexOf(':') >= 0
                || directory.codePoints().anyMatch(Character::isISOControl)) {
            return false;
        }
        for (String part : directory.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                return false;
            }
        }
        return true;
    }

    private static ApiException unsupported(String field) {
        return new ApiException(HttpStatus.CONFLICT, "agent_definition_unsupported",
                "The agent definition field cannot take effect yet.", Map.of("field", field));
    }
}
