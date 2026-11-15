package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Managed /loop skill variant injected at creation admission. The
 * description and body are read from a committed JSON sidecar generated from the
 * bundled local SKILL.md (packages/core/src/skills/bundled/loop/
 * managed-loop-skill.ts); a TypeScript parity test pins each sidecar to the
 * bundled source. This class is a pure selector: it maps the Session's tool
 * profile to the sidecar whose body names only the creators that profile
 * declares, and does no string composition.
 *
 * <p>See docs/design/2026-11-14-managed-loop-skill-asset.md. The deployment
 * gates are operation gates that leave the tool declaration in place, so the
 * variant is selected by profile alone, not by gate state.
 */
final class ManagedLoopSkill {
    static final String NAME = "loop";
    private static final ObjectMapper JSON = new ObjectMapper();

    private ManagedLoopSkill() {
    }

    /**
     * The loop skill for a profile, or null when the profile declares no loop
     * creator (cron_create or loop_wakeup) and so must not receive the skill.
     */
    static Map<String, Object> forProfile(String profile) {
        String asset;
        if (WorkspaceToolProfiles.SHELL_V4.equals(profile)) {
            asset = "managed-loop-skill-union.json";
        } else if (WorkspaceToolProfiles.FILES_V4.equals(profile)
                || WorkspaceToolProfiles.INTERNAL_TEAM_LEAD_V2.equals(profile)) {
            asset = "managed-loop-skill-cron.json";
        } else if (WorkspaceToolProfiles.SHELL_V3.equals(profile)) {
            asset = "managed-loop-skill-wakeup.json";
        } else {
            return null;
        }
        Map<String, Object> sidecar = readSidecar(asset);
        Map<String, Object> skill = new LinkedHashMap<>();
        skill.put("name", NAME);
        skill.put("description", sidecar.get("description"));
        skill.put("body", sidecar.get("body"));
        return skill;
    }

    /**
     * Append the caller skills and the profile's loop variant to the admission
     * catalog, returning whether the variant was injected. {@code merged} already
     * holds the pinned definition's skills; the caller skills are appended after
     * them. The variant is a server contribution added even when the caller
     * supplies no skills. It replaces a caller-imported "loop" skill (the Web
     * Shell imports the bundled one verbatim from the daemon snapshot), not
     * refuses it, so the default creation path is not broken by a duplicate name.
     * A definition-authored "loop" is the definition author's artifact and is
     * preserved: the server neither replaces it nor injects a rival entry. On a
     * profile with no loop creator the caller's "loop" entry is still dropped, so
     * a creator-less Session never publishes a body naming tools it lacks. The
     * injection is gated on the negotiated Session Skills capability and on the
     * catalog capacity: if the variant cannot fit within the published 256-entry
     * / 2 MiB limits it is skipped rather than refusing the creation. Kept here
     * so the admission class does not grow.
     */
    static boolean mergeInto(List<Map<String, Object>> merged,
            List<Map<String, Object>> callerSkills, String profile,
            boolean sessionSkillsSupported) {
        int definitionCount = merged.size();
        merged.addAll(callerSkills);
        if (!sessionSkillsSupported) {
            return false;
        }
        boolean definitionHasLoop = merged.subList(0, definitionCount).stream()
                .anyMatch(skill -> NAME.equals(skill.get("name")));
        // Only the caller segment's "loop" is the server's to replace.
        merged.subList(definitionCount, merged.size())
                .removeIf(skill -> NAME.equals(skill.get("name")));
        if (definitionHasLoop) {
            return false;
        }
        Map<String, Object> loop = forProfile(profile);
        if (loop == null) {
            return false;
        }
        List<Map<String, Object>> candidate = new ArrayList<>(merged);
        candidate.add(loop);
        try {
            AgentDefinitionExtensions.sessionSkills(candidate);
        } catch (ManagedAgentException overCapacity) {
            return false;
        }
        merged.add(loop);
        return true;
    }

    /**
     * Re-select the loop entry for a child whose tool profile differs from the
     * parent's (a snapshot child is read-only). The inherited server variant is
     * dropped and replaced by the child profile's own variant, or by nothing
     * when the child declares no loop creator, so a read-only child never
     * publishes a body naming tools it lacks. Caller/definition skills inherit
     * unchanged.
     */
    static List<Map<String, Object>> reselectForProfile(
            List<Map<String, Object>> inherited, String childProfile) {
        List<Map<String, Object>> result = new ArrayList<>(inherited);
        result.removeIf(skill -> NAME.equals(skill.get("name")));
        Map<String, Object> loop = forProfile(childProfile);
        if (loop != null) {
            result.add(loop);
        }
        return result;
    }

    /**
     * The catalog to save for a child, or null when there is nothing to save. A
     * null inherited catalog saves nothing; a null child profile inherits the
     * parent catalog unchanged; otherwise the loop entry is re-selected by the
     * child's profile. An empty result (a read-only child whose inherited catalog
     * was only the injected loop) saves nothing rather than an empty row, which
     * every later snapshot read would reject with a conflict.
     */
    static List<Map<String, Object>> childCatalog(
            List<Map<String, Object>> inherited, String childProfile) {
        if (inherited == null) {
            return null;
        }
        if (childProfile == null) {
            return inherited;
        }
        List<Map<String, Object>> result = reselectForProfile(inherited, childProfile);
        return result.isEmpty() ? null : result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readSidecar(String asset) {
        try (InputStream stream =
                ManagedLoopSkill.class.getResourceAsStream("/contracts/" + asset)) {
            if (stream == null) {
                throw new IllegalStateException("Missing managed loop skill asset: " + asset);
            }
            return JSON.readValue(new String(stream.readAllBytes(), StandardCharsets.UTF_8), Map.class);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot read managed loop skill asset: " + asset, error);
        }
    }
}
