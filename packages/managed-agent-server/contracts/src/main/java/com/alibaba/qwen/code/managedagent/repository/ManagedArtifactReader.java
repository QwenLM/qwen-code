package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ArtifactReadLease;
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

    public InputStream open(Artifact artifact, ArtifactReadLease lease, Runnable guard);

    public byte[] readRange(Artifact artifact, long offset, int length);

    public byte[] readRange(Artifact artifact, long offset, int length, Runnable guard);

    public byte[] readRange(Artifact artifact, long offset, int length,
            ArtifactReadLease lease, Runnable guard);

    public ArtifactReadLease lease(Artifact artifact);
}
