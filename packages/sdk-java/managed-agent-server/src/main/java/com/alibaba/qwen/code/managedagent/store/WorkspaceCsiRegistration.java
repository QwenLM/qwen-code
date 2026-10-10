package com.alibaba.qwen.code.managedagent.store;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

public record WorkspaceCsiRegistration(String tenantId, String storageId,
        String clusterDomain, String namespace, String pvcName, String pvcUid,
        String pvName, String pvUid, String driver, String volumeHandle,
        String backendDomain, String diskSerial, String mountRoot, long revision) {
    public WorkspaceCsiRegistration {
        if (tenantId == null || !tenantId.matches("[A-Za-z0-9._:-]{1,128}")
                || storageId == null || !storageId.matches("[\\x21-\\x7e]{1,256}")
                || revision <= 0) {
            throw invalid();
        }
        text(clusterDomain, 256);
        dns(namespace, 63);
        if (namespace.contains(".")) {
            throw invalid();
        }
        dns(pvcName, 253);
        dns(pvName, 253);
        dns(driver, 253);
        text(pvcUid, 128);
        text(pvUid, 128);
        text(volumeHandle, 512);
        text(backendDomain, 256);
        text(diskSerial, 256);
        text(mountRoot, 2048);
        if (!mountRoot.startsWith("/") || mountRoot.equals("/") || mountRoot.endsWith("/")
                || mountRoot.contains("\\")) {
            throw invalid();
        }
        for (String component : mountRoot.substring(1).split("/", -1)) {
            if (component.isEmpty() || component.equals(".") || component.equals("..")) {
                throw invalid();
            }
        }
    }

    public String aliasKey() {
        return aliasKey(tenantId, storageId);
    }

    static String aliasKey(String tenantId, String storageId) {
        return key("qwen-csi-alias/1", tenantId, storageId);
    }

    public String physicalKey() {
        return com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol.physicalKey(backendDomain, driver, volumeHandle);
    }

    @Override
    public String toString() {
        return "WorkspaceCsiRegistration[redacted]";
    }

    private static String key(String... fields) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String field : fields) {
                byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
                digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
                digest.update(bytes);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static void dns(String value, int maximum) {
        text(value, maximum);
        for (String label : value.split("\\.", -1)) {
            if (!label.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
                throw invalid();
            }
        }
    }

    private static void text(String value, int maximum) {
        if (value == null || value.isBlank() || value.length() > maximum) {
            throw invalid();
        }
        value.codePoints().forEach(point -> {
            if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)
                    || (point >= 0xd800 && point <= 0xdfff)) {
                throw invalid();
            }
        });
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid CSI workspace registration");
    }
}
