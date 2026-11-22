package com.alibaba.qwen.code.managedagent.session;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

/** Shared test doubles for the coordinator tests. */
final class CoordinatorTestSupport {
    private CoordinatorTestSupport() {
    }

    /** An ExecutorService mock that runs every task synchronously. */
    static ExecutorService directExecutor() {
        ExecutorService executor = mock(ExecutorService.class);
        Future<?> future = mock(Future.class);
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(executor).execute(any(Runnable.class));
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return future;
        }).when(executor).submit(any(Runnable.class));
        return executor;
    }
}
