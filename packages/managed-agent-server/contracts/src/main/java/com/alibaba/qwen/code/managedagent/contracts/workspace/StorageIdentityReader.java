package com.alibaba.qwen.code.managedagent.contracts.workspace;

import java.io.IOException;
import java.nio.file.Path;
public interface StorageIdentityReader {
    record Identity(String root, String hostId, String device, String inode, String birthTime) { }
    Identity read(Path root) throws IOException;
}
