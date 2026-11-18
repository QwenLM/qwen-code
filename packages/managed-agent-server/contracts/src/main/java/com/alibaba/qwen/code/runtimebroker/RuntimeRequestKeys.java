package com.alibaba.qwen.code.runtimebroker;

import org.apache.commons.codec.digest.DigestUtils;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

public final class RuntimeRequestKeys {
    private RuntimeRequestKeys() { }

    public static String requestKey(RuntimeProvisionRequest request) {
        RuntimeScope scope = request.getScope();
        if (request.isManagedContext()) {
            return digest("managed-context/1", scope.getTenantId(),
                    scope.getWorkspaceId(), scope.getWorkspaceGeneration(),
                    scope.getCanonicalCwd(), scope.getCapabilityDigest(),
                    scope.getIsolationClass(), request.getIsolationKey(),
                    request.getProvisionerKind(), request.getStorageId());
        }
        return digest(scope.getTenantId(), scope.getWorkspaceId(),
                scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass(),
                request.getIsolationKey(), request.getProvisionerKind());
    }

    public static String scopeKey(RuntimeScope scope) {
        return digest(scope.getTenantId(), scope.getWorkspaceId(),
                scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass());
    }

    public static String valueKey(String value) {
        return digest(value);
    }

    private static String digest(String... values) {
        MessageDigest digest = DigestUtils.getSha256Digest();
        for (String value : values) {
            if (value == null) {
                digest.update(ByteBuffer.allocate(Integer.BYTES)
                        .putInt(-1).array());
            } else {
                byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                digest.update(ByteBuffer.allocate(Integer.BYTES)
                        .putInt(bytes.length).array());
                digest.update(bytes);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
