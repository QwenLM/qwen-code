package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

public final class MacOsHostIdentity {
    private static final int MAX_BYTES = 64 * 1024;
    private static final Pattern PLATFORM_UUID = Pattern.compile("\"IOPlatformUUID\"\\s*=\\s*\"([^\"]+)\"");
    private static String machineId;

    private MacOsHostIdentity() {}

    public static synchronized String machineId() throws IOException {
        if (machineId == null) {
            machineId = parseMachineId(read("/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"));
        }
        return machineId;
    }

    static String bootId() throws IOException {
        return uuid(read("/usr/sbin/sysctl", "-n", "kern.bootsessionuuid")).toLowerCase(Locale.ROOT);
    }

    public static String birthTime(Path root, String device, String inode) throws IOException {
        return parseBirthTime(read("/usr/bin/stat", "-f", "%d|%i|%.9FB", "--", root.toString()), device, inode);
    }

    static String parseBirthTime(String output, String device, String inode) throws IOException {
        String[] fields = output.split("\\|", -1);
        if (fields.length != 3 || !device.equals(fields[0]) || !inode.equals(fields[1])
                || !fields[2].matches("[0-9]+\\.[0-9]{9}")) {
            throw new IOException("macOS storage identity changed or is unavailable");
        }
        String[] parts = fields[2].split("\\.");
        try {
            Instant birth = Instant.ofEpochSecond(Long.parseLong(parts[0]), Long.parseLong(parts[1]));
            if (!birth.isAfter(Instant.EPOCH)) {
                throw new IOException("macOS storage birth time is unavailable");
            }
            return birth.toString();
        } catch (NumberFormatException | java.time.DateTimeException error) {
            throw new IOException("macOS storage birth time is invalid", error);
        }
    }

    static String parseMachineId(String output) throws IOException {
        var matcher = PLATFORM_UUID.matcher(output);
        if (!matcher.find()) {
            throw new IOException("macOS hardware identity is unavailable");
        }
        String value = uuid(matcher.group(1));
        if (matcher.find()) {
            throw new IOException("macOS hardware identity is ambiguous");
        }
        return value;
    }

    private static String uuid(String value) throws IOException {
        if (!value.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
                || "00000000-0000-0000-0000-000000000000".equals(value)) {
            throw new IOException("macOS native identity is invalid");
        }
        return value;
    }

    static String read(String... command) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.environment().put("LC_ALL", "C");
        Process process = builder.start();
        try {
            process.getOutputStream().close();
            if (!process.waitFor(5, TimeUnit.SECONDS) || process.exitValue() != 0) {
                throw new IOException("macOS native identity probe failed");
            }
            byte[] output = process.getInputStream().readNBytes(MAX_BYTES + 1);
            if (output.length > MAX_BYTES) {
                throw new IOException("macOS native identity exceeds its size limit");
            }
            return new String(output, StandardCharsets.UTF_8).strip();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("macOS native identity probe interrupted", error);
        } finally {
            process.destroyForcibly();
            process.getInputStream().close();
            process.getErrorStream().close();
        }
    }
}
