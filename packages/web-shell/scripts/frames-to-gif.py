#!/usr/bin/env python3
"""Assemble labeled demo GIF frames for the collapsed-groups persistence story.

Requires: pip install Pillow
"""
from __future__ import annotations

import sys
from pathlib import Path

# Requires: pip install Pillow
from PIL import Image, ImageDraw, ImageFont


CAPTIONS = {
    "01-expanded.png": "1. Backend is expanded",
    "02-collapsed.png": "2. Collapse Backend",
    "03-after-reload.png": "4. After reload: still collapsed",
}


def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def annotate(image: Image.Image, caption: str) -> Image.Image:
    """Pad a caption bar above the sidebar crop so the demo story is readable."""
    bar_height = 56
    canvas = Image.new("RGBA", (image.width, image.height + bar_height), (18, 18, 18, 255))
    canvas.paste(image, (0, bar_height))
    draw = ImageDraw.Draw(canvas)
    font = load_font(22)
    draw.rectangle((0, 0, canvas.width, bar_height), fill=(32, 32, 36, 255))
    draw.text((16, 16), caption, fill=(245, 245, 247, 255), font=font)
    return canvas


def make_reload_frame(width: int, height: int) -> Image.Image:
    """Explicit reload beat so viewers don't mistake remount for a no-op."""
    canvas = Image.new("RGBA", (width, height), (12, 12, 14, 255))
    draw = ImageDraw.Draw(canvas)
    font = load_font(24)
    caption = "3. Reload the page..."
    bbox = draw.textbbox((0, 0), caption, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    draw.text(
        ((width - text_width) / 2, (height - text_height) / 2),
        caption,
        fill=(245, 245, 247, 255),
        font=font,
    )
    return canvas


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: frames-to-gif.py <frames-dir> <output.gif>", file=sys.stderr)
        return 1

    frames_dir = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    ordered_names = ["01-expanded.png", "02-collapsed.png", "03-after-reload.png"]
    frame_paths = [frames_dir / name for name in ordered_names if (frames_dir / name).exists()]
    if len(frame_paths) < 3:
        print(f"Expected 01/02/03 PNG frames in {frames_dir}", file=sys.stderr)
        return 1

    annotated = [
        annotate(Image.open(path).convert("RGBA"), CAPTIONS[path.name])
        for path in frame_paths
    ]
    width = min(image.width for image in annotated)
    height = min(image.height for image in annotated)
    cropped = [image.crop((0, 0, width, height)) for image in annotated]
    reload_frame = make_reload_frame(width, height)

    # Story: expanded → collapsed → reload beat → still collapsed after reload.
    frames = [cropped[0], cropped[1], reload_frame, cropped[2]]
    durations_ms = [2200, 2200, 1400, 2800]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    first, *rest = frames
    first.save(
        output_path,
        save_all=True,
        append_images=rest,
        duration=durations_ms,
        loop=0,
        disposal=2,
        optimize=False,
    )
    print(f"Wrote {output_path} from {len(frames)} frame(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
