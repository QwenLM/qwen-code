package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedRuntimeSkills;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

@Service
public class ManagedRuntimeSkillImportService {
    private final ManagedExtensionPackageService packages;
    private final SessionPolicyStore sessions;
    private final HarnessConnector harness;
    private final ObjectMapper json;
    private final java.util.concurrent.Semaphore downloads = new java.util.concurrent.Semaphore(4);

    public ManagedRuntimeSkillImportService(ManagedExtensionPackageService packages, SessionPolicyStore sessions,
            HarnessConnector harness, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.packages = packages;
        this.sessions = sessions;
        this.harness = harness;
        this.json = json;
    }

    public JsonNode candidates(String tenant, String actor, String sessionId) {
        requireSession(tenant, actor, sessionId);
        return verified(tenant, actor, sessionId, runtimeCall(() -> harness.runtimeSkillCandidates(tenant, sessionId)), null);
    }

    public JsonNode snapshot(String tenant, String actor, String sessionId, ManagedRuntimeSkills.SnapshotRequest request) throws IOException {
        SessionRecord session = requireSession(tenant, actor, sessionId);
        if (request == null) {
            throw invalid();
        }
        requireOwner(request.owner());
        String metadata = metadata(request.target(), "a".repeat(64));
        packages.decodeImportMetadata(metadata);
        if (request.path() == null || request.digest() == null || !request.digest().matches("[a-f0-9]{64}")
                || !(request.path().startsWith(".qwen/skills/") || request.path().startsWith(".agents/skills/"))
                || request.path().contains("\\") || request.path().indexOf('\0') >= 0 || request.path().length() > 4096
                || java.util.Arrays.stream(request.path().split("/", -1)).anyMatch(segment -> segment.isEmpty() || segment.equals(".") || segment.equals(".."))) {
            throw invalid();
        }
        String operationId = UUID.randomUUID().toString();
        JsonNode descriptor = verified(tenant, actor, sessionId, runtimeCall(() -> harness.runtimeSkillSnapshot(tenant, sessionId,
                Map.of("operationId", operationId, "owner", ownerMap(request.owner()), "path", request.path(), "digest", request.digest()))), request.owner());
        if (!operationId.equals(descriptor.path("operationId").asText())) {
            throw changed();
        }
        var input = new ManagedRuntimeSkills.ImportRequest(request.owner(), operationId,
                descriptor.path("preparationId").asText(), descriptor.path("sourceDigest").asText(),
                descriptor.path("byteLength").asLong(-1), request.target(), null);
        validateImport(input);
        Path archive = download(tenant, actor, sessionId, input);
        try (var source = Files.newInputStream(archive)) {
            JsonNode inspection = packages.preview(tenant, actor, session.workspace().getWorkspaceId(),
                    metadata(request.target(), input.sourceDigest()), source, input.byteLength());
            ObjectNode result = (ObjectNode) descriptor.deepCopy();
            result.put("operationId", operationId);
            result.set("target", json.valueToTree(request.target()));
            result.set("inspection", inspection);
            return result;
        } finally {
            try {
                Files.deleteIfExists(archive);
            } finally {
                downloads.release();
            }
        }
    }

    public ManagedExtensionPackages.Operation importSnapshot(String tenant, String actor, String sessionId,
            String key, ManagedRuntimeSkills.ImportRequest request) throws IOException {
        SessionRecord session = requireSession(tenant, actor, sessionId);
        com.alibaba.qwen.code.managedagent.session.ManagedAgentService.validateIdempotencyKey(key);
        validateImport(request);
        try {
            var existing = packages.lookup(tenant, actor, session.workspace().getWorkspaceId(), "publish", key);
            if ("settled".equals(existing.state())) {
                var saved = packages.get(tenant, actor, session.workspace().getWorkspaceId(), existing.extensionId(), existing.revision(), existing.packageDigest());
                if (!request.sourceDigest().equals(saved.manifest().sourceRevision()) || !request.target().equals(saved.manifest().target())
                        || request.extensionId() != null && !request.extensionId().equals(existing.extensionId())) {
                    throw new ManagedAgentException(409, "idempotency_conflict", "The import key names another snapshot.");
                }
                return existing;
            }
        } catch (ManagedAgentException error) {
            if (error.getStatus() != 404) {
                throw error;
            }
        }
        Path archive = download(tenant, actor, sessionId, request);
        try (var source = Files.newInputStream(archive)) {
            return packages.importPackage(tenant, actor, session.workspace().getWorkspaceId(), request.extensionId(), key,
                    metadata(request.target(), request.sourceDigest()), source, request.byteLength());
        } finally {
            try {
                Files.deleteIfExists(archive);
            } finally {
                downloads.release();
            }
        }
    }

    private SessionRecord requireSession(String tenant, String actor, String sessionId) {
        SessionRecord session = sessions.requireExtensionManagement(tenant, actor, sessionId, null, true);
        if (session.workspace() == null || !Set.of("hosted-workspace-shell/1", "hosted-workspace-shell/3", "hosted-workspace-mcp/1").contains(session.toolProfile())
                || !packages.runtimeSkillImportEnabled() || !harness.supportsRuntimeSkillImport()) {
            throw new ManagedAgentException(409, "unsupported_feature", "Runtime Skill import is unavailable.");
        }
        packages.requireExecutionAccess(tenant, actor, session.workspace().getWorkspaceId());
        return session;
    }

