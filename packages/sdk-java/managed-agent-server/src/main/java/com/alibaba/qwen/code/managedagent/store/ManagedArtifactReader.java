package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore.Artifact;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.List;
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
        if (!supported()) { return false; }
        try {
            check(artifact);
            return true;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    public InputStream open(Artifact artifact) {
        return open(artifact, () -> {});
    }

    public InputStream open(Artifact artifact, Runnable guard) {
        return verified(artifact).open(() -> { guard.run(); check(artifact); });
    }

    public byte[] readRange(Artifact artifact, long offset, int length) {
        return readRange(artifact, offset, length, () -> {});
    }

    public byte[] readRange(Artifact artifact, long offset, int length, Runnable guard) {
        return verified(artifact).readRange(offset, length, () -> { guard.run(); check(artifact); });
    }

    private ToolPublicationDataStore.VerifiedStream verified(Artifact artifact) {
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
                source.journalRevision(), source.receiptSequence());
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
