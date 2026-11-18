package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.List;
import java.util.Optional;

/** Finds MCP owners left holding their mount by a Session whose journal is sealed. */
public interface ParkedMcpOwners {
    public record Owner(long id, String tenantId, String harnessSessionId, String bindingId,
            long generation, String runtimeSessionId, String storageKey) {
    }

    /** The next owners holding a mount, in id order after {@code afterId}. */
    public List<Owner> candidates(long afterId, int limit);

    /** The owners holding a mount on this storage. */
    public List<Owner> onStorage(String storageKey, int limit);

    /** How long the owner's Session journal has been sealed; empty while it is not sealed. */
    public Optional<Duration> sealedFor(Owner owner);
}
