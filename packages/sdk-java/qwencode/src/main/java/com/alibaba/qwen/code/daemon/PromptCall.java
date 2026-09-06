package com.alibaba.qwen.code.daemon;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;

/** Independent prompt admission and reliable terminal stages. */
public final class PromptCall {
    private final CompletableFuture<PromptAcceptance> acceptance;
    private final CompletableFuture<PromptTerminal> completion;

    PromptCall(CompletableFuture<PromptAcceptance> acceptance,
            CompletableFuture<PromptTerminal> completion, Executor futureExecutor,
            CountDownLatch terminalPublicationGate) {
        this.acceptance = asyncView(acceptance, futureExecutor, null);
        this.completion = asyncView(completion, futureExecutor,
                terminalPublicationGate);
    }

    /**
     * Cancelling the returned view does not cancel the daemon prompt.
     *
     * @return an observation-only admission future
     */
    public CompletableFuture<PromptAcceptance> acceptanceFuture() {
        return acceptance.copy();
    }

    /**
     * Cancelling the returned view does not cancel the daemon prompt.
     * An indeterminate local timeout may complete this view before a blocked
     * transport stream has finished closing; that outcome is not a signal that
     * the session is safe to reuse.
     *
     * @return an observation-only terminal future
     */
    public CompletableFuture<PromptTerminal> completionFuture() {
        return completion.copy();
    }

    private static <T> CompletableFuture<T> asyncView(
            CompletableFuture<T> source, Executor executor,
            CountDownLatch publicationGate) {
        CompletableFuture<T> result = new CompletableFuture<>();
        source.whenCompleteAsync((value, failure) -> {
            await(publicationGate);
            if (failure == null) {
                result.complete(value);
            } else {
                result.completeExceptionally(failure);
            }
        }, executor);
        return result;
    }

    private static void await(CountDownLatch gate) {
        if (gate == null) {
            return;
        }
        boolean interrupted = false;
        while (true) {
            try {
                gate.await();
                break;
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
