package com.alibaba.qwen.code.managedagent.contracts.extensions;

import java.io.IOException;
import java.util.List;

/** Optional discovery on an application-owned source. Entries must be authorized for the supplied context. */
public interface ManagedSkillCatalogSource extends ManagedExtensionSource {
    List<Entry> catalog(Context context) throws IOException;

    record Entry(Reference reference, ManagedExtensionPackages.Target target,
            String name, String description, boolean preinstall) { }
}
