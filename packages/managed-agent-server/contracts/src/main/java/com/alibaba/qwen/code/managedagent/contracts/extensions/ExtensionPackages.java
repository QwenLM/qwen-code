package com.alibaba.qwen.code.managedagent.contracts.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Package;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

public interface ExtensionPackages {
    public interface Selection {
        default List<ManagedExtensionPackages.StandaloneSkill> standaloneSkills() { return List.of(); }
    }
    default boolean hasSkillCatalog() { return false; }
    /** Whether a default Skill import can succeed for this actor and Workspace. */
    default boolean defaultImportsSupported(String tenant, String actor, String workspace) { return false; }
    default List<Pin> defaultSkillPins(String tenant, String actor, String workspace, String requestId) { return List.of(); }
    public Selection authorizeSelection(String tenant, String actor, String workspace, List<Pin> pins);
    public void requireSelection(String tenant, String actor, String workspace, List<Pin> pins);
    public void requireSelection(String tenant, String actor, String workspace, List<Pin> pins, Selection selection);
    public ResolvedPackage resolvePin(String tenant, String workspace, Pin pin) throws IOException;
    public record ResolvedPackage(Package descriptor, ExtensionArchives.Archive archiveLease, Map<String, String> settings)
            implements AutoCloseable {
        public Path archive() { return archiveLease.path(); }
        @Override public void close() { archiveLease.close(); }
        @Override
        public String toString() {
            return "ResolvedPackage[descriptor=" + descriptor + ", settings=redacted]";
        }
    }
}
