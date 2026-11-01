package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.repository.ManagedToolResultStore.Artifact;

import java.io.InputStream;
import java.util.List;
import java.util.Map;

public interface ManagedArtifactReader {
    public boolean supported();

    public boolean available(Artifact artifact);

    public Map<String, Boolean> availability(List<Artifact> artifacts);

    public InputStream open(Artifact artifact);

    public InputStream open(Artifact artifact, Runnable guard);

    public InputStream open(Artifact artifact, com.alibaba.qwen.code.managedagent.contracts.artifact.ArtifactReadLease lease, Runnable guard);

    public byte[] readRange(Artifact artifact, long offset, int length);

    public byte[] readRange(Artifact artifact, long offset, int length, Runnable guard);

    public byte[] readRange(Artifact artifact, long offset, int length,
            com.alibaba.qwen.code.managedagent.contracts.artifact.ArtifactReadLease lease, Runnable guard);

    public com.alibaba.qwen.code.managedagent.contracts.artifact.ArtifactReadLease lease(Artifact artifact);
}
