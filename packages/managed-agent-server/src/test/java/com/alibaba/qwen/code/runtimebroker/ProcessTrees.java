package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/** Process-tree helpers for the fault gates. POSIX only. */
final class ProcessTrees {
    private static final boolean PROCFS = Files.isDirectory(
            Path.of("/proc/self"));

    private ProcessTrees() {
    }

    static Set<Long> childPids() {
        return ProcessHandle.current().children().map(ProcessHandle::pid)
                .collect(Collectors.toSet());
    }

    /**
     * Whether a process still runs. The JDK counts a zombie as alive, and a
     * killed tool's orphans stay zombies wherever PID 1 does not reap them.
     */
    static boolean running(ProcessHandle process) {
        if (!process.isAlive()) {
            return false;
        }
        if (!PROCFS) {
            return true;
        }
        String stat;
        try {
            stat = Files.readString(Path.of("/proc",
                    Long.toString(process.pid()), "stat"));
        } catch (NoSuchFileException gone) {
            return false;
        } catch (IOException unreadable) {
            return true;
        }
        // The state follows the command name, which is in parentheses.
        int name = stat.lastIndexOf(')');
        return name < 0 || name + 2 >= stat.length()
                || stat.charAt(name + 2) != 'Z';
    }

    /** SIGKILLs a process and every descendant, then waits for them. */
    static void kill(ProcessHandle root, Duration timeout) {
        List<ProcessHandle> tree = new ArrayList<>(
                root.descendants().toList());
        tree.add(root);
        kill(tree, timeout);
    }

    /** SIGKILLs every process given, then waits until none runs. */
    static void kill(Collection<ProcessHandle> processes, Duration timeout) {
        processes.forEach(ProcessHandle::destroyForcibly);
        long deadline = System.nanoTime() + timeout.toNanos();
        for (ProcessHandle process : processes) {
            while (running(process)) {
                if (System.nanoTime() > deadline) {
                    throw new IllegalStateException("process "
                            + process.pid() + " survived SIGKILL");
                }
                try {
                    Thread.sleep(20);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
            }
        }
    }

    /** Sends a signal by name, such as STOP or CONT. */
    static void signal(long pid, String name) {
        try {
            Process kill = new ProcessBuilder("kill", "-" + name,
                    Long.toString(pid)).inheritIO().start();
            if (!kill.waitFor(10, TimeUnit.SECONDS) || kill.exitValue() != 0) {
                throw new IllegalStateException("kill -" + name + " " + pid
                        + " failed");
            }
        } catch (IOException exception) {
            throw new IllegalStateException("kill is required", exception);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
    }
}
