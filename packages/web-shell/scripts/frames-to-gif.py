#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: frames-to-gif.py <frames-dir> <output.gif>", file=sys.stderr)
        return 1

    frames_dir = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    frame_paths = sorted(frames_dir.glob("*.png"))
    if not frame_paths:
        print(f"No PNG frames found in {frames_dir}", file=sys.stderr)
        return 1

    # Hold each step long enough to read in the PR demo.
    durations_ms = [1800, 1800, 2600]
    images = [Image.open(path).convert("RGBA") for path in frame_paths]
    width = min(image.width for image in images)
    height = min(image.height for image in images)
    cropped = [image.crop((0, 0, width, height)) for image in images]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    first, *rest = cropped
    durations = durations_ms[: len(cropped)]
    first.save(
        output_path,
        save_all=True,
        append_images=rest,
        duration=durations,
        loop=0,
        disposal=2,
        optimize=False,
    )
    print(f"Wrote {output_path} from {len(cropped)} frame(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
