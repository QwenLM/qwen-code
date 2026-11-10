package com.alibaba.qwen.code.managedagent.adapters.artifact;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationStorageException;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;
import com.aliyun.oss.OSSException;

import java.io.InputStream;
import java.util.function.Supplier;

public final class AliyunImmutableObjectStore implements ImmutableObjectStore {
    private final AliyunObjectStoreClient client;
    private final AliyunToolPublicationObjectStore objects;
    private final String identity;

    AliyunImmutableObjectStore(AliyunObjectStoreClient client, String region, String bucket) {
        this.client = client;
        this.objects = client.objects(bucket);
        this.identity = "aliyun-oss:" + region + ":" + bucket;
    }

    @Override
    public String identity() {
        return identity;
    }

    @Override
    public void putIfAbsent(String key, InputStream source, long length, Runnable guard) {
        translate(() -> {
            objects.putIfAbsent(key, source, length, guard);
            return null;
        }, true);
    }

    @Override
    public InputStream open(String key, Runnable guard) {
        return translate(() -> objects.open(key, guard), false);
    }

    @Override
    public void deleteIfPresent(String key, Runnable guard) {
        translate(() -> {
            objects.deleteIfPresent(key, guard);
            return null;
        }, false);
    }

    @Override
    public void validateConfiguration() {
        translate(() -> {
            objects.validateConfiguration();
            return null;
        }, false);
    }

    @Override
    public void close() {
        client.close();
    }

    private static <T> T translate(Supplier<T> operation, boolean writing) {
        try {
            return operation.get();
        } catch (ToolPublicationStorageException error) {
            var reason = writing ? ObjectStorageException.Reason.WRITE_OUTCOME_UNKNOWN
                    : ObjectStorageException.Reason.UNAVAILABLE;
            if (error.getCause() instanceof OSSException service) {
                if ("NoSuchKey".equals(service.getErrorCode())) {
                    reason = ObjectStorageException.Reason.NOT_FOUND;
                } else if ("FileAlreadyExists".equals(service.getErrorCode())) {
                    reason = ObjectStorageException.Reason.ALREADY_EXISTS;
                } else if ("AccessDenied".equals(service.getErrorCode())) {
                    reason = ObjectStorageException.Reason.ACCESS_DENIED;
                }
            }
            throw new ObjectStorageException(reason, error);
        }
    }
}
