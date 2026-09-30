package com.alibaba.qwen.code.managedagent.store;

import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.model.BucketVersioningConfiguration;
import com.aliyun.oss.model.CannedAccessControlList;
import com.aliyun.oss.model.ObjectMetadata;
import com.aliyun.oss.model.PutObjectRequest;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Objects;

/** Private OSS profile: immutable keys in a bucket that has never enabled versioning. */
public final class AliyunToolPublicationObjectStore implements ToolPublicationObjectStore {
    private final OSS client;
    private final String bucket;

    public AliyunToolPublicationObjectStore(OSS client, String bucket) {
        this.client = Objects.requireNonNull(client);
        this.bucket = Objects.requireNonNull(bucket);
        requireUnversioned();
        if (client.getBucketAcl(bucket).getCannedACL() != CannedAccessControlList.Private) {
            throw new IllegalStateException("Tool publication bucket must be private");
        }
    }

    @Override
    public void requireUnversioned() {
        BucketVersioningConfiguration versioning = client.getBucketVersioning(bucket);
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
    public void deleteIfPresent(String key) {
        requireUnversioned();
        client.deleteObject(bucket, key);
    }

    @Override
    public InputStream open(String key) {
        requireUnversioned();
        return client.getObject(bucket, key).getObjectContent();
    }
}
