package com.alibaba.qwen.code.managedagent.contracts.hostaction;

/**
 * Host-implemented callback executing Turn-scoped actions inside the host's
 * trusted runtime context.
 */
@FunctionalInterface
public interface HostTurnActionExecutor {
    HostTurnActionResult execute(HostTurnActionInvocation invocation) throws Exception;
}
