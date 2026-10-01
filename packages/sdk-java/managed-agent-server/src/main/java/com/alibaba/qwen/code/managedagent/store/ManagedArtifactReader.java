package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore.Artifact;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.stream.Collectors;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

@Component
public class ManagedArtifactReader {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ObjectProvider<ToolPublicationDataStore> publications;

    public ManagedArtifactReader(ObjectProvider<ToolPublicationDataStore> publications) {
        this.publications = publications;
    }

    public boolean supported() { return publications.getIfAvailable() != null; }

    public boolean available(Artifact artifact) {
        return availability(List.of(artifact)).get(artifact.descriptor().path("id").asText());
    }

    public Map<String, Boolean> availability(List<Artifact> artifacts) {
        Map<String, Boolean> result = new HashMap<>();
        var data = publications.getIfAvailable();
        for (var group : artifacts.stream().collect(Collectors.groupingBy(
                artifact -> artifact.source().sessionKey().toString())).values()) {
            var rows = data == null ? Map.<String, Map<String, Object>>of()
                    : data.referencedPublications(group.getFirst().source().sessionKey(),
                            group.stream().map(Artifact::publicationId).distinct().toList());
            for (var artifact : group) {
                var source = artifact.source();
                result.put(artifact.descriptor().path("id").asText(), ToolPublicationDataStore.referenced(
                        rows.get(artifact.publicationId()), source.outcomeRef(),
                        source.journalRevision(), source.receiptSequence()));
            }
        }
        return result;
    }

    public InputStream open(Artifact artifact) {
        return open(artifact, () -> {});
    }

    public InputStream open(Artifact artifact, Runnable guard) {
        var lease = lease(artifact);
        try {
            var input = open(artifact, lease, guard);
            return new java.io.FilterInputStream(input) {
                @Override
                public void close() throws java.io.IOException {
                    try (lease) {
                        super.close();
                    }
                }
            };
        } catch (RuntimeException error) {
            try {
                lease.close();
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
    }

    public InputStream open(Artifact artifact, ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        lease.requireScope(artifact.source().sessionKey());
        Runnable protectedGuard = () -> {
            lease.check();
            guard.run();
            check(artifact);
        };
        return verified(artifact, lease, protectedGuard).open(protectedGuard);
    }

    public byte[] readRange(Artifact artifact, long offset, int length) {
        return readRange(artifact, offset, length, () -> {});
    }

    public byte[] readRange(Artifact artifact, long offset, int length, Runnable guard) {
        try (var lease = lease(artifact)) {
            return readRange(artifact, offset, length, lease, guard);
        }
    }

    public byte[] readRange(Artifact artifact, long offset, int length,
            ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        ToolPublicationContract.require(offset >= 0 && length >= 0 && length <= 1024 * 1024
                        && offset <= artifact.descriptor().path("byte_length").asLong()
                        && length <= artifact.descriptor().path("byte_length").asLong() - offset,
                "Artifact range is invalid");
        lease.requireScope(artifact.source().sessionKey());
        Runnable protectedGuard = () -> {
            lease.check();
            guard.run();
            check(artifact);
        };
        return verified(artifact, lease, protectedGuard).readRange(offset, length, protectedGuard);
    }

    byte[] readRange(Artifact artifact, ToolPublicationDataStore.VerifiedStream stream,
            long offset, int length, Runnable guard) {
        return stream.readRange(offset, length, () -> {
            guard.run();
            check(artifact);
        });
    }

    public ToolPublicationRetentionStore.ReadLease lease(Artifact artifact) {
        return data().readLease(artifact.source().sessionKey());
    }

    ToolPublicationDataStore.VerifiedStream verified(Artifact artifact,
            ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        guard.run();
        var source = artifact.source();
        var binding = artifact.binding();
        var identity = JSON.createObjectNode();
        identity.put("tenantId", source.tenantId()).put("sessionId", source.sessionId());
        for (String field : List.of("turnId", "executionCallId", "bindingGeneration", "captureId", "revision")) {
            identity.set(field, binding.path(field));
        }
        identity.set("callId", binding.path("reference").path("callId"));
        identity.set("invocationDigest", binding.path("reference").path("argsDigest"));
        ToolPublicationContract.require(artifact.manifestRef().equals(source.resultRef()),
                "Artifact source conflicts");
        var stream = data().openReferencedStream(source.sessionKey(), artifact.publicationId(),
                source.outcomeRef(), artifact.manifestRef(), identity, artifact.streamId(),
                source.journalRevision(), source.receiptSequence(), lease, guard);
        ToolPublicationContract.require(stream.size() == artifact.descriptor().path("byte_length").asLong(-1),
                "Artifact length conflicts");
        return stream;
    }

    private void check(Artifact artifact) {
        var source = artifact.source();
        data().requireReferenced(source.sessionKey(), artifact.publicationId(), source.outcomeRef(),
                source.journalRevision(), source.receiptSequence());
    }

    private ToolPublicationDataStore data() {
        var data = publications.getIfAvailable();
        if (data == null) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "artifact_unavailable",
                    "Artifact storage is unavailable.");
        }
        return data;
    }
}
