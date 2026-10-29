package com.alibaba.qwen.code.managedagent;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

// The one zombie-aware liveness judgment the Hosted ITs and probes share.
// #15049: waits poll rather than go through onExit(), whose future completes
// on the common ForkJoinPool — in the fork every Hosted*IT class shares, a
// busy pool can time it out for a process that is already gone.
final class HostedProcessLiveness {
    private static final Path PROC = Path.of("/proc");

    private HostedProcessLiveness() {
    }

    static void awaitStopped(ProcessHandle process, Duration timeout, String what) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (running(process)) {
            assertThat(System.nanoTime()).as(() -> what + ": " + describe(process)).isLessThan(deadline);
            Thread.sleep(20);
        }
    }

    // A zombie counts as stopped: once its whole thread group has exited it
    // holds no descriptors (the Node runtime producers leave through
    // exit_group()), and a container runner's PID 1 may never reap it.
    // Without procfs, liveness is all there is to go on. A stat read that
    // fails while the process lives surfaces rather than reading as stopped.
    static boolean running(ProcessHandle process) {
        return running(process, PROC);
    }

    // The procfs root is a parameter so the unit test can drive the
    // no-procfs and unreadable-stat branches on any host.
    static boolean running(ProcessHandle process, Path proc) {
        if (!process.isAlive()) {
            return false;
        }
        if (!Files.isDirectory(proc)) {
            return true;
        }
        try {
            return statRunning(process, proc.resolve(Long.toString(process.pid())).resolve("stat"));
        } catch (IOException unreadable) {
            throw new UncheckedIOException(unreadable);
        }
    }

    static boolean statRunning(ProcessHandle process, Path stat) throws IOException {
        try {
            String value = Files.readString(stat);
            return value.charAt(value.lastIndexOf(')') + 2) != 'Z';
        } catch (IOException error) {
            // A reaped process fails the read (ENOENT, or ESRCH from an already-dead
            // entry); re-check liveness so unrelated I/O failures still propagate.
            if (!process.isAlive()) {
                return false;
            }
            throw error;
        }
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
