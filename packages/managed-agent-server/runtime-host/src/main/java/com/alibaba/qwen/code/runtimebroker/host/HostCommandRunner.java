package com.alibaba.qwen.code.runtimebroker.host;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public final class HostCommandRunner {
    private static final int RECORD_LIMIT = 64 * 1024;

    private HostCommandRunner() {
    }

    public static Result run(List<String> command, byte[] input, Duration timeout) {
        Process process = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD);
            if (input.length == 0) {
                builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            }
            process = builder.start();
            Process started = process;
            CompletableFuture<byte[]> output = input.length == 0 ? CompletableFuture.completedFuture(new byte[0])
                    : CompletableFuture.supplyAsync(() -> {
                        try {
                            return started.getInputStream().readNBytes(RECORD_LIMIT + 1);
                        } catch (IOException failure) {
                            throw unavailable(failure);
                        }
                    });
            CompletableFuture<Void> writer = CompletableFuture.runAsync(() -> {
                try (var stdin = started.getOutputStream()) {
                    stdin.write(input);
                } catch (IOException failure) {
                    throw unavailable(failure);
                }
            }, task -> Thread.ofVirtual().start(task));
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                throw unavailable(null);
            }
            writer.get(1, TimeUnit.SECONDS);
            return new Result(process.exitValue(), output.get(1, TimeUnit.SECONDS));
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw unavailable(failure);
        } catch (Exception failure) {
            throw unavailable(failure);
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private static RuntimeBrokerException unavailable(Throwable failure) {
        return new RuntimeBrokerException(503, "ssh_runtime_unavailable", "SSH Runtime connection is unavailable.",
                true, failure);
    }

    public record Result(int exitCode, byte[] stdout) {
        public Result {
            stdout = stdout.clone();
        }

        @Override
        public byte[] stdout() {
            return stdout.clone();
        }
    }
}
