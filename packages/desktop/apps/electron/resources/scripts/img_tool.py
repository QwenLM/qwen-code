# /// script
# requires-python = ">=3.12"
# dependencies = ["Pillow>=12.1,<13", "click>=8.3,<9"]
# ///
"""Image processing tool.

Commands: resize, crop, rotate, convert, info, watermark, composite.

Usage:
    uv run img_tool.py COMMAND [OPTIONS]
"""

import json
import sys
from pathlib import Path

import click
from PIL import Image, ImageDraw, ImageFont, ExifTags


def write_output(text: str, output_path: str | None) -> None:
    """Write text to file or stdout."""
    if output_path:
        Path(output_path).write_text(text, encoding="utf-8")
        click.echo(f"Output written to {output_path}", err=True)
    else:
        click.echo(text)


def infer_format(path: str) -> str | None:
    """Infer image format from file extension."""
    ext = Path(path).suffix.lower()
    format_map = {
        ".jpg": "JPEG",
        ".jpeg": "JPEG",
        ".png": "PNG",
        ".gif": "GIF",
        ".bmp": "BMP",
        ".tiff": "TIFF",
        ".tif": "TIFF",
        ".webp": "WEBP",
        ".ico": "ICO",
    }
    return format_map.get(ext)


def save_image(img: Image.Image, output: str) -> None:
    """Save an image, inferring format from extension."""
    fmt = infer_format(output)
    save_kwargs: dict[str, object] = {}
    if fmt == "JPEG":
        # JPEG does not support alpha, convert if needed
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        save_kwargs["quality"] = 95
    if fmt:
        img.save(output, format=fmt, **save_kwargs)
    else:
        img.save(output, **save_kwargs)
    click.echo(f"Image saved to {output}", err=True)


