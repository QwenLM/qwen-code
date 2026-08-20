/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

/** The value as it will actually be printed, so the unit can be picked from it. */
const roundedTo = (value: number, digits: number): number =>
  Number(value.toFixed(digits));

/**
 * Renders a byte count with a human-readable unit. This is the one
 * implementation: `packages/cli/src/ui/utils/formatters.ts` and
 * `packages/cli/src/serve/env-snapshot.ts` re-use it instead of keeping their
 * own copies, so the same byte count cannot format differently depending on
 * which code path prints it.
 */
export const formatMemoryUsage = (bytes: number): string => {
  // The unit is chosen from the rounded figure rather than the raw byte
  // count. Rounding to one decimal can carry a value up to the next unit's
  // boundary, and testing the raw count then kept the smaller label: 1048575
  // is under a megabyte, so it took the KB branch and printed "1024.0 KB" --
  // a megabyte-sized number wearing a kilobyte label. The same happened one
  // byte below a gigabyte, which printed "1024.0 MB".
  if (roundedTo(bytes / BYTES_PER_KB, 1) < 1024) {
    return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  }
  if (roundedTo(bytes / BYTES_PER_MB, 1) < 1024) {
    return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  }
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
};
