package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Returns one preconfigured Runtime lease for contract tests and first integration. */
public final class StaticRuntimeProvisioner implements RuntimeProvisioner {
    private final RuntimeLease lease;

    public StaticRuntimeProvisioner(RuntimeLease lease) {
        if (lease == null) {
            throw new IllegalArgumentException("lease is required");
        }
        this.lease = lease;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        RuntimeScope scope = request.getScope();
        if ("session".equals(scope.getIsolationClass())) {
            throw new IllegalArgumentException(
                    "Static Runtime cannot provide Session isolation");
        }
        return CompletableFuture.completedFuture(lease);
    }

    @Override
    public String kind() {
        return "static";
    }

    @Override
    public String placementDomain() {
        return "static:" + digest(lease.getEndpoint().toString());
    }

    @Override
    public String runtimeTemplateDigest() {
        return "sha256:" + digest(lease.getRuntimeInstanceId(),
                lease.getEndpoint().toString(), lease.getToken(),
                lease.getLeaseId(), Long.toString(lease.getEpoch()));
    }

    private static String digest(String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String value : values) {
                byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                digest.update((byte) (bytes.length >>> 24));
                digest.update((byte) (bytes.length >>> 16));
                digest.update((byte) (bytes.length >>> 8));
                digest.update((byte) bytes.length);
                digest.update(bytes);
            }
            byte[] hash = digest.digest();
            StringBuilder encoded = new StringBuilder(hash.length * 2);
            for (byte value : hash) {
                encoded.append(Character.forDigit((value >>> 4) & 0xf, 16));
                encoded.append(Character.forDigit(value & 0xf, 16));
            }
            return encoded.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable",
                    exception);
        }
    }
}
