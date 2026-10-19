package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.transport.CsiInstalledByteObservation;

/** Fixed expectations for explicit synthetic source/7 data; no installation is qualified. */
public final class WorkspaceCsiInstalledByteTestInputs {
    private WorkspaceCsiInstalledByteTestInputs() { }

    public static WorkspaceCsiNodeSourceStore.InstalledBytes reviewed() {
        return new WorkspaceCsiNodeSourceStore.InstalledBytes(
                new CsiInstalledByteObservation("qwen-k2-installed-byte-observation/1", "source",
                        "4869b284fb6a64756fc229bc1e86d65811daece561e41560d44e959f23b6dfa2", "amd64",
                        "29926eefe6cb0793560b05a8110c1a84f0c99a1fd6234c03089cd4f5dc5164d4", 1, "/etc/qwen-k2/source.json",
                        "9afeebc0ab198b5720067cae88db75bb13827256cb567b4ac28005cf2954635c",
                        "ea04fefd341a1d95be7d77dad491d687cb6672044d438ea54dcfa553ee5ddbe7",
                        "/etc/systemd/system/qwen-k2-node-source.service",
                        "884856551ae15ea498baec97da7fd701eb2ba6d34bb479128ab5e3d48d28f2f1"),
                new CsiInstalledByteObservation("qwen-k2-installed-byte-observation/1", "gateway",
                        "4869b284fb6a64756fc229bc1e86d65811daece561e41560d44e959f23b6dfa2", "amd64",
                        "29926eefe6cb0793560b05a8110c1a84f0c99a1fd6234c03089cd4f5dc5164d4", 1, "/etc/qwen-k2/gateway.json",
                        "036132a42d9505e1a1c598e2391101deab06804b7fe5503f45f812cdd856ca7f",
                        "ea04fefd341a1d95be7d77dad491d687cb6672044d438ea54dcfa553ee5ddbe7",
                        "/etc/systemd/system/qwen-k2-runtime-gateway.service",
                        "bc5c0246f1829c56130d3258f02230abde0b23acb08b2ed543a94192fec0b35d"),
                "9b708410aba7b052123d3587bb1da188297ccf06835964ca7fb15cdbc463d0a8",
                "839f93d1315d708b3d32845d7ccdaad3ec921c8fc705e8b91d725d34896e4b24");
    }
}