    private JsonNode verified(String tenant, String actor, String sessionId, Map<String, Object> value, ManagedRuntimeSkills.Owner expected) {
        requireSession(tenant, actor, sessionId);
        JsonNode result = json.valueToTree(value);
        if (!sessionId.equals(result.path("sessionId").asText())) {
            throw changed();
        }
        var owner = json.convertValue(result.path("owner"), ManagedRuntimeSkills.Owner.class);
        requireOwner(owner);
        if (expected != null && !expected.equals(owner)) {
            throw changed();
        }
        return result;
    }

    private Path download(String tenant, String actor, String sessionId, ManagedRuntimeSkills.ImportRequest request) throws IOException {
        if (!downloads.tryAcquire()) {
            throw new ManagedAgentException(503, "runtime_skill_import_busy", "Runtime Skill import is busy; try again.");
        }
        Path file;
        try {
            file = Files.createTempFile("qwen-runtime-skill-", ".tar.gz");
        } catch (IOException error) {
            downloads.release();
            throw error;
        }
        boolean complete = false;
        try {
            download(tenant, actor, sessionId, request, file);
            complete = true;
            return file;
        } finally {
            if (!complete) {
                try {
                    Files.deleteIfExists(file);
                } finally {
                    downloads.release();
                }
            }
        }
    }

    private void download(String tenant, String actor, String sessionId, ManagedRuntimeSkills.ImportRequest request, Path file) throws IOException {
        try (var output = Files.newOutputStream(file)) {
            var digest = DigestUtils.getSha256Digest();
            long offset = 0;
            long deadline = System.nanoTime() + java.time.Duration.ofMinutes(10).toNanos();
            while (offset < request.byteLength()) {
                if (System.nanoTime() > deadline || Thread.currentThread().isInterrupted()) {
                    throw new IOException("Runtime Skill download expired");
                }
                long chunkOffset = offset;
                JsonNode chunk = verified(tenant, actor, sessionId, runtimeCall(() -> harness.runtimeSkillArchive(tenant, sessionId,
                        Map.of("operationId", request.operationId(), "preparationId", request.preparationId(),
                                "owner", ownerMap(request.owner()), "offset", chunkOffset))), request.owner());
                if (!request.preparationId().equals(chunk.path("preparationId").asText())
                        || chunk.path("offset").asLong(-1) != offset || chunk.path("totalBytes").asLong(-1) != request.byteLength()
                        || !chunk.path("base64").isTextual() || chunk.path("base64").asText().length() > 349528) {
                    throw changed();
                }
                byte[] bytes;
                try {
                    bytes = Base64.getDecoder().decode(chunk.get("base64").asText());
                } catch (IllegalArgumentException error) {
                    throw changed();
                }
                if (bytes.length < 1 || bytes.length > 256 * 1024 || offset + bytes.length > request.byteLength()) {
                    throw changed();
                }
                digest.update(bytes);
                output.write(bytes);
                offset += bytes.length;
            }
            if (!request.sourceDigest().equals(org.apache.commons.codec.binary.Hex.encodeHexString(digest.digest()))) {
                throw changed();
            }
        }
    }

    private <T> T runtimeCall(Supplier<T> call) {
        try {
            return call.get();
        } catch (HarnessHttpFailure error) {
            int status = error.getStatusCode();
            String code = error.getErrorCode();
            if (status >= 400 && status < 500 && code != null && code.matches("[a-z][a-z0-9_]{0,127}")) {
                throw new ManagedAgentException(status, code, "Runtime Skill import was refused.");
            }
            throw unavailable();
        } catch (HarnessFailure error) {
            throw unavailable();
        }
    }

    private void validateImport(ManagedRuntimeSkills.ImportRequest input) {
        if (input == null) {
            throw invalid();
        }
        requireOwner(input.owner());
        try {
            if (!UUID.fromString(input.operationId()).toString().equals(input.operationId())
                    || !UUID.fromString(input.preparationId()).toString().equals(input.preparationId())) {
                throw invalid();
            }
        } catch (IllegalArgumentException | NullPointerException error) {
            throw invalid();
        }
        if (input.sourceDigest() == null || !input.sourceDigest().matches("[a-f0-9]{64}")
                || input.byteLength() < 1 || input.byteLength() > ManagedExtensionPackages.MAX_ARCHIVE_BYTES) {
            throw invalid();
        }
        packages.decodeImportMetadata(metadata(input.target(), input.sourceDigest()));
    }

    private String metadata(ManagedExtensionPackages.Target target, String digest) {
        try {
            return json.writeValueAsString(new ManagedExtensionPackages.ImportMetadata("skill", target, digest, 1, null));
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void requireOwner(ManagedRuntimeSkills.Owner owner) {
        if (owner == null || owner.bindingId() == null || !owner.bindingId().matches("[A-Za-z0-9._:-]{1,128}")
                || owner.generation() == null || !owner.generation().matches("[1-9][0-9]{0,15}")
                || Long.parseLong(owner.generation()) > 9_007_199_254_740_991L) {
            throw invalid();
        }
    }

    private static Map<String, Object> ownerMap(ManagedRuntimeSkills.Owner owner) {
        return Map.of("bindingId", owner.bindingId(), "generation", owner.generation());
    }

    private static ManagedAgentException invalid() { return new ManagedAgentException(400, "invalid_request", "Invalid Runtime Skill import."); }
    private static ManagedAgentException changed() { return new ManagedAgentException(409, "source_changed", "The Runtime Skill source or owner changed."); }
    private static ManagedAgentException unavailable() { return new ManagedAgentException(503, "runtime_skill_import_unavailable", "Runtime Skill import is unavailable."); }
}
