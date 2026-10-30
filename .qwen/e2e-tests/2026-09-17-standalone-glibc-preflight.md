# Standalone installer glibc preflight

## Automated verification

Run the focused installer regression test:

```bash
npm run test:scripts -- scripts/tests/install-glibc-preflight.test.js
```

Then run the repository completion gate:

```bash
npm run preflight
```

## Manual scenario

1. On a Linux environment that reports glibc 2.17, run the standalone installer with an explicit release version and the GitHub mirror.
2. Confirm the installer exits before the release archive download starts and reports that the official standalone runtime requires glibc 2.28 or newer.
3. Confirm the error points to `--method npm` only when a Node.js 22+ build compatible with the host is available, or to upgrading the Linux distribution.
4. Repeat on a glibc 2.28-or-newer host and confirm the installer continues into the normal standalone archive download path.
5. On a musl or otherwise unrecognized libc host, confirm the glibc preflight does not reject the host and existing standalone behavior is preserved.
6. Run an offline/custom `--archive` installation and confirm it is not blocked by the official-runtime glibc preflight.

## Regression checks

- glibc 2.17 is rejected before the first release archive download.
- The `ldd --version` fallback rejects an old glibc when `getconf GNU_LIBC_VERSION` is unavailable.
- Unknown libc implementations fail open rather than being guessed as an old glibc.
- glibc 2.28 is accepted.
- macOS and non-Linux targets do not run the glibc check.
- Custom/offline `--archive` installs remain outside the check because their runtime may differ from the official archive.

## Baseline status

Before the fix, the Linux standalone path could install the official archive on CentOS 7 / glibc 2.17 and only fail later when the bundled Node.js runtime started with missing `GLIBC_*` symbols. After the fix, a positively detected glibc version below 2.28 fails early with actionable guidance before the official release archive is downloaded, while supported and unknown-libc paths keep their intended behavior.
