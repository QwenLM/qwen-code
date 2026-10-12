package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.ArtifactAccess;
import com.alibaba.qwen.code.managedagent.api.ApiModels.ArtifactResponse;
import com.alibaba.qwen.code.managedagent.api.ApiModels.ToolResultResponse;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.TenantContext;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore.Artifact;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.ArrayList;
import java.util.List;
import java.util.HexFormat;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class ManagedArtifactService {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Logger LOG = LoggerFactory.getLogger(ManagedArtifactService.class);
    private static final int RANGE_LIMIT = 1024 * 1024;
    private static final Pattern ARTIFACT_ID = Pattern.compile("artifact_[0-9a-f]{64}");
    private static final Pattern RANGE = Pattern.compile("^bytes=([0-9]*)-([0-9]*)$");
    private final ManagedAgentService sessions;
    private final ManagedToolResultStore results;
    private final ManagedArtifactReader reader;
    private final ManagedArtifactPolicy policy;
    private final ManagedAgentProperties.Artifacts settings;
    private final Semaphore readers;

    public ManagedArtifactService(ManagedAgentService sessions, ManagedToolResultStore results,
            ManagedArtifactReader reader, ManagedArtifactPolicy policy, ManagedAgentProperties properties) {
        this.sessions = sessions;
        this.results = results;
        this.reader = reader;
        this.policy = policy;
        this.settings = properties.getArtifacts();
        if (settings.getMaxConcurrentReads() < 1 || settings.getReadTimeout() == null
                || settings.getReadTimeout().isNegative() || settings.getReadTimeout().isZero()) {
            throw new IllegalArgumentException("Artifact reader limits must be positive");
        }
        readers = new Semaphore(settings.getMaxConcurrentReads());
    }

    public ToolResultResponse result(TenantContext tenant, String sessionId, String itemId) {
        SessionRecord session = session(tenant, sessionId);
        var result = results.findResult(tenant.tenantId(), sessionId, itemId)
                .orElseThrow(ManagedArtifactService::notFound).deepCopy();
        List<Artifact> artifacts = new ArrayList<>();
        for (var reference : result.path("artifacts")) {
            artifacts.add(results.findArtifact(tenant.tenantId(), sessionId,
                    reference.path("id").asText()).orElseThrow(ManagedArtifactService::notFound));
        }
        boolean sessionRead = !artifacts.isEmpty() && policy.readOriginal(tenant.tenantId(), tenant.actorId(),
                session.workspace().getWorkspaceId(), session.sessionId());
        var availability = reader.availability(artifacts);
        boolean canRead = false;
        for (int index = 0; index < artifacts.size(); index++) {
            var artifact = artifacts.get(index);
            var view = view(artifact, availability.get(artifact.descriptor().path("id").asText()), sessionRead);
            ((ObjectNode) result.path("artifacts").get(index)).setAll((ObjectNode) view.artifact());
            canRead |= view.access().canReadContent();
        }
        return new ToolResultResponse(result, new ArtifactAccess(canRead));
    }

    public ArtifactResponse artifact(TenantContext tenant, String sessionId, String artifactId) {
        return view(tenant, session(tenant, sessionId), stored(tenant, sessionId, artifactId));
    }

    public WebShellPage<ArtifactResponse> page(TenantContext tenant, String sessionId,
            String cursor, int limit) {
        SessionRecord session = session(tenant, sessionId);
        if (limit < 1 || limit > 100) {
            throw badRequest("invalid_limit", "Limit must be between 1 and 100.");
        }
        Long watermark = null;
        Long before = null;
        String beforeId = null;
        if (cursor != null && !cursor.isBlank()) {
            try {
                if (cursor.length() > 2048) {
                    throw new IllegalArgumentException();
                }
                var decoded = JSON.readTree(Base64.getUrlDecoder().decode(cursor));
                if (decoded.size() != 6 || decoded.path("v").asInt() != 1
                        || !tenant.tenantId().equals(decoded.path("tenant").asText())
                        || !sessionId.equals(decoded.path("session").asText())
                        || !decoded.path("watermark").canConvertToLong()
                        || !decoded.path("before").canConvertToLong()
                        || !ARTIFACT_ID.matcher(decoded.path("id").asText()).matches()) {
                    throw new IllegalArgumentException();
                }
                watermark = decoded.path("watermark").longValue();
                before = decoded.path("before").longValue();
                beforeId = decoded.path("id").asText();
                if (watermark < 0 || before < 0 || before > watermark) {
                    throw new IllegalArgumentException();
                }
            } catch (IOException | IllegalArgumentException error) {
                throw badRequest("invalid_cursor", "Artifact cursor is invalid.");
            }
        }
        var page = results.listArtifacts(tenant.tenantId(), sessionId, watermark, before, beforeId, limit);
        String next = null;
        if (page.hasMore()) {
            var last = page.artifacts().getLast();
            var position = JSON.createObjectNode().put("v", 1).put("tenant", tenant.tenantId())
                    .put("session", sessionId).put("watermark", page.watermark())
                    .put("before", last.creationSequence()).put("id", last.descriptor().path("id").asText());
            next = Base64.getUrlEncoder().withoutPadding().encodeToString(
                    position.toString().getBytes(StandardCharsets.UTF_8));
        }
        boolean sessionRead = !page.artifacts().isEmpty()
                && policy.readOriginal(tenant.tenantId(), tenant.actorId(),
                        session.workspace().getWorkspaceId(), session.sessionId());
        var availability = reader.availability(page.artifacts());
        if (availability.containsValue(false)) {
            session(tenant, sessionId);
        }
        return new WebShellPage<>(page.artifacts().stream().map(a -> view(a,
                availability.get(a.descriptor().path("id").asText()), sessionRead)).toList(), next, page.hasMore());
    }

    private ArtifactResponse view(TenantContext tenant, SessionRecord session, Artifact artifact) {
        boolean available = reader.available(artifact);
        if (!available) {
            session(tenant, artifact.source().sessionId());
        }
        return view(artifact, available, policy.readOriginal(tenant.tenantId(), tenant.actorId(),
                session.workspace().getWorkspaceId(), session.sessionId()));
    }

    private static ArtifactResponse view(Artifact artifact, boolean available, boolean sessionRead) {
        var descriptor = (ObjectNode) artifact.descriptor().deepCopy();
        descriptor.put("availability", available ? "available" : "unavailable");
        return new ArtifactResponse(descriptor, new ArtifactAccess(available && sessionRead));
    }

    private SessionRecord session(TenantContext tenant, String sessionId) {
        tenant.requireActorId();
        SessionRecord session = sessions.requireReadableSession(tenant.tenantId(), tenant.actorId(), sessionId);
        if (!settings.isEnabled() || !reader.supported() || session.workspace() == null
                || "DELETING".equals(session.status())) {
            throw notFound();
        }
        return session;
    }

    private Artifact stored(TenantContext tenant, String sessionId, String artifactId) {
        return results.findArtifact(tenant.tenantId(), sessionId, artifactId)
                .orElseThrow(ManagedArtifactService::notFound);
    }

    private void requireContent(TenantContext tenant, Artifact artifact) {
        requireContentAccess(tenant, artifact);
        if (!reader.available(artifact)) {
            session(tenant, artifact.source().sessionId());
            throw unavailable();
        }
    }

    private void requireContentAccess(TenantContext tenant, Artifact artifact) {
        var source = artifact.source();
        SessionRecord session = session(tenant, source.sessionId());
        if (!source.workspaceId().equals(session.workspace().getWorkspaceId())) {
            throw notFound();
        }
        if (!policy.readOriginal(tenant.tenantId(), tenant.actorId(), source.workspaceId(), source.sessionId())) {
            throw new ApiException(HttpStatus.FORBIDDEN, "artifact_content_forbidden",
                    "The current actor cannot read original artifact bytes.");
        }
    }

    public void content(TenantContext tenant, String sessionId, String artifactId, String revision,
            String range, String ifMatch, String ifRange, HttpServletResponse response) throws IOException {
        boolean acquired = false;
        long sent = 0;
        String outcome = "denied";
        try {
            session(tenant, sessionId);
            Artifact artifact = stored(tenant, sessionId, artifactId);
            requireContent(tenant, artifact);
            outcome = "rejected";
            if (revision == null || revision.isBlank()) {
                throw badRequest("revision_required", "A fixed revision is required.");
            }
            var descriptor = artifact.descriptor();
            if (!revision.equals(descriptor.path("revision").asText())) {
                throw notFound();
            }
            String etag = "\"" + descriptor.path("sha256").asText() + "\"";
            if (ifMatch != null && !matches(ifMatch, etag)) {
                throw new ApiException(HttpStatus.PRECONDITION_FAILED, "artifact_revision_mismatch",
                        "The artifact validator does not match.");
            }
            if (ifRange != null && !etag.equals(ifRange.trim())) {
                range = null;
            }
            long size = descriptor.path("byte_length").longValue();
            Selection selection;
            try {
                selection = select(range, size);
            }
            catch (ApiException error) {
                if (error.getStatus() == HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE) {
                    response.setHeader("Content-Range", "bytes */" + size);
                }
                throw error;
            }
            if (!readers.tryAcquire()) {
                response.setHeader("Retry-After", "1");
                throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "artifact_read_limit",
                        "The artifact reader limit has been reached.");
            }
            acquired = true;
            outcome = "interrupted";
            long started = System.nanoTime();
            long timeout = settings.getReadTimeout().toNanos();
            long revalidation = settings.getReadRevalidationInterval()
                    .toNanos();
            try (var lease = reader.lease(artifact)) {
                // Access was verified before streaming; re-verify at most once
                // per revalidation window instead of on every chunk. MIN_VALUE,
                // not 0: nanoTime may be negative, and the first guard call must
                // always re-verify.
                long[] nextAccessCheck = {Long.MIN_VALUE};
                Runnable guard = () -> {
                    long now = System.nanoTime();
                    if (now - started > timeout) {
                        throw unavailable();
                    }
                    if (now >= nextAccessCheck[0]) {
                        requireContentAccess(tenant, artifact);
                        nextAccessCheck[0] = now + revalidation;
                    }
                };
                if (selection.partial()) {
                    byte[] bytes = reader.readRange(artifact, selection.offset(), (int) selection.length(), lease, guard);
                    lease.check();
                    guard.run();
                    headers(response, artifact, etag, selection, size);
                    response.getOutputStream().write(bytes);
                    sent = bytes.length;
                } else {
                    try (var input = reader.open(artifact, lease, guard)) {
                        byte[] buffer = new byte[64 * 1024];
                        int count = input.read(buffer);
                        lease.check();
                        guard.run();
                        headers(response, artifact, etag, selection, size);
                        response.flushBuffer();
                        while (count != -1) {
                            lease.check();
                            guard.run();
                            response.getOutputStream().write(buffer, 0, count);
                            sent += count;
                            count = input.read(buffer);
                        }
                    }
                }
            } catch (RuntimeException error) {
                if (response.isCommitted()) {
                    throw new IOException("Artifact stream interrupted", error);
                }
                if (error instanceof ApiException api) {
                    if ("tool_output_session_retired".equals(api.getCode())
                            || "tool_output_read_expired".equals(api.getCode())) {
                        session(tenant, sessionId);
                        throw unavailable();
                    }
                    throw api;
                }
                throw unavailable();
            }
            outcome = "completed";
        } finally {
            if (acquired) {
                readers.release();
            }
            LOG.info("artifact_read tenant={} actor={} session={} artifact={} outcome={} bytes={}",
                    tenant.tenantId(), tenant.actorId(), sessionId, artifactId, outcome, sent);
        }
    }

    private static void headers(HttpServletResponse response, Artifact artifact, String etag,
            Selection selection, long size) {
        response.setStatus(selection.partial() ? 206 : 200);
        response.setContentType("application/octet-stream");
        response.setContentLengthLong(selection.length());
        if (!selection.partial()) {
            // End committed download failures without waiting for the keep-alive timeout.
            response.setHeader("Connection", "close");
        }
        response.setHeader("ETag", etag);
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Cache-Control", "private, no-store, no-transform");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Disposition", "attachment; filename=\""
                + artifact.streamId() + ".bin\"");
        response.setHeader("Repr-Digest", "sha-256=:" + Base64.getEncoder().encodeToString(
                HexFormat.of().parseHex(artifact.descriptor().path("sha256").asText())) + ":");
        if (selection.partial()) {
            response.setHeader("Content-Range", "bytes " + selection.offset() + "-"
                    + (selection.offset() + selection.length() - 1) + "/" + size);
        }
    }

    record Selection(long offset, long length, boolean partial) { }

    static Selection select(String range, long size) {
        if (range == null) {
            return new Selection(0, size, false);
        }
        if (range.contains(",")) {
            throw badRequest("unsupported_range", "Only one byte range is supported.");
        }
        var matcher = RANGE.matcher(range.trim());
        if (!matcher.matches() || matcher.group(1).isEmpty() && matcher.group(2).isEmpty()) {
            throw badRequest("invalid_range", "Invalid byte range.");
        }
        long start;
        long end;
        try {
            if (matcher.group(1).isEmpty()) {
                long suffix = Long.parseLong(matcher.group(2));
                start = Math.max(0, size - suffix);
                end = size - 1;
            } else {
                start = Long.parseLong(matcher.group(1));
                end = matcher.group(2).isEmpty() ? size - 1 : Long.parseLong(matcher.group(2));
                if (!matcher.group(2).isEmpty() && end < start) {
                    throw badRequest("invalid_range", "Invalid byte range.");
                }
                end = Math.min(size - 1, end);
            }
        } catch (NumberFormatException error) {
            throw badRequest("invalid_range", "Invalid byte range.");
        }
        if (size == 0 || start >= size || end < start) {
            throw new ApiException(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "range_not_satisfiable",
                    "The range does not intersect this representation.");
        }
        long length = end - start + 1;
        if (length > RANGE_LIMIT) {
            throw badRequest("range_too_large", "A range may contain at most 1048576 bytes.");
        }
        return new Selection(start, length, true);
    }

    static boolean matches(String condition, String etag) {
        for (String candidate : condition.split(",")) {
            if ("*".equals(candidate.trim()) || etag.equals(candidate.trim())) {
                return true;
            }
        }
        return false;
    }

    private static ApiException badRequest(String code, String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, code, message);
    }

    private static ApiException notFound() {
        return new ApiException(HttpStatus.NOT_FOUND, "artifact_not_found", "The resource was not found.");
    }

    private static ApiException unavailable() {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "artifact_unavailable", "Artifact content is unavailable.");
    }
}
