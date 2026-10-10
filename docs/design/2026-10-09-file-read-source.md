# Complete file reads from one opened source

[English](2026-10-09-file-read-source.md) | [简体中文](2026-10-09-file-read-source.zh-CN.md)

Status: extracted for independent review from the ordinary-source component of [PR #13526](https://github.com/QwenLM/qwen-code/pull/13526), source commit `950950311f102a745556debc261009af677b125c`. This slice builds on current main and does not require the separate CSI mount lifecycle PR #13772.

## 1. Problem and goal

An ordinary `read_file` invocation can stat, classify and read a pathname separately. If that name is replaced between operations, metadata, cache identity and returned content can describe different files. Text, SVG, notebook, images, audio/video and native PDF bytes can all reopen the name; PDF page counting, text extraction and rendering also receive it. The existing bounded text handle operation forces text classification and cannot serve all formats.

Use one opened source throughout the complete read and propagate caller cancellation through PDF work. Retain the source until content processing, any helper processes, cache bookkeeping and final ToolResult construction finish. Preserve existing logical paths, result shapes, supported formats and caller compatibility.

## 2. Source ownership and consumers

`FileSystemService.withReadFile` is an internal callback operation. The request contains the logical path, caller signal and media delivery choice (`inline` or `omni`). The actual ReadFile invocation supplies this choice and enters the producer before cache lookup or content I/O. The callback covers classification, content processing, the PDF vision bridge, cache bookkeeping, memory freshness and result construction.

The source is a closed union of a pathname or a borrowed descriptor plus metadata captured from that descriptor. Standard filesystem is a real producer. Linux and Darwin inline reads stat the path before opening it. A non-regular file, and a regular file whose size is 0, stay on the pathname source and are not opened: special-file open/close has its own side effects, and procfs/sysfs report size 0 while a read-to-EOF still returns bytes. A positive-size regular file opens `O_RDONLY | O_NONBLOCK | O_NOCTTY`, stats that descriptor, and uses the pathname source instead when the opened inode is no longer a positive-size regular file. Otherwise the callback receives the descriptor, which is closed exactly once on every exit. Choosing the pathname source at admission is not a retry after a failed descriptor owner. Acquisition failures retain ordinary in-band file errors. Callback or cleanup failures remain observable; a failed owner never retries by pathname. A failed completion or late cancellation invalidates the unreturned read's cached rights.

The logical path still determines extension, MIME, display and telemetry. Descriptor metadata supplies type, size and cache identity. Image and unknown binary classification uses positional descriptor samples; read failures cannot become successful extension-only classification. Parent byte reads use explicit positions, handle short reads, check cancellation and stop at the captured extent. Growth does not enlarge that extent.

Small text uses the existing complete-buffer encoding decoder and range selection, preserving BOM, UTF-16/32, GBK, line endings and exact line counts. Large text uses the existing positional UTF-8 scanner. The separate security-boundary streaming reader retains its original scan budget. Descriptor reads do not reopen a pathname for line counts or memory freshness metadata. Notebook formatting consumes the admitted string; image overview consumes admitted bytes through the existing decoder and renderer. SVG, raw images/GIF, media and native PDF base64 retain existing decoder and output ceilings.

## 3. Compatibility boundaries

Omni delivery and platforms other than Linux or Darwin keep the pathname source through the same actual Standard producer. Descriptor sources reject Omni pathname delivery. ACP does not implement this callback: its existing text delegation and capability fallback remain on the existing pipeline. An installed producer is never bypassed based on Config, and ACP must not inherit Standard's producer.

The existing pathname entry points for notebook, image overview and PDF remain usable by their other callers. Read-many-files retains its bounded text contract. There are no new runtime selectors, permissions, persistent formats or migrations.

## 4. PDF cancellation and helper lifetime

PDF utilities accept either their existing string source or the borrowed FileHandle. Descriptor calls inherit the original fd through child stdio slot 3 and address the child's own fd: `/proc/self/fd/3` on Linux and `/dev/fd/3` on Darwin. Windows descriptor calls refuse; there is no copied input or fallback to the original pathname.

Descriptor probes and helpers retain their ChildProcess, bound stdout and stderr, and wait for `close` after success, error, cancellation, timeout or output overflow. An exit code alone is insufficient. Stop requests send SIGTERM and escalate to SIGKILL after 100 ms if the direct child has not exited. Cancellation reaches page count, text extraction and page rendering; callers cannot continue into a fallback after cancellation. The descriptor stays owned until the complete callback returns.

Rendered output uses a fresh temporary directory. Descriptor calls retain the output directory fd and verify its named device/inode identity around consumption and cleanup. Linux opens output leaves relative to that fd; Darwin uses the owned temporary name plus identity checks. Unexpected names, symlinks and nonregular leaves refuse. Output consumption and cleanup finish before the callback returns, and uncertain ownership or cleanup failure remains observable. These checks do not provide an atomic pathname cleanup guarantee.

String-source PDF callers retain their existing command runner and shared availability probes. Their actual page count, extraction and rendering receive the caller signal; the new direct-child join guarantee belongs to the descriptor runner. Node 22 [child stdio and close semantics](https://nodejs.org/download/release/v22.14.0/docs/api/child_process.html) and [Linux fd paths](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html) define this boundary.

## 5. Validation and acceptance

First dry-run the global CLI baseline, then compare current-main and candidate compiled product behavior. Deterministically replace a pathname after observation/admission and check original content and metadata across formats. Cover encoding/ranges, short reads, growth, cancellation, acquisition/callback/close errors, PDF inherited fd and delayed close, output caps and output cleanup. Check ordinary Omni, ACP and Windows pathname selection, unchanged text errors and read-many-files scan-budget behavior.

Run build, typecheck, bundle, affected package tests and applicable lint/format. Complete two clean full-diff self-audits and independent code review. Keep fresh baseline and candidate reports separate. Distinguish actual Darwin descriptors and child PIDs, controlled helper programs, mock platform paths, real Poppler and Linux execution; one category cannot qualify another.

Acceptance requires the real ReadFile caller to use the real Standard producer, descriptor consumers to preserve the admitted file identity, cancellation to prevent unreturned result/cache publication, and owned descriptor/helper/output cleanup to finish or surface a failure. An unused optional interface does not satisfy acceptance. Fresh validation results accompany the submitted PR and its separate E2E report.

## 6. Scope and limitations

An opened descriptor preserves the original inode across pathname replacement; it is not an immutable snapshot of same-inode concurrent writes. Captured extent bounds parent byte/text reads, not the inherited native helper's input length. Repeated real Poppler calls must separately verify seeking because inherited descriptors can share a file offset. Direct child close does not prove descendant termination.

CSI admission and confinement, retained file history, private file workers, immutable authorization, Hosted execution, Java/SQL, cold recovery, retirement, NodeUnpublish and volume reuse remain outside this slice. This ordinary producer is not a private mount authority. Real Linux/CSI or cloud acceptance is not inferred from fixtures or local helper tests. No automatic merge or approval is part of extraction.
