package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.List;

/** Finds MCP owners left holding their mount by a Session whose journal is sealed. */
public interface ParkedMcpOwners {
    public record Owner(long id, String tenantId, String harnessSessionId, String bindingId,
            long generation, String runtimeSessionId, String storageKey) {
    }

    /** The next owners holding a mount, in id order after {@code afterId}. */
    public List<Owner> candidates(long afterId, int limit);

    /** Whether the owner's Session journal has stayed sealed for at least {@code idle}. */
    public boolean parked(Owner owner, Duration idle);
}
