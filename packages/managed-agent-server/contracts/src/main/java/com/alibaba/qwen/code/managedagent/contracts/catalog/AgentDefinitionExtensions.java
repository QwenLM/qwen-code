package com.alibaba.qwen.code.managedagent.contracts.catalog;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.StandaloneSkill;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

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
    private static final Set<String> SKILL_FIELDS = Set.of("name", "description", "body", "base_directory", "model_invocable", "user_invocable");

    /**
     * The widest revision an older build stored before admission bounded pins,
     * and still the largest value JavaScript holds exactly. A stored read
     * accepts it; nothing above it, since no producer could have written one.
     */
    private static final long MAX_STORED_REVISION = 9_007_199_254_740_991L;

    private AgentDefinitionExtensions() {
    }

    public static List<Map<String, Object>> skills(Object value, boolean workspaceBound) {
        return skills(value, workspaceBound, false);
    }

    public static List<Map<String, Object>> sessionSkills(Object value) {
        return skills(value, true, true);
    }

    private static List<Map<String, Object>> skills(Object value, boolean workspaceBound, boolean sessionCatalog) {
        List<?> entries = list(value, "skills");
        if (entries.size() > (sessionCatalog ? 256 : 16) || !entries.isEmpty() && !workspaceBound) {
            throw unsupported("skills");
        }
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> names = new HashSet<>();
        for (Object entry : entries) {
            if (!(entry instanceof Map<?, ?> skill)
                    || !SKILL_FIELDS.containsAll(skill.keySet())
                    || !validSkillMetadata(skill.get("name"), skill.get("description"))
                    || !text(skill.get("body"), sessionCatalog ? 512 * 1024 : 32768)
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
            for (String field : List.of("model_invocable", "user_invocable")) {
                if (skill.containsKey(field)) {
                    if (!sessionCatalog || !(skill.get(field) instanceof Boolean)) {
                        throw unsupported("skills");
                    }
                    supported.put(field, skill.get(field));
                }
            }
            result.add(Collections.unmodifiableMap(supported));
        }
        if (skillsBytes(result).length > (sessionCatalog ? ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES : 48 * 1024)) {
            throw unsupported("skills");
        }
        return List.copyOf(result);
    }

    public static List<Map<String, Object>> sessionSkills(Object value, List<StandaloneSkill> packages) {
        var base = sessionSkills(value);
        if (packages.isEmpty()) {
            return base;
        }
        long bytes;
        try {
            // JSON.stringify emits supplementary characters as UTF-8, unlike Jackson's byte generator.
            bytes = JSON.writeValueAsString(base).getBytes(StandardCharsets.UTF_8).length;
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Invalid admitted skills", error);
        }
        var names = new HashSet<String>();
        base.forEach(skill -> names.add((String) skill.get("name")));
        for (StandaloneSkill skill : packages) {
            bytes += (names.isEmpty() ? 0L : 1L) + skill.catalogEntryBytes();
            if (!names.add(skill.name()) || names.size() > 256 || bytes > ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES) {
                throw new ManagedAgentException(409, "extension_skill_unavailable", "The combined Session Skill catalog has conflicting names or exceeds its limit.");
            }
        }
        return base;
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
        return mcpServers(value, profile, false);
    }

    /**
     * {@code stored} reads a definition this deployment already pinned. The
     * ceiling is an admission bound: a definition written before this
     * validator bounded pins still has to load, and a Session that cannot
     * load cannot be deleted because attach is the delete precondition.
     */
    public static List<Map<String, Object>> mcpServers(Object value, String profile, boolean stored) {
        List<?> entries = list(value, "mcp_servers");
        if (entries.size() > 16 || entries.isEmpty() && WorkspaceToolProfiles.MCP.equals(profile)
                || !entries.isEmpty() && !WorkspaceToolProfiles.MCP.equals(profile)
                        && !WorkspaceToolProfiles.isPublicShell(profile)) {
            throw unsupported("mcp_servers");
        }
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (Object entry : entries) {
            Map<String, Object> pin = pin(entry, "server", "mcp_servers", stored);
            if (!ids.add((String) pin.get("serverId"))) {
                throw unsupported("mcp_servers");
            }
            result.add(pin);
        }
        return List.copyOf(result);
    }

    public static Map<String, Object> hookCatalog(Object value, boolean workspaceBound) {
        return hookCatalog(value, workspaceBound, false);
    }

    public static Map<String, Object> hookCatalog(Object value, boolean workspaceBound, boolean stored) {
        if (value == null) {
            return null;
        }
        if (!workspaceBound) {
            throw unsupported("hook_catalog");
        }
        return pin(value, "catalog", "hook_catalog", stored);
    }

    private static Map<String, Object> pin(Object value, String prefix, String field, boolean stored) {
        if (!(value instanceof Map<?, ?> pin)
                || !pin.keySet().equals(Set.of(prefix + "_id", prefix + "_revision", "definition_digest"))
                || !(pin.get(prefix + "_id") instanceof String id) || !ID.matcher(id).matches()
                || !(pin.get(prefix + "_revision") instanceof Number revision)
                || !Double.isFinite(revision.doubleValue()) || revision.doubleValue() != revision.longValue()
                || revision.longValue() < 1
                || revision.longValue() > (stored ? MAX_STORED_REVISION : ManagedSessionStoreModels.MAX_SAFE_COUNTER)
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

    public static boolean validSkillMetadata(Object name, Object description) {
        return text(name, 128) && SKILL_NAME.matcher((String) name).matches() && text(description, 4096);
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

    private static ManagedAgentException unsupported(String field) {
        return new ManagedAgentException(409, "agent_definition_unsupported",
                "The agent definition field cannot take effect yet.", Map.of("field", field));
    }
}
