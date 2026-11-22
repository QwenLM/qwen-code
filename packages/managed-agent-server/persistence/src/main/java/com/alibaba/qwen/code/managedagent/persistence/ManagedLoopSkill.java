package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.StandaloneSkill;
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
 * description and body are read from committed JSON sidecars generated from the
 * bundled local SKILL.md (packages/core/src/skills/bundled/loop/
 * managed-loop-skill.ts); a TypeScript parity test pins each sidecar to the
 * bundled source. This class is a pure selector: it maps the Session's tool
 * profile to the sidecar whose body names only the creators that profile
 * declares, and does no string composition.
 *
 * <p>Provenance: the server only ever replaces the Web Shell's bundled {@code
 * loop} import (body equal to the committed bundled-body reference). A
 * user-authored or definition-authored {@code loop} is preserved and suppresses
 * the server variant. For a child, provenance comes from the parent's pinned
 * definition, not from body text, so it stays correct across sidecar
 * regeneration.
 *
 * <p>See docs/design/2026-11-14-managed-loop-skill-asset.md. The deployment
 * gates are operation gates that leave the tool declaration in place, so the
 * variant is selected by profile alone, not by gate state.
 */
final class ManagedLoopSkill {
    static final String NAME = "loop";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static volatile Map<String, Map<String, Object>> sidecarCache;

    private ManagedLoopSkill() {
    }

    /** The parsed sidecars are immutable classpath constants pinned by the
     * parity test; read them once, not per admission. */
    private static Map<String, Map<String, Object>> sidecars() {
        Map<String, Map<String, Object>> cache = sidecarCache;
        if (cache == null) {
            synchronized (ManagedLoopSkill.class) {
                cache = sidecarCache;
                if (cache == null) {
                    cache = Map.of(
                            "union", readSidecar("managed-loop-skill-union.json"),
                            "cron", readSidecar("managed-loop-skill-cron.json"),
                            "wakeup", readSidecar("managed-loop-skill-wakeup.json"),
                            "bundled", readSidecar("managed-loop-skill-bundled-body.json"));
                    sidecarCache = cache;
                }
            }
        }
        return cache;
    }

    /**
     * The loop skill for a profile, or null when the profile declares no loop
     * creator (cron_create or loop_wakeup) and so must not receive the skill.
     */
    static Map<String, Object> forProfile(String profile) {
        String key;
        if (WorkspaceToolProfiles.SHELL_V4.equals(profile)) {
            key = "union";
        } else if (WorkspaceToolProfiles.FILES_V4.equals(profile)
                || WorkspaceToolProfiles.INTERNAL_TEAM_LEAD_V2.equals(profile)) {
            key = "cron";
        } else if (WorkspaceToolProfiles.SHELL_V3.equals(profile)) {
            key = "wakeup";
        } else {
            return null;
        }
        Map<String, Object> sidecar = sidecars().get(key);
        Map<String, Object> skill = new LinkedHashMap<>();
        skill.put("name", NAME);
        skill.put("description", sidecar.get("description"));
        skill.put("body", sidecar.get("body"));
        return skill;
    }

    /** Whether a caller entry is the Web Shell's verbatim bundled import (the
     * only loop the server may replace), as opposed to a user-authored skill. */
    private static boolean isBundledLoop(Map<String, Object> skill) {
        return NAME.equals(skill.get("name"))
                && sidecars().get("bundled").get("body").equals(skill.get("body"));
    }

    /** Whether a loop body is one the server publishes (a profile variant or the
     * verbatim bundled import), as opposed to user- or definition-authored text.
     * Only a positively identified server loop may be dropped from a child; a
     * body that matches no sidecar is never assumed to be the server's. */
    private static boolean isServerLoopBody(Object body) {
        return body instanceof String text
                && sidecars().values().stream()
                        .anyMatch(sidecar -> text.equals(sidecar.get("body")));
    }

