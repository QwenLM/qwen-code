package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * Durable local-process workers outlive the Spring context that launched
 * them. A Hosted IT stops the ones its Broker registered, and only those:
 * each registration must name this host, this boot and the worker's own
 * process start, PID namespace and time namespace.
 */
final class HostedDurableWorkers {
    private HostedDurableWorkers() {
    }

    static void stop(Path broker, ObjectMapper json) throws Exception {
        if (!Files.isDirectory(broker)) return;
        try (var registrations = Files.list(broker)) {
            for (Path file : registrations.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                JsonNode saved = json.readTree(Files.readString(file));
                long pid = saved.path("pid").asLong();
                if (pid <= 0) continue;
                JsonNode handle = json.readTree(saved.path("handle").asText());
                if (!file.getFileName().toString().equals(handle.path("resourceId").asText() + ".json")
                        || !handle.path("hostId").asText().equals(Files.readString(Path.of("/etc/machine-id")).strip())
                        || !handle.path("bootId").asText().equals(Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).strip())) continue;
                var worker = ProcessHandle.of(pid).orElse(null);
                if (worker == null || !worker.isAlive()) continue;
                try {
                    Path process = Path.of("/proc", Long.toString(pid));
                    String stat = Files.readString(process.resolve("stat"));
                    String start = "ticks:" + stat.substring(stat.lastIndexOf(')') + 2).split(" ")[19];
                    if (!start.equals(saved.path("started").asText())
                            || !handle.path("pidNamespace").asText().equals(Files.readSymbolicLink(process.resolve("ns/pid")).toString())
                            || !handle.path("timeNamespace").asText().equals(Files.readSymbolicLink(process.resolve("ns/time")).toString())) continue;
                } catch (java.nio.file.NoSuchFileException exited) {
                    continue;
                }
                worker.destroyForcibly();
                worker.onExit().get(10, TimeUnit.SECONDS);
            }
        }
    }
}
