package com.alibaba.qwen.code.managedagent.store;

import com.aliyun.oss.ClientConfiguration;
import com.aliyun.oss.ClientException;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.model.BucketVersioningConfiguration;
import com.aliyun.oss.model.CannedAccessControlList;
import com.aliyun.oss.model.ObjectMetadata;
import com.aliyun.oss.model.PutObjectRequest;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;

/** Private OSS profile: immutable keys in a bucket that has never enabled versioning. */
public final class AliyunToolPublicationObjectStore implements ToolPublicationObjectStore {
    private static final Set<String> TRANSIENT_CLIENT_ERRORS = Set.of(
            "ConnectionTimeout", "SocketTimeout", "ConnectionRefused",
            "UnknownHost", "SocketException", "SslException");
    private static final Set<String> TRANSIENT_SERVICE_ERRORS = Set.of("InternalError", "ServiceUnavailable");
    private final OSS client;
    private final String bucket;

    public AliyunToolPublicationObjectStore(OSS client, String bucket) {
        this.client = Objects.requireNonNull(client);
        this.bucket = Objects.requireNonNull(bucket);
        requireUnversioned();
        if (read(() -> client.getBucketAcl(bucket), () -> {}).getCannedACL() != CannedAccessControlList.Private) {
            throw new IllegalStateException("Tool publication bucket must be private");
        }
    }

    @Override
    public void requireUnversioned() {
        requireUnversioned(() -> {});
    }

    private void requireUnversioned(Runnable guard) {
        BucketVersioningConfiguration versioning = read(() -> client.getBucketVersioning(bucket), guard);
        String state = versioning == null ? null : versioning.getStatus();
        if (BucketVersioningConfiguration.ENABLED.equals(state)
                || BucketVersioningConfiguration.SUSPENDED.equals(state)) {
            throw new IllegalStateException("Tool publication bucket cannot enforce immutable objects");
        }
    }

    @Override
    public void putIfAbsent(String key, byte[] bytes) {
        requireUnversioned();
        ObjectMetadata metadata = new ObjectMetadata();
        metadata.setContentLength(bytes.length);
        metadata.setHeader("x-oss-forbid-overwrite", "true");
        PutObjectRequest request = new PutObjectRequest(bucket, key, new ByteArrayInputStream(bytes));
        request.setMetadata(metadata);
        try {
            client.putObject(request);
        } catch (OSSException error) {
            if (!"FileAlreadyExists".equals(error.getErrorCode())) {
                throw error;
            }
        }
    }

    @Override
    public InputStream open(String key) {
        return open(key, () -> {});
    }

    @Override
    public InputStream open(String key, Runnable guard) {
        requireUnversioned(guard);
        return read(() -> client.getObject(bucket, key), guard).getObjectContent();
    }

    private <T> T read(Supplier<T> request, Runnable guard) {
        for (int retries = 0; ; retries++) {
            guard.run();
            try {
                return request.get();
            } catch (OSSException error) {
                if (retries >= ClientConfiguration.DEFAULT_MAX_RETRIES
                        || error.getErrorCode() == null
                        || !TRANSIENT_SERVICE_ERRORS.contains(error.getErrorCode())) {
                    throw error;
                }
            } catch (ClientException error) {
                if (retries >= ClientConfiguration.DEFAULT_MAX_RETRIES
                        || error.getErrorCode() == null
                        || !TRANSIENT_CLIENT_ERRORS.contains(error.getErrorCode())) {
                    throw error;
                }
            }
            try {
                Thread.sleep(100L << retries);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Publication read retry interrupted", error);
            }
        }
    }
}
