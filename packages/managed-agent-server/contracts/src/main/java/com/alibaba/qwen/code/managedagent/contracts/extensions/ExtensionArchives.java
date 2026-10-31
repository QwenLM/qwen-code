package com.alibaba.qwen.code.managedagent.contracts.extensions;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;

public interface ExtensionArchives {
    public boolean configured();
    public long put(String tenant, String workspace, String digest, InputStream archive) throws IOException;
    public Path verify(String tenant, String workspace, String digest, long expectedLength) throws IOException;
}
