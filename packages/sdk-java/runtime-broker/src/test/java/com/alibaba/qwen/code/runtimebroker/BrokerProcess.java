package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** A Broker JVM subprocess driven through {@link FaultGateBroker}. */
final class BrokerProcess implements AutoCloseable {
    private static final Duration START_TIMEOUT = Duration.ofSeconds(60);
    private static final Duration CALL_TIMEOUT = Duration.ofSeconds(120);

    record Reply(boolean ok, Object value, int status, String code,
            boolean retryable, String message) {
        JSONObject object() {
            requireOk();
            return (JSONObject) value;
        }

        Reply requireOk() {
            if (!ok) {
                throw new AssertionError("Broker call failed: " + status + " "
                        + code + " " + message);
            }
            return this;
        }
    }

    private final String name;
    private final Process process;
    private final BufferedWriter input;
    private final BlockingQueue<String> output = new LinkedBlockingQueue<>();
    private final Path log;
    private long nextId;

    private BrokerProcess(String name, Process process, Path log) {
        this.name = name;
        this.process = process;
        this.log = log;
        this.input = new BufferedWriter(new OutputStreamWriter(
                process.getOutputStream(), StandardCharsets.UTF_8));
        Thread reader = new Thread(() -> {
            try (BufferedReader lines = new BufferedReader(
                    new InputStreamReader(process.getInputStream(),
                            StandardCharsets.UTF_8))) {
                String line;
                while ((line = lines.readLine()) != null) {
                    output.add(line);
                }
            } catch (IOException ignored) {
                // The Broker is gone; pending calls time out.
            }
        }, "broker-" + name + "-stdout");
        reader.setDaemon(true);
        reader.start();
    }

    static BrokerProcess start(String name, Path config, Path log, Path home)
            throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", System.getProperty("java.class.path"),
                FaultGateBroker.class.getName(), config.toString())
                .redirectError(log.toFile());
        // The Runtime workers inherit this environment.
        builder.environment().put("HOME", home.toString());
        BrokerProcess broker = new BrokerProcess(name, builder.start(), log);
        String ready = broker.output.poll(START_TIMEOUT.toMillis(),
                TimeUnit.MILLISECONDS);
        if (ready == null || !JSON.parseObject(ready).getBooleanValue(
                "ready")) {
            broker.process.destroyForcibly();
            throw new AssertionError("Broker " + name + " did not start: "
                    + broker.logTail());
        }
        return broker;
    }

    Reply warm(String harness) {
        return call("warm", Map.of("harness", harness));
    }

    Reply acquire(String harness, String runtimeSession) {
        return call("acquire", Map.of("harness", harness,
                "runtimeSession", runtimeSession));
    }

    /** Opens a tool turn and prepares a foreground Shell call in it. */
    Reply prepare(String harness, String runtimeSession, String promptId,
            String callId, String command) {
        return call("prepare", Map.of("harness", harness,
                "runtimeSession", runtimeSession, "promptId", promptId,
                "callId", callId, "command", command));
    }

    Reply create(String harness, String runtimeSession, String key,
            Map<String, Object> reference) {
        return call("create", Map.of("harness", harness,
                "runtimeSession", runtimeSession, "key", key,
                "reference", reference));
    }

    Reply get(String harness, String runtimeSession, String execution) {
        return executionCall("get", harness, runtimeSession, execution);
    }

    Reply cancel(String harness, String runtimeSession, String execution) {
        return executionCall("cancel", harness, runtimeSession, execution);
    }

    Reply reconcile(String harness, String runtimeSession,
            String execution) {
        return executionCall("reconcile", harness, runtimeSession,
                execution);
    }

    /** An operator's explicit decision for an UNKNOWN execution. */
    Reply resolve(String harness, String runtimeSession, String execution,
            UnknownExecutionResolution resolution) {
        return call("resolve", Map.of("harness", harness,
                "runtimeSession", runtimeSession, "execution", execution,
                "resolution", resolution.name()));
    }

    Reply release(String harness, String runtimeSession) {
        return call("release", Map.of("harness", harness,
                "runtimeSession", runtimeSession));
    }

    long pid() {
        return process.pid();
    }

    /** The worker processes this Broker started and that are still alive. */
    List<ProcessHandle> workers() {
        return process.children().filter(ProcessTrees::running).toList();
    }

    /** The whole tree below this Broker, for cleanup after a kill. */
    List<ProcessHandle> descendants() {
        return process.descendants().toList();
    }

    /** SIGKILLs the Broker JVM alone; its workers become orphans. */
    void kill() throws InterruptedException {
        process.destroyForcibly();
        if (!process.waitFor(30, TimeUnit.SECONDS)) {
            throw new AssertionError("Broker " + name + " survived SIGKILL");
        }
    }

    void pause() {
        ProcessTrees.signal(process.pid(), "STOP");
    }

    void resume() {
        ProcessTrees.signal(process.pid(), "CONT");
    }

    String logTail() {
        try {
            List<String> lines = Files.readAllLines(log);
            return String.join("\n", lines.subList(
                    Math.max(0, lines.size() - 40), lines.size()));
        } catch (IOException exception) {
            return "(no log: " + exception.getMessage() + ")";
        }
    }

    @Override
    public void close() throws InterruptedException {
        if (!process.isAlive()) {
            return;
        }
        try {
            // A frozen Broker cannot read its closed input.
            ProcessTrees.signal(process.pid(), "CONT");
        } catch (IllegalStateException exited) {
            // It exited meanwhile; the wait below returns at once.
        }
        try {
            input.close();
        } catch (IOException ignored) {
            // The Broker already went away.
        }
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            process.waitFor(15, TimeUnit.SECONDS);
        }
    }

    private Reply executionCall(String op, String harness,
            String runtimeSession, String execution) {
        return call(op, Map.of("harness", harness,
                "runtimeSession", runtimeSession, "execution", execution));
    }

    private synchronized Reply call(String op, Map<String, Object> args) {
        long id = ++nextId;
        Map<String, Object> command = new LinkedHashMap<>(args);
        command.put("id", id);
        command.put("op", op);
        try {
            input.write(JSON.toJSONString(command));
            input.newLine();
            input.flush();
            String line = output.poll(CALL_TIMEOUT.toMillis(),
                    TimeUnit.MILLISECONDS);
            if (line == null) {
                throw new AssertionError("Broker " + name + " did not answer "
                        + op + ": " + logTail());
            }
            JSONObject reply = JSON.parseObject(line);
            if (reply.getLongValue("id") != id) {
                throw new AssertionError("Broker " + name
                        + " answered out of order: " + line);
            }
            return new Reply(reply.getBooleanValue("ok"), reply.get("value"),
                    reply.getIntValue("status"), reply.getString("code"),
                    reply.getBooleanValue("retryable"),
                    reply.getString("message"));
        } catch (IOException exception) {
            throw new AssertionError("Broker " + name + " is gone: "
                    + logTail(), exception);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }
}
