# K2 offline installation and cold-bootstrap software

[English](README.md) | [简体中文](README.zh-CN.md)

This directory contains the fourth software slice of [#13526](https://github.com/QwenLM/qwen-code/pull/13526). It consumes the node-evidence slice's strict Go/Java contracts. Read the complete [English design](../../docs/design/2026-10-20-k2-installation-cold-bootstrap.md) or [Chinese design](../../docs/design/2026-10-20-k2-installation-cold-bootstrap.zh-CN.md) before reviewing the pipeline.

The tools produce offline candidates. They do not install files, load or lock host policy, reboot a node, publish an image, or qualify physical release. The fixed cold endpoint starts only an empty systemd target. Source/gateway service templates are retained candidate inputs; they are not enabled by that endpoint. Native acceptance remains `NOT_RUN`.

## Pipeline

Run each Python entry with `python3 <entry> --help` for its complete required inputs. The pipeline requires explicitly reviewed bytes and fresh output directories; unsupported, missing or changed inputs refuse rather than fall back.

| Entry                    | Inputs and result                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package-worker.py`      | An independently pinned Node 22 OCI base and prebuilt worker bundle produce an unpublished worker OCI layout. Docker gzip layer descriptors are normalized without changing their bytes. It does not build the bundle or invoke the container runtime. |
| `image-catalog.py`       | Review a concrete OCI manifest, complete layers and creation contract without extracting or executing the image.                                                                                                                                       |
| `render-pre-exec.py`     | Bind the source/shim/runc ELF bytes and both image catalogues to the fixed creation contract.                                                                                                                                                          |
| `render-cold-boot.py`    | Check the exact supported base initrd and independently extracted inputs, static loader ELF and rootfs dependency bytes; produce the hardened overlay and cold contract.                                                                               |
| `render-profiles.py`     | Bind the pre-exec candidate, cold contract, target, runtime, source/gateway configurations and six reviewed host bases to the complete eleven-profile candidate.                                                                                       |
| `compile-profiles.py`    | Invoke the explicitly pinned target parser with fixed feature inputs, empty configuration, no cache and no kernel load; preserve attempts and actual stderr. A successful record describes byte production, not policy enforcement.                    |
| `k2-assemble-artifacts`  | The Go command validates the pre-exec/profile/compile directories against reviewed digests and writes exactly 26 installed candidate files. Build it from `packages/k2-node-evidence/cmd/k2-assemble-artifacts`.                                       |
| `package-cold-initrd.py` | Revalidate the candidate and closed installation graph, regenerate the hardened script bytes, and emit the final initrd, rootfs payload, preconditions, fixed command line and external inventory.                                                     |

The cold renderer reads the shared lane at `packages/k2-node-evidence/internal/artifactset/cold-lane.json`. Keep these tools with that repository layout. Generator hashes bind the actual tool bytes. The final initrd digest is outside its input graph, avoiding a digest cycle. Packaged preconditions still require a separately reviewed immutable installation and native boot trial; a generated inventory grants no authority.

## Software verification

From the repository root:

```sh
python3 -m unittest discover -s deploy/k2-evidence -p 'test_*.py' -v
npm run test:scripts -- scripts/tests/k2-node-evidence-workflow.test.js
```

From `packages/k2-node-evidence`:

```sh
go test -mod=readonly -count=1 ./internal/... ./cmd/k2-assemble-artifacts
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -mod=readonly ./...
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -mod=readonly ./...
```

Linux CI additionally runs `go test -mod=readonly -count=1 ./...`, including the cold-init package-private operation fakes. The unmodified Linux root package cannot run on macOS because it depends on Linux source-gateway code. An arm64 build does not add an arm64 native boot lane.

Tests use inert ELF, image, parser metadata and boot fixtures. They exercise actual generator/packager subprocesses and validate bytes, refusal, helper join ordering, short-write/readback failures, capability reduction and descriptor inheritance. Compiler data tests do not execute an actual AppArmor parser. No software test runs the real PID1 entry, loads or locks policy, or demonstrates native systemd/CSI operation.
