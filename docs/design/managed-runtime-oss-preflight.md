# Authenticated OSS preflight for Managed runtime releases

[English](managed-runtime-oss-preflight.md) | [简体中文](managed-runtime-oss-preflight.zh-CN.md)

## Problem and scope

Anonymous OSS GET can return `403 AccessDenied` for an absent object under the
bucket ACL. Treating that response as missing would also permit overwriting an
inaccessible existing release. Only the Managed runtime release preflight changes;
Java artifacts, product code, public verification, and publication immutability
checks remain unchanged.

## Decision

Keep the artifact checkout pinned to the release's `SOURCE_SHA`. Separately check
out `scripts` from `github.workflow_sha` into the already ignored
`.qwen/managed-release-tools` directory, without persisted credentials. Run the
release helper there so backfills of old tags can use the new preflight. Its
imports resolve through the root installation; the source checkout, Git metadata,
version, and build timestamp remain unchanged.

Install the existing SHA-256-pinned ossutil 1.7.19 and configure its existing
production-release credentials before preflight. Use the same bucket, object key,
and configuration for preflight and upload. Create the configuration with
`umask 077`; dry runs skip both setup and authenticated reads.

Add `--check-oss OSS_URL --config PATH --file PATH` to the release helper. Accept
only an `oss://bucket/object` URL without credentials, port, query, or fragment.
Run `ossutil cat` without a shell, writing stdout into a private temporary file,
with a 300-second timeout and bounded stderr. This command cannot write remotely.

The pinned [cat implementation](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/cat.go)
calls `GetObject`, copies raw bytes to stdout, and appends one newline. The
[command wrapper](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/command_manager.go#L57)
then prints `\n%.6f(s) elapsed\n`. Read at most 64 trailer bytes after the expected
artifact size and require precisely `\n\n<seconds>.<6 digits>(s) elapsed\n`.
Remove that trailer and compare SHA-256 using the existing helper. This also detects truncated output even though
this version of cat ignores the `io.Copy` error. Original terminal newlines are
preserved. Always remove the temporary download.

`cp` is unsuitable here: its [download precheck](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/cp.go#L2489)
uses [GetObjectDetailedMeta](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/command.go#L658),
a HEAD request, whose empty error body cannot reliably distinguish missing keys.
The CLI [prints errors on stdout and exits 1](https://github.com/aliyun/ossutil/blob/v1.7.19/ossutil.go).
Only exit 1 with the complete canonical line beginning
`Error: oss: service returned error: StatusCode=404, ErrorCode=NoSuchKey, ErrorMessage=`
is missing. The format comes from its pinned
[OSS SDK v3.0.2](https://github.com/aliyun/aliyun-oss-go-sdk/blob/v3.0.2/oss/error.go).
Read at most 16 KiB of error output. AccessDenied, NoSuchBucket, unstructured 404,
network errors, subprocess errors, timeouts, and mismatched bytes fail closed.
Do not echo subprocess diagnostics or credentials.

## Verification and limits

Real subprocess shims cover identical binary bytes, terminal newlines, exact
NoSuchKey/404, other error classes, mismatches, timeout, spawn failure, argument
validation, and download cleanup. Workflow tests enforce setup order, pinned
uploader, credential/configuration reuse, dry-run guards, and final public HTTPS
verification. A local old-tag fixture checks that the workflow-selected helper runs
with root dependencies while the old helper remains unchanged. The new behavioral tests fail against the original script because
`--check-oss` is unsupported, then pass with the fix.

No real credentials, authenticated remote requests, workflow dispatch, or
publication are part of local validation. Actual OSS access still depends on the
existing credential permissions; insufficient access deliberately fails the
release. Upgrading ossutil requires rechecking its stdout and error contracts.
