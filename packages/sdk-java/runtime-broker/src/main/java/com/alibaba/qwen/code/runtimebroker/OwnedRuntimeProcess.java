package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Owns termination of one Runtime process and every observed descendant. */
final class OwnedRuntimeProcess {
    private final Process process;
    private final ProcessHandle root;
    private final Map<Long, ProcessHandle> observed = new LinkedHashMap<>();

    OwnedRuntimeProcess(Process process) {
        if (process == null) {
            throw new IllegalArgumentException("process is required");
        }
        this.process = process;
        this.root = process.toHandle();
    }

    OwnedRuntimeProcess(ProcessHandle processHandle) {
        if (processHandle == null) {
            throw new IllegalArgumentException("processHandle is required");
        }
        this.process = null;
        this.root = processHandle;
    }

    synchronized void stop(Duration gracefulTimeout,
            Duration forceTimeout) {
        collectDescendants();
        if (!hasLiveProcess()) {
            return;
        }
        terminate(false);
        if (waitForExit(gracefulTimeout)) {
            return;
        }
        collectDescendants();
        terminate(true);
        if (!waitForExit(forceTimeout)) {
            throw new RuntimeBrokerException(503,
                    "runtime_broker_release_failed",
                    "Managed Runtime process tree did not exit.", true);
        }
    }

    synchronized boolean isAlive() {
        collectDescendants();
        return hasLiveProcess();
    }

    synchronized Set<Long> liveProcessIds() {
        collectDescendants();
        Set<Long> result = new java.util.LinkedHashSet<>();
        if (root.isAlive()) {
            result.add(root.pid());
        }
        for (ProcessHandle handle : observed.values()) {
            if (handle.isAlive()) {
                result.add(handle.pid());
            }
        }
        return Set.copyOf(result);
    }

    long pid() {
        return root.pid();
    }

    private boolean waitForExit(Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            collectDescendants();
            if (!hasLiveProcess()) {
                return true;
            }
            try {
                Thread.sleep(25);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new RuntimeBrokerException(503,
                        "runtime_broker_release_failed",
                        "Managed Runtime shutdown was interrupted.", true);
            }
        }
        collectDescendants();
        return !hasLiveProcess();
    }

    private void collectDescendants() {
        root.descendants().forEach(handle -> observed.putIfAbsent(
                handle.pid(), handle));
    }

    private boolean hasLiveProcess() {
        if (root.isAlive()) {
            return true;
        }
        for (ProcessHandle handle : observed.values()) {
            if (handle.isAlive()) {
                return true;
            }
        }
        return false;
    }

    private void terminate(boolean force) {
        List<ProcessHandle> descendants = new ArrayList<>(observed.values());
        for (int index = descendants.size() - 1; index >= 0; index--) {
            terminate(descendants.get(index), force);
        }
        if (root.isAlive()) {
            if (process != null && force) {
                process.destroyForcibly();
            } else if (process != null) {
                process.destroy();
            } else {
                terminate(root, force);
            }
        }
    }

    private static void terminate(ProcessHandle handle, boolean force) {
        if (!handle.isAlive()) {
            return;
        }
        if (force) {
            handle.destroyForcibly();
        } else {
            handle.destroy();
        }
    }
}
