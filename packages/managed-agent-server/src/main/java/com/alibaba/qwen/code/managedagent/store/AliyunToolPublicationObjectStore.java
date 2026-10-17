package com.alibaba.qwen.code.managedagent.store;

import com.aliyun.oss.ClientConfiguration;
import com.aliyun.oss.ClientException;
import com.aliyun.oss.HttpMethod;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.common.comm.RequestMessage;
import com.aliyun.oss.common.comm.ResponseMessage;
import com.aliyun.oss.common.comm.RetryStrategy;
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

    public static void configureClientRetries(ClientConfiguration configuration) {
        // A nonzero limit exposes the failed HTTP status to the strategy. The
        // strategy never retries; the guarded read loop owns every new request.
        configuration.setMaxErrorRetry(1);
        configuration.setRetryStrategy(new RetryStrategy() {
            @Override
            public boolean shouldRetry(Exception error, RequestMessage request,
                    ResponseMessage response, int retries) {
                if (error instanceof OSSException service && request != null && response != null
                        && request.getMethod() == HttpMethod.GET
                        && !"InvalidResponse".equals(service.getErrorCode())
                        && (response.getStatusCode() == 500 || response.getStatusCode() == 502
                                || response.getStatusCode() == 503)) {
                    throw new TransientReadException(service);
                }
                return false;
            }
        });
    }

    private static final class TransientReadException extends RuntimeException {
        private final OSSException original;

        private TransientReadException(OSSException original) {
            super(original);
            this.original = original;
        }
    }

    public AliyunToolPublicationObjectStore(OSS client, String bucket) {
        this.client = Objects.requireNonNull(client);
        this.bucket = Objects.requireNonNull(bucket);
        validateConfiguration();
        if (read(() -> client.getBucketAcl(bucket), () -> {}).getCannedACL() != CannedAccessControlList.Private) {
            throw new IllegalStateException("Tool publication bucket must be private");
        }
    }

    @Override
    public void validateConfiguration() {
        validateConfiguration(() -> {});
    }

    private void validateConfiguration(Runnable guard) {
        BucketVersioningConfiguration versioning = read(() -> client.getBucketVersioning(bucket), guard);
        String state = versioning == null ? null : versioning.getStatus();
        if (BucketVersioningConfiguration.ENABLED.equals(state)
                || BucketVersioningConfiguration.SUSPENDED.equals(state)) {
            throw new IllegalStateException("Tool publication bucket cannot enforce immutable objects");
        }
    }

    @Override
    public void putIfAbsent(String key, byte[] bytes) {
        validateConfiguration();
        ObjectMetadata metadata = new ObjectMetadata();
        metadata.setContentLength(bytes.length);
        metadata.setHeader("x-oss-forbid-overwrite", "true");
        PutObjectRequest request = new PutObjectRequest(bucket, key, new ByteArrayInputStream(bytes));
        request.setMetadata(metadata);
        try {
            client.putObject(request);
        } catch (OSSException error) {
            if (!"FileAlreadyExists".equals(error.getErrorCode())) {
                throw storageFailure(error);
            }
        } catch (ClientException error) {
            throw storageFailure(error);
        }
    }

    @Override
    public void deleteIfPresent(String key) {
        validateConfiguration();
        try {
            client.deleteObject(bucket, key);
        } catch (OSSException | ClientException error) {
            throw storageFailure(error);
        }
    }

    @Override
    public InputStream open(String key) {
        return open(key, () -> {});
    }

    @Override
    public InputStream open(String key, Runnable guard) {
        validateConfiguration(guard);
        return read(() -> client.getObject(bucket, key), guard).getObjectContent();
    }

    private <T> T read(Supplier<T> request, Runnable guard) {
        for (int retries = 0; ; retries++) {
            guard.run();
            try {
                return request.get();
            } catch (TransientReadException error) {
                if (retries >= ClientConfiguration.DEFAULT_MAX_RETRIES) {
                    throw storageFailure(error.original);
                }
            } catch (OSSException error) {
                if (retries >= ClientConfiguration.DEFAULT_MAX_RETRIES
                        || error.getErrorCode() == null
                        || !TRANSIENT_SERVICE_ERRORS.contains(error.getErrorCode())) {
                    throw storageFailure(error);
                }
            } catch (ClientException error) {
                if (retries >= ClientConfiguration.DEFAULT_MAX_RETRIES
                        || error.getErrorCode() == null
                        || !TRANSIENT_CLIENT_ERRORS.contains(error.getErrorCode())) {
                    throw storageFailure(error);
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

    private static ToolPublicationStorageException storageFailure(RuntimeException error) {
        var reason = error instanceof OSSException service && "AccessDenied".equals(service.getErrorCode())
                ? ToolPublicationStorageException.Reason.ACCESS_DENIED : ToolPublicationStorageException.Reason.FAILURE;
        return new ToolPublicationStorageException(reason, error);
    }
}
