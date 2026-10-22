package com.alibaba.qwen.code.managedagent;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

// #15049: waits for a process to stop by polling rather than through
// onExit(), whose future completes on the common ForkJoinPool — in the fork
// every Hosted*IT class shares, a busy pool can time it out for a process
// that is already gone. The zombie judgment is the one
// HostedOperatorRecoveryProbe.statRunning already pins.
final class HostedProcessLiveness {
    private static final Path PROC = Path.of("/proc");

    private HostedProcessLiveness() {
    }

    static void awaitStopped(ProcessHandle process, Duration timeout, String what)
            throws IOException, InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (running(process)) {
            assertThat(System.nanoTime()).as(() -> what + ": " + describe(process)).isLessThan(deadline);
            Thread.sleep(20);
        }
    }

    // A zombie counts as stopped: once its whole thread group has exited it
    // holds no descriptors (the Node runtime producers leave through
    // exit_group()), and a container runner's PID 1 may never reap it.
    // Without procfs, liveness is all there is to go on.
    private static boolean running(ProcessHandle process) throws IOException {
        if (!process.isAlive()) {
            return false;
        }
        return !Files.isDirectory(PROC) || HostedOperatorRecoveryProbe.statRunning(process, stat(process));
    }

    private static String describe(ProcessHandle process) {
        String state = "?";
        try {
            String stat = Files.readString(stat(process));
            int name = stat.lastIndexOf(')');
            if (name >= 0 && name + 2 < stat.length()) {
                state = String.valueOf(stat.charAt(name + 2));
            }
        } catch (IOException unavailable) {
            // Reaped since the last poll, or no procfs; the rest still names it.
        }
        return process.pid() + " (parent " + process.parent().map(parent -> Long.toString(parent.pid())).orElse("?")
                + ", state " + state + "): " + process.info().commandLine().orElse("?");
    }

    private static Path stat(ProcessHandle process) {
        return PROC.resolve(Long.toString(process.pid())).resolve("stat");
    }
}
