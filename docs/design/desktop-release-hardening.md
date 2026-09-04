# Desktop release hardening

The Desktop release should preserve the last complete bundled runtime until a replacement is fully assembled, recover that runtime on the next run if a swap is interrupted, reuse a Node.js archive verified against a fresh official checksum, and publish only installer/updater artifacts. Published prereleases must use a SemVer prerelease suffix so a later stable build has a strictly newer updater version.

Stable releases continue to mirror versioned assets to Aliyun OSS before advancing the OSS latest manifest. A normal release run now fails if the GitHub stable feed does not match the version it just published; manual backfills of older releases still leave the latest feed unchanged.

Verification covers the release workflow contracts, the Desktop release helpers, runtime smoke checks, and a dry-run installer build.