    /**
     * Append the caller skills and the profile's loop variant to the admission
     * catalog, returning the validated catalog when the variant was injected, or
     * null when it was not (so the caller validates {@code merged} itself). The
     * returned catalog is the single validated/serialized pass — the admission
     * reuses it instead of re-validating. {@code merged} already holds the pinned
     * definition's skills; the caller skills are appended after them. The variant
     * replaces only the Web Shell's bundled {@code loop} import, carrying over
     * that entry's model_invocable / user_invocable flags; a user-authored or
     * definition-authored {@code loop} is preserved and suppresses the variant
     * (names must stay unique). On a profile with no loop creator the bundled
     * caller import is dropped so a creator-less Session never publishes a body
     * naming tools it lacks. The injection is gated on the negotiated Session
     * Skills capability and on the catalog capacity: if the variant cannot fit
     * within the published 256-entry / 2 MiB limits it is skipped and the bundled
     * caller import stays dropped, so the creation succeeds within capacity
     * rather than being refused (a catalog already over capacity without the
     * variant is still refused by the admission validation). Kept here so the
     * admission class does not grow.
     */
    static List<Map<String, Object>> mergeInto(List<Map<String, Object>> merged,
            List<Map<String, Object>> callerSkills, String profile,
            boolean sessionSkillsSupported, List<StandaloneSkill> packageSkills) {
        int definitionCount = merged.size();
        if (WorkspaceToolProfiles.EXTERNAL_FILES.equals(profile)) {
            // External creationPin already carried the caller skills into the pin;
            // appending them again duplicates every name and the catalog validation
            // refuses the creation. The pin slice is the whole caller catalog here.
            definitionCount = 0;
        } else {
            merged.addAll(callerSkills);
        }
        if (!sessionSkillsSupported) {
            return null;
        }
        boolean definitionHasLoop = merged.subList(0, definitionCount).stream()
                .anyMatch(skill -> NAME.equals(skill.get("name")));
        List<Map<String, Object>> callerSlice = merged.subList(definitionCount, merged.size());
        // A user-authored caller loop is not the server's to replace: keep it and
        // inject no rival variant. Classify the whole caller loop set so a bundled
        // sibling cannot drag a user-authored loop into the delete below; caller
        // validation reports the duplicate rather than silently dropping user content.
        if (callerSlice.stream()
                .anyMatch(skill -> NAME.equals(skill.get("name")) && !isBundledLoop(skill))) {
            return null;
        }
        Map<String, Object> callerLoop = callerSlice.stream()
                .filter(ManagedLoopSkill::isBundledLoop).findFirst().orElse(null);
        // Only the bundled caller import is the server's to replace.
        callerSlice.removeIf(ManagedLoopSkill::isBundledLoop);
        if (definitionHasLoop) {
            return null;
        }
        Map<String, Object> loop = forProfile(profile);
        if (loop == null) {
            return null;
        }
        if (callerLoop != null) {
            for (String field : List.of("model_invocable", "user_invocable")) {
                if (callerLoop.containsKey(field)) {
                    loop.put(field, callerLoop.get(field));
                }
            }
        }
        List<Map<String, Object>> candidate = new ArrayList<>(merged);
        candidate.add(loop);
        List<Map<String, Object>> validated;
        try {
            validated = AgentDefinitionExtensions.sessionSkills(candidate, packageSkills);
        } catch (ManagedAgentException overCapacity) {
            // Skip the injection and leave the bundled import dropped: restoring
            // it would push the catalog back over capacity and the admission
            // validation would refuse the creation. The bundled import is the
            // server's to manage (a creator-less profile drops it too), so the
            // creation succeeds within capacity instead of losing every skill.
            return null;
        }
        merged.add(loop);
        return validated;
    }

    /**
     * The catalog to save for a child, or null when there is nothing to save. A
     * null inherited catalog saves nothing; a null child profile inherits the
     * parent catalog unchanged. The only non-null child profile is READ (a
     * snapshot child): the server-injected loop variant is dropped because it
     * names creators READ does not declare, while a definition-authored loop
     * (the parent's pinned definition owns a {@code loop}) inherits unchanged.
     * Provenance comes from the {@code serverLoopInjected} marker recorded in
     * the parent's snapshot when the variant was injected, not from body text,
     * so a variant written by an earlier build is still dropped after the
     * sidecars are regenerated. A current sidecar body is also recognized as a
     * fallback. A user-authored caller loop (no server injection, body matching
     * no sidecar) is the user's content and is never silently deleted. An empty
     * resolved catalog saves nothing rather than an empty row, which every later
     * snapshot read would reject.
     */
    static List<Map<String, Object>> childCatalog(
            List<Map<String, Object>> inherited, String childProfile,
            boolean definitionHasLoop, boolean serverLoopInjected) {
        if (inherited == null) {
            return null;
        }
        if (childProfile == null) {
            return inherited;
        }
        List<Map<String, Object>> result = new ArrayList<>(inherited);
        if (!definitionHasLoop) {
            result.removeIf(skill -> NAME.equals(skill.get("name"))
                    && (serverLoopInjected || isServerLoopBody(skill.get("body"))));
        }
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
