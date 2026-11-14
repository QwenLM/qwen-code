package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Managed /loop skill variant injected at creation admission. The body is
 * one of three committed assets generated from the bundled local SKILL.md
 * (packages/core/src/skills/bundled/loop/managed-loop-skill.ts); a TypeScript
 * parity test pins each asset to the bundled source. This class is a pure
 * selector: it maps the Session's tool profile to the asset whose body names
 * only the creators that profile declares, and does no string composition.
 *
 * <p>See docs/design/2026-11-14-managed-loop-skill-asset.md. The deployment
 * gates are operation gates that leave the tool declaration in place, so the
 * variant is selected by profile alone, not by gate state.
 */
final class ManagedLoopSkill {
    static final String NAME = "loop";

    private ManagedLoopSkill() {
    }

    /**
     * The loop skill for a profile, or null when the profile declares no loop
     * creator (cron_create or loop_wakeup) and so must not receive the skill.
     */
    static Map<String, Object> forProfile(String profile) {
        String asset;
        String description;
        if (WorkspaceToolProfiles.SHELL_V4.equals(profile)) {
            asset = "managed-loop-skill-union.md";
            description = "Create a loop that runs a prompt now and follows up on a fixed "
                    + "schedule or through self-paced wakeups. Usage - /loop 5m check the "
                    + "build, /loop check the PR every 30m, /loop check the deploy. /loop "
                    + "list to show jobs, /loop clear to cancel all.";
        } else if (WorkspaceToolProfiles.FILES_V4.equals(profile)
                || WorkspaceToolProfiles.INTERNAL_TEAM_LEAD_V2.equals(profile)) {
            asset = "managed-loop-skill-cron.md";
            description = "Create a loop that runs a prompt now and follows up on a fixed "
                    + "schedule. Usage - /loop 5m check the build, /loop check the PR every "
                    + "30m. /loop list to show jobs, /loop clear to cancel all.";
        } else if (WorkspaceToolProfiles.SHELL_V3.equals(profile)) {
            asset = "managed-loop-skill-wakeup.md";
            description = "Create a loop that runs a prompt now and follows up through "
                    + "self-paced wakeups. Usage - /loop check the deploy. /loop list to "
                    + "show jobs, /loop clear to cancel all.";
        } else {
            return null;
        }
        Map<String, Object> skill = new LinkedHashMap<>();
        skill.put("name", NAME);
        skill.put("description", description);
        skill.put("body", readBody(asset));
        return skill;
    }

    /**
     * Append the caller skills and the profile's loop variant to the admission
     * catalog, returning whether the variant was injected. The variant is a
     * server contribution added even when the caller supplies no skills (the
     * built-in qwen-code case). It is authoritative: a caller-imported "loop"
     * skill (the Web Shell imports the bundled one verbatim from the daemon
     * snapshot) is replaced, not refused, so the default creation path is not
     * broken by a duplicate name. The injection is gated on the negotiated
     * Session Skills capability so a Harness without it keeps the creation-time
     * refusal rather than failing later at dispatch. Kept here so the admission
     * class does not grow.
     */
    static boolean mergeInto(List<Map<String, Object>> merged,
            List<Map<String, Object>> callerSkills, String profile,
            boolean sessionSkillsSupported) {
        merged.addAll(callerSkills);
        if (!sessionSkillsSupported) {
            return false;
        }
        Map<String, Object> loop = forProfile(profile);
        if (loop == null) {
            return false;
        }
        merged.removeIf(skill -> NAME.equals(skill.get("name")));
        merged.add(loop);
        return true;
    }

    private static String readBody(String asset) {
        try (InputStream stream =
                ManagedLoopSkill.class.getResourceAsStream("/contracts/" + asset)) {
            if (stream == null) {
                throw new IllegalStateException("Missing managed loop skill asset: " + asset);
            }
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot read managed loop skill asset: " + asset, error);
        }
    }
}
