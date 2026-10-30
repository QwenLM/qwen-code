package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader.Identity;
import org.apache.commons.codec.digest.HmacAlgorithms;
import org.apache.commons.codec.digest.HmacUtils;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.GeneralSecurityException;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
public final class NativeStorageIdentityReader implements StorageIdentityReader {
    private static final DateTimeFormatter LINUX_BIRTH_TIME_FORMAT = DateTimeFormatter
            .ofPattern("uuuu-MM-dd HH:mm:ss.SSSSSSSSS xx", Locale.ROOT)
            .withResolverStyle(ResolverStyle.STRICT);
    public Identity read(Path root) throws IOException {
        String os = System.getProperty("os.name");
        if (!List.of("Linux", "Mac OS X").contains(os)) {
            throw new IOException("Unsupported mount identity provider");
        }
        Map<String, Object> attributes = Files.readAttributes(root,
                "unix:isDirectory,dev,ino,creationTime,lastModifiedTime", LinkOption.NOFOLLOW_LINKS);
        if (!Boolean.TRUE.equals(attributes.get("isDirectory")) || !root.isAbsolute()
                || !root.equals(root.toRealPath())) {
            throw new IOException("Workspace root is not canonical");
        }
        String device = Long.toUnsignedString(((Number) attributes.get("dev")).longValue());
        String inode = Long.toUnsignedString(((Number) attributes.get("ino")).longValue());
        String birthTime = "Mac OS X".equals(os) ? MacOsHostIdentity.birthTime(root, device, inode)
                : linuxBirthTime(root, device, inode, (FileTime) attributes.get("creationTime"),
                        (FileTime) attributes.get("lastModifiedTime"));
        String machineId = "Mac OS X".equals(os) ? MacOsHostIdentity.machineId()
                : Files.readString(Path.of("/etc/machine-id")).strip();
        if (machineId.isEmpty() || machineId.length() > 256) {
            throw new IOException("Host identity is unavailable");
        }
        String host;
        try {
            host = new HmacUtils(HmacAlgorithms.HMAC_SHA_256,
                    machineId.getBytes(StandardCharsets.UTF_8)).hmacHex(
                            "Qwen-Code/verified-workspace/v2".getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException error) {
            if (error.getCause() instanceof GeneralSecurityException cause) {
                throw new IOException("Host identity is unavailable", cause);
            }
            throw error;
        }
        return new Identity(root.toString(), host, device, inode, birthTime);
    }

    private static String linuxBirthTime(Path root, String device, String inode,
            FileTime creation, FileTime modified) throws IOException {
        if (!creation.equals(modified) || creation.compareTo(FileTime.fromMillis(0)) <= 0) {
            return verifiedBirthTime(creation, modified);
        }
        // A marker write can share the birth clock tick. Confirm the exact root,
        // rather than treating the JDK's possible mtime fallback as birth evidence.
        ProcessBuilder builder = new ProcessBuilder("/usr/bin/stat", "-c", "%d|%i|%w", "--", root.toString())
                .redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.environment().put("LC_ALL", "C");
        builder.environment().put("TZ", "UTC");
        Process process = builder.start();
        try {
            process.getOutputStream().close();
            if (!process.waitFor(5, TimeUnit.SECONDS) || process.exitValue() != 0) {
                throw new IOException("Workspace birth time probe failed");
            }
            byte[] output = process.getInputStream().readNBytes(257);
            if (output.length > 256) {
                throw new IOException("Workspace birth time probe exceeds its size limit");
            }
            return verifiedNativeBirthTime(new String(output, StandardCharsets.UTF_8).strip(),
                    device, inode, creation);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Workspace birth time probe interrupted", error);
        } finally {
            process.destroyForcibly();
            process.getInputStream().close();
            process.getErrorStream().close();
        }
    }

    public static String verifiedNativeBirthTime(String output, String device, String inode,
            FileTime creation) throws IOException {
        String[] fields = output.split("\\|", -1);
        if (fields.length != 3 || !device.equals(fields[0]) || !inode.equals(fields[1])) {
            throw new IOException("Workspace storage identity changed or is unavailable");
        }
        try {
            Instant birth = OffsetDateTime.parse(fields[2], LINUX_BIRTH_TIME_FORMAT).toInstant();
            if (!birth.isAfter(Instant.EPOCH) || !birth.equals(creation.toInstant())) {
                throw new IOException("Workspace birth time is unavailable or ambiguous");
            }
            return creation.toInstant().toString();
        } catch (DateTimeException error) {
            throw new IOException("Workspace native birth time is invalid", error);
        }
    }

    public static String verifiedBirthTime(FileTime creation, FileTime modified) throws IOException {
        // OpenJDK 21 substitutes mtime or epoch when Linux does not provide birth time.
        if (creation.compareTo(FileTime.fromMillis(0)) <= 0 || creation.equals(modified)) {
            throw new IOException("Workspace birth time is unavailable or ambiguous");
        }
        return creation.toInstant().toString();
    }
}