@click.group()
def cli() -> None:
    """Image processing tool."""
    pass


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--width", type=int, default=None, help="Target width in pixels.")
@click.option("--height", type=int, default=None, help="Target height in pixels.")
@click.option("--scale", type=float, default=None, help="Scale factor (e.g. 0.5 for half size).")
@click.option("--keep-aspect/--no-keep-aspect", default=True, help="Maintain aspect ratio (default: yes).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output image file path.")
def resize(file: str, width: int | None, height: int | None, scale: float | None, keep_aspect: bool, output: str) -> None:
    """Resize an image.

    Specify --width and/or --height, or use --scale for proportional resizing.
    """
    try:
        img = Image.open(file)
        orig_w, orig_h = img.size

        if (width is not None and width <= 0) or (height is not None and height <= 0):
            click.echo("Error: --width and --height must be positive.", err=True)
            sys.exit(1)

        if scale is not None:
            if scale <= 0:
                click.echo("Error: --scale must be positive.", err=True)
                sys.exit(1)
            new_w = int(orig_w * scale)
            new_h = int(orig_h * scale)
        elif width is not None and height is not None:
            if keep_aspect:
                ratio = min(width / orig_w, height / orig_h)
                new_w = int(orig_w * ratio)
                new_h = int(orig_h * ratio)
            else:
                new_w = width
                new_h = height
        elif width is not None:
            ratio = width / orig_w
            new_w = width
            new_h = int(orig_h * ratio)
        elif height is not None:
            ratio = height / orig_h
            new_w = int(orig_w * ratio)
            new_h = height
        else:
            click.echo("Error: specify --width, --height, or --scale.", err=True)
            sys.exit(1)

        new_w = max(1, new_w)
        new_h = max(1, new_h)
        resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        save_image(resized, output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--left", type=int, required=True, help="Left pixel coordinate.")
@click.option("--top", type=int, required=True, help="Top pixel coordinate.")
@click.option("--right", type=int, required=True, help="Right pixel coordinate.")
@click.option("--bottom", type=int, required=True, help="Bottom pixel coordinate.")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output image file path.")
def crop(file: str, left: int, top: int, right: int, bottom: int, output: str) -> None:
    """Crop an image to the specified bounding box."""
    try:
        img = Image.open(file)
        w, h = img.size

        # Clamp values
        left = max(0, left)
        top = max(0, top)
        right = min(w, right)
        bottom = min(h, bottom)

        if left >= right or top >= bottom:
            click.echo("Error: invalid crop region (left >= right or top >= bottom).", err=True)
            sys.exit(1)

        cropped = img.crop((left, top, right, bottom))
        save_image(cropped, output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--angle", type=float, required=True, help="Rotation angle in degrees (counter-clockwise).")
@click.option("--expand/--no-expand", default=True, help="Expand canvas to fit rotated image (default: yes).")
@click.option("--fill-color", type=str, default="white", help="Background fill color (default: white).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output image file path.")
def rotate(file: str, angle: float, expand: bool, fill_color: str, output: str) -> None:
    """Rotate an image by the specified angle (counter-clockwise)."""
    try:
        img = Image.open(file)
        rotated = img.rotate(angle, expand=expand, fillcolor=fill_color, resample=Image.Resampling.BICUBIC)
        save_image(rotated, output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--format", "fmt", type=click.Choice(["png", "jpeg", "jpg", "gif", "bmp", "tiff", "webp"]), required=True, help="Target format.")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output image file path.")
def convert(file: str, fmt: str, output: str) -> None:
    """Convert an image to a different format."""
    try:
        img = Image.open(file)

        format_map = {
            "png": "PNG",
            "jpeg": "JPEG",
            "jpg": "JPEG",
            "gif": "GIF",
            "bmp": "BMP",
            "tiff": "TIFF",
            "webp": "WEBP",
        }
        target_fmt = format_map[fmt.lower()]

        if target_fmt == "JPEG" and img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")

        save_kwargs: dict[str, object] = {}
        if target_fmt == "JPEG":
            save_kwargs["quality"] = 95

        img.save(output, format=target_fmt, **save_kwargs)
        click.echo(f"Converted to {target_fmt}, saved to {output}", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), default=None, help="Write output to file.")
def info(file: str, output: str | None) -> None:
    """Show image metadata and information."""
    try:
        img = Image.open(file)
        w, h = img.size

        info_dict: dict[str, object] = {
            "file": str(Path(file).resolve()),
            "format": img.format,
            "mode": img.mode,
            "width": w,
            "height": h,
            "size_bytes": Path(file).stat().st_size,
        }

        # DPI info
        dpi = img.info.get("dpi")
        if dpi:
            info_dict["dpi"] = {"x": dpi[0], "y": dpi[1]}

        # EXIF data
        exif_data = {}
        try:
            exif = img.getexif()
            if exif:
                for tag_id, value in exif.items():
                    tag_name = ExifTags.TAGS.get(tag_id, str(tag_id))
                    try:
                        exif_data[tag_name] = str(value)
                    except Exception:
                        exif_data[tag_name] = repr(value)
        except Exception:
            pass

        if exif_data:
            info_dict["exif"] = exif_data

        # Animation info
        if hasattr(img, "n_frames"):
            info_dict["frames"] = img.n_frames
            info_dict["animated"] = img.n_frames > 1

        write_output(json.dumps(info_dict, indent=2, default=str), output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--text", type=str, required=True, help="Watermark text.")
@click.option("--font-size", type=int, default=36, help="Font size (default: 36).")
@click.option("--opacity", type=int, default=128, help="Opacity 0-255 (default: 128).")
@click.option("--position", type=click.Choice(["center", "bottom-right", "bottom-left", "top-right", "top-left"]), default="center", help="Watermark position.")
@click.option("--color", type=str, default="white", help="Text color (default: white).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output image file path.")
def watermark(file: str, text: str, font_size: int, opacity: int, position: str, color: str, output: str) -> None:
    """Add a text watermark to an image."""
    try:
        img = Image.open(file).convert("RGBA")
        w, h = img.size

        # Create watermark layer
        watermark_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(watermark_layer)

        # Try to use a default font at the specified size
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
        except (IOError, OSError):
            try:
                font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
            except (IOError, OSError):
                try:
                    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", font_size)
                except (IOError, OSError):
                    font = ImageFont.load_default(size=font_size)

        # Get text bounding box
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]

        # Calculate position
        margin = 20
        positions = {
            "center": ((w - text_w) // 2, (h - text_h) // 2),
            "bottom-right": (w - text_w - margin, h - text_h - margin),
            "bottom-left": (margin, h - text_h - margin),
            "top-right": (w - text_w - margin, margin),
            "top-left": (margin, margin),
        }
        x, y = positions[position]

        # Parse color
        try:
            from PIL import ImageColor
            rgb = ImageColor.getrgb(color)
            r, g, b = rgb[0], rgb[1], rgb[2]
        except Exception:
            r, g, b = 255, 255, 255

        draw.text((x, y), text, fill=(r, g, b, opacity), font=font)

        # Composite
        result = Image.alpha_composite(img, watermark_layer)

        # Convert back if needed for output format
        out_fmt = infer_format(output)
        if out_fmt == "JPEG":
            result = result.convert("RGB")

        save_image(result, output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("base_file", type=click.Path(exists=True, dir_okay=False))
@click.argument("overlay_file", type=click.Path(exists=True, dir_okay=False))
@click.option("--x", type=int, default=0, help="X position for overlay (default: 0).")
@click.option("--y", type=int, default=0, help="Y position for overlay (default: 0).")
@click.option("--opacity", type=float, default=1.0, help="Overlay opacity 0-1 (default: 1.0).")
@click.option("--blend", type=float, default=None, help="Blend factor 0-1 (blends entire images equally).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output image file path.")
def composite(base_file: str, overlay_file: str, x: int, y: int, opacity: float, blend: float | None, output: str) -> None:
    """Composite two images together.

    Places OVERLAY_FILE on top of BASE_FILE at the specified position.
    """
    try:
        base = Image.open(base_file).convert("RGBA")
        overlay = Image.open(overlay_file).convert("RGBA")

        if blend is not None:
            # Resize overlay to match base if needed
            if overlay.size != base.size:
                overlay = overlay.resize(base.size, Image.Resampling.LANCZOS)
            result = Image.blend(base, overlay, blend)
        else:
            # Apply opacity to overlay
            if opacity < 1.0:
                alpha = overlay.split()[3]
                alpha = alpha.point(lambda p: int(p * opacity))
                overlay.putalpha(alpha)

            # Paste overlay onto base
            result = base.copy()
            result.paste(overlay, (x, y), overlay)

        out_fmt = infer_format(output)
        if out_fmt == "JPEG":
            result = result.convert("RGB")

        save_image(result, output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


if __name__ == "__main__":
    cli()
