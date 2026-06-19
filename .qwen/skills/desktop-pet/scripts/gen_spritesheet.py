#!/usr/bin/env python3
"""
Desktop Pet Spritesheet Generator for OpenWork.

Generates a 1536×1872 pixel-art chibi spritesheet (8 cols × 9 rows, 192×208 px cells)
customized via a JSON config describing colors, headgear, and features.

Usage:
  python3 gen_spritesheet.py --output ~/.qwen/pets/mychar/spritesheet.webp --config '{...}'
  python3 gen_spritesheet.py --output out.webp --config-file config.json
"""

import argparse
import json
import sys
import math

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("ERROR: Pillow is required. Install with: pip3 install Pillow")
    sys.exit(1)

# --- Atlas layout ---
COLS, ROWS = 8, 9
CW, CH = 192, 208
W, H = COLS * CW, ROWS * CH

# --- Default color palette (Qwen capybara-like neutral) ---
DEFAULT_COLORS = {
    "outfit": [100, 120, 180],
    "outfit_dark": [70, 85, 140],
    "outfit_light": [140, 160, 210],
    "skin": [255, 218, 185],
    "skin_dark": [230, 190, 155],
    "hair": [80, 55, 35],
    "hair_light": [110, 80, 55],
    "accent": [30, 30, 30],
    "shoe": [50, 50, 50],
    "eye": [50, 70, 90],
    "eye_white": [245, 245, 245],
    "blush": [255, 160, 140],
    "mouth": [180, 80, 80],
}

DEFAULT_FEATURES = {
    "headgear": "none",
    "extras": [],
    "number": "",
    "hair_style": "short",
    "helmet_color": None,
}

def tuple_color(c):
    if isinstance(c, list):
        return tuple(c)
    if isinstance(c, str) and c.startswith("#"):
        h = c.lstrip("#")
        return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
    return c

def darken(color, amount=40):
    return tuple(max(0, c - amount) for c in color[:3])

def lighten(color, amount=40):
    return tuple(min(255, c + amount) for c in color[:3])

def fill_rect(draw, x, y, w, h, color):
    draw.rectangle([x, y, x + w - 1, y + h - 1], fill=color)


def draw_headgear(draw, hx, hy, s, colors, features, flip=False):
    """Draw headgear on top of the head."""
    hg = features.get("headgear", "none")
    outfit = colors["outfit"]
    outfit_dark = colors["outfit_dark"]
    helmet_c = tuple_color(features.get("helmet_color") or outfit)

    if hg == "cap":
        cap_y = hy - 7 * s
        fill_rect(draw, hx - 2*s, cap_y, 24*s, 5*s, outfit)
        fill_rect(draw, hx + 2*s, cap_y - 2*s, 16*s, 3*s, outfit)
        fill_rect(draw, hx + 4*s, cap_y - 3*s, 12*s, 2*s, outfit_dark)
        if not flip:
            fill_rect(draw, hx - 4*s, cap_y + 4*s, 26*s, 2*s, outfit_dark)
        else:
            fill_rect(draw, hx - 2*s, cap_y + 4*s, 26*s, 2*s, outfit_dark)
        fill_rect(draw, hx + 7*s, cap_y + s, 6*s, 2*s, colors["accent"])

    elif hg == "helmet":
        cap_y = hy - 8 * s
        fill_rect(draw, hx - 3*s, cap_y, 26*s, 8*s, helmet_c)
        fill_rect(draw, hx + 2*s, cap_y - 2*s, 16*s, 3*s, helmet_c)
        fill_rect(draw, hx + 4*s, cap_y - 3*s, 12*s, 2*s, darken(helmet_c, 20))
        fill_rect(draw, hx, cap_y + 5*s, 20*s, 3*s, darken(helmet_c, 60))
        fill_rect(draw, hx + 2*s, cap_y + 6*s, 16*s, s, lighten(helmet_c, 60))

    elif hg == "hat":
        cap_y = hy - 6 * s
        fill_rect(draw, hx - 4*s, cap_y + 3*s, 28*s, 3*s, outfit_dark)
        fill_rect(draw, hx + 2*s, cap_y - 2*s, 16*s, 6*s, outfit)
        fill_rect(draw, hx + 4*s, cap_y - 3*s, 12*s, 2*s, outfit_dark)

    elif hg == "hood":
        cap_y = hy - 5 * s
        fill_rect(draw, hx - 3*s, cap_y, 26*s, 4*s, outfit)
        fill_rect(draw, hx - 4*s, cap_y + 2*s, 4*s, 8*s, outfit)
        fill_rect(draw, hx + 20*s, cap_y + 2*s, 4*s, 8*s, outfit)
        fill_rect(draw, hx + 4*s, cap_y - 2*s, 12*s, 3*s, outfit_dark)

    elif hg == "crown":
        cap_y = hy - 8 * s
        gold = (255, 215, 0)
        gold_dark = (200, 170, 0)
        fill_rect(draw, hx + 2*s, cap_y + 2*s, 16*s, 4*s, gold)
        fill_rect(draw, hx + 2*s, cap_y, 3*s, 3*s, gold)
        fill_rect(draw, hx + 8*s, cap_y - s, 4*s, 3*s, gold)
        fill_rect(draw, hx + 15*s, cap_y, 3*s, 3*s, gold)
        fill_rect(draw, hx + 3*s, cap_y + s, s, s, (200, 50, 50))
        fill_rect(draw, hx + 9*s, cap_y, 2*s, s, (50, 150, 200))
        fill_rect(draw, hx + 16*s, cap_y + s, s, s, (50, 200, 50))
        fill_rect(draw, hx + 2*s, cap_y + 5*s, 16*s, s, gold_dark)

    elif hg == "horns":
        horn_c = (80, 60, 50)
        fill_rect(draw, hx - 2*s, hy - 6*s, 3*s, 8*s, horn_c)
        fill_rect(draw, hx - 3*s, hy - 8*s, 2*s, 3*s, horn_c)
        fill_rect(draw, hx + 19*s, hy - 6*s, 3*s, 8*s, horn_c)
        fill_rect(draw, hx + 21*s, hy - 8*s, 2*s, 3*s, horn_c)

    elif hg == "ears":
        hair_c = colors["hair"]
        inner = colors["skin"]
        fill_rect(draw, hx - 3*s, hy - 8*s, 5*s, 8*s, hair_c)
        fill_rect(draw, hx - 2*s, hy - 6*s, 3*s, 5*s, inner)
        fill_rect(draw, hx + 18*s, hy - 8*s, 5*s, 8*s, hair_c)
        fill_rect(draw, hx + 19*s, hy - 6*s, 3*s, 5*s, inner)

    elif hg == "halo":
        halo_c = (255, 255, 200)
        cap_y = hy - 10 * s
        fill_rect(draw, hx + 3*s, cap_y, 14*s, 2*s, halo_c)
        fill_rect(draw, hx + 2*s, cap_y + s, s, s, halo_c)
        fill_rect(draw, hx + 17*s, cap_y + s, s, s, halo_c)
        fill_rect(draw, hx + 3*s, cap_y + 2*s, 14*s, s, darken(halo_c, 30))

    elif hg == "headband":
        fill_rect(draw, hx - 2*s, hy - 2*s, 24*s, 2*s, colors["accent"])
        fill_rect(draw, hx + 18*s, hy - 2*s, 4*s, 6*s, colors["accent"])


def draw_extras(draw, cx, cy, s, colors, features, bx, by, expression):
    """Draw extra features like glasses, scarf, tail, wings."""
    extras = features.get("extras", [])
    hx = cx - 10 * s
    hy = cy - 16 * s

    if "glasses" in extras:
        ey = hy + 8 * s
        glass_c = (60, 60, 80)
        fill_rect(draw, hx + 3*s, ey - s, 6*s, 5*s, glass_c)
        fill_rect(draw, hx + 4*s, ey, 4*s, 3*s, (200, 220, 240))
        fill_rect(draw, hx + 11*s, ey - s, 6*s, 5*s, glass_c)
        fill_rect(draw, hx + 12*s, ey, 4*s, 3*s, (200, 220, 240))
        fill_rect(draw, hx + 9*s, ey + s, 2*s, s, glass_c)

    if "scarf" in extras:
        scarf_c = lighten(colors["outfit"], 30)
        fill_rect(draw, bx + 3*s, by - 2*s, 10*s, 3*s, scarf_c)
        fill_rect(draw, bx + 4*s, by + s, 3*s, 6*s, scarf_c)

    if "tail" in extras:
        tail_c = colors["hair"]
        fill_rect(draw, bx + 16*s, by + 10*s, 3*s, 3*s, tail_c)
        fill_rect(draw, bx + 18*s, by + 8*s, 3*s, 3*s, tail_c)
        fill_rect(draw, bx + 20*s, by + 6*s, 3*s, 3*s, tail_c)
        fill_rect(draw, bx + 21*s, by + 4*s, 2*s, 3*s, tail_c)

    if "wings" in extras:
        wing_c = (240, 240, 255)
        wing_dark = (200, 200, 220)
        fill_rect(draw, bx - 6*s, by + 2*s, 5*s, 8*s, wing_c)
        fill_rect(draw, bx - 8*s, by + 4*s, 3*s, 5*s, wing_c)
        fill_rect(draw, bx - 5*s, by + 3*s, 3*s, 5*s, wing_dark)
        fill_rect(draw, bx + 17*s, by + 2*s, 5*s, 8*s, wing_c)
        fill_rect(draw, bx + 21*s, by + 4*s, 3*s, 5*s, wing_c)
        fill_rect(draw, bx + 18*s, by + 3*s, 3*s, 5*s, wing_dark)

    if "sweat_drop" in extras and expression in ("waiting", "failed"):
        fill_rect(draw, hx + 18*s, hy + 2*s, 2*s, 3*s, (150, 200, 255))
        fill_rect(draw, hx + 18*s, hy + s, s, s, (150, 200, 255))


def draw_character(draw, cx, cy, colors, features, scale=3, flip=False,
                   arm_angle=0, leg_offset=0, body_tilt=0, head_tilt=0,
                   expression="normal", arm_wave=False, jump_y=0, collapsed=False):
    """Draw a chibi character centered at (cx, cy)."""
    s = scale
    cy += jump_y

    skin = colors["skin"]
    skin_dark = colors["skin_dark"]
    hair_c = colors["hair"]
    hair_light = colors.get("hair_light", lighten(hair_c, 30))
    outfit = colors["outfit"]
    outfit_dark = colors["outfit_dark"]
    outfit_light = colors["outfit_light"]
    eye_c = colors["eye"]
    eye_w = colors["eye_white"]
    blush_c = colors["blush"]
    mouth_c = colors.get("mouth", darken(skin, 80))
    accent_c = colors["accent"]
    shoe_c = colors["shoe"]

    # --- LEGS ---
    leg_spread = 4 * s
    leg_left_x = cx - leg_spread - 2*s + body_tilt
    leg_right_x = cx + leg_spread - 2*s + body_tilt

    if collapsed:
        fill_rect(draw, leg_left_x, cy + 18*s, 5*s, 6*s, outfit_dark)
        fill_rect(draw, leg_right_x, cy + 18*s, 5*s, 6*s, outfit_dark)
        fill_rect(draw, leg_left_x, cy + 24*s, 5*s, 2*s, shoe_c)
        fill_rect(draw, leg_right_x, cy + 24*s, 5*s, 2*s, shoe_c)
    else:
        fill_rect(draw, leg_left_x + leg_offset, cy + 16*s, 5*s, 10*s, outfit_dark)
        fill_rect(draw, leg_right_x - leg_offset, cy + 16*s, 5*s, 10*s, outfit_dark)
        fill_rect(draw, leg_left_x + leg_offset - s, cy + 26*s, 7*s, 3*s, shoe_c)
        fill_rect(draw, leg_right_x - leg_offset - s, cy + 26*s, 7*s, 3*s, shoe_c)

    # --- BODY ---
    bx = cx - 8*s + body_tilt
    by = cy + 2*s
    fill_rect(draw, bx, by, 16*s, 16*s, outfit)
    fill_rect(draw, bx + s, by + s, 14*s, 2*s, outfit_light)
    fill_rect(draw, bx + 5*s, by - s, 6*s, 2*s, (255, 255, 255))

    # Number on chest
    num = features.get("number", "")
    if num:
        try:
            font_size = max(5 * s, 8)
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
        except Exception:
            font = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), num, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = bx + (16*s - tw) // 2
        ty = by + (14*s - th) // 2 + s
        draw.text((tx, ty), num, fill=accent_c, font=font)

    # Logo area
    if "logo" in features.get("extras", []) and not num:
        fill_rect(draw, bx + 5*s, by + 5*s, 6*s, 4*s, accent_c)
        fill_rect(draw, bx + 6*s, by + 6*s, 4*s, 2*s, outfit_light)

    # --- ARMS ---
    arm_y = by + 3*s
    left_arm_x = bx - 5*s
    right_arm_x = bx + 16*s

    if arm_wave:
        fill_rect(draw, left_arm_x, arm_y + 2*s, 5*s, 8*s, outfit)
        fill_rect(draw, left_arm_x - s, arm_y + 10*s, 5*s, 4*s, skin)
        fill_rect(draw, right_arm_x, arm_y - 8*s, 5*s, 10*s, outfit)
        fill_rect(draw, right_arm_x, arm_y - 10*s, 6*s, 4*s, skin)
    elif arm_angle > 0:
        fill_rect(draw, left_arm_x - arm_angle, arm_y, 5*s, 10*s, outfit)
        fill_rect(draw, left_arm_x - arm_angle - s, arm_y + 10*s, 5*s, 4*s, skin)
        fill_rect(draw, right_arm_x + arm_angle, arm_y, 5*s, 10*s, outfit)
        fill_rect(draw, right_arm_x + arm_angle + s, arm_y + 10*s, 5*s, 4*s, skin)
    else:
        fill_rect(draw, left_arm_x, arm_y, 5*s, 10*s, outfit)
        fill_rect(draw, left_arm_x - s, arm_y + 10*s, 5*s, 4*s, skin)
        fill_rect(draw, right_arm_x, arm_y, 5*s, 10*s, outfit)
        fill_rect(draw, right_arm_x + s, arm_y + 10*s, 5*s, 4*s, skin)

    # --- Scarf (drawn between body and head) ---
    draw_extras(draw, cx, cy, s, colors, features, bx, by, expression)

    # --- HEAD ---
    hx = cx - 10*s + head_tilt
    hy = cy - 16*s

    # Hair back
    fill_rect(draw, hx - s, hy - 2*s, 22*s, 6*s, hair_c)
    # Head shape
    fill_rect(draw, hx, hy, 20*s, 18*s, skin)

    # Hair style
    hair_style = features.get("hair_style", "short")
    if hair_style == "long":
        fill_rect(draw, hx - s, hy - 4*s, 22*s, 6*s, hair_c)
        fill_rect(draw, hx + 2*s, hy - 5*s, 16*s, 3*s, hair_c)
        fill_rect(draw, hx + 4*s, hy - 6*s, 12*s, 2*s, hair_light)
        fill_rect(draw, hx - 2*s, hy, 3*s, 16*s, hair_c)
        fill_rect(draw, hx + 19*s, hy, 3*s, 16*s, hair_c)
        fill_rect(draw, hx - 3*s, hy + 14*s, 4*s, 4*s, hair_c)
        fill_rect(draw, hx + 19*s, hy + 14*s, 4*s, 4*s, hair_c)
    elif hair_style == "spiky":
        fill_rect(draw, hx - s, hy - 4*s, 22*s, 6*s, hair_c)
        fill_rect(draw, hx + s, hy - 7*s, 4*s, 4*s, hair_c)
        fill_rect(draw, hx + 6*s, hy - 8*s, 4*s, 5*s, hair_c)
        fill_rect(draw, hx + 11*s, hy - 7*s, 4*s, 4*s, hair_c)
        fill_rect(draw, hx + 16*s, hy - 6*s, 3*s, 3*s, hair_c)
        fill_rect(draw, hx - 2*s, hy, 3*s, 10*s, hair_c)
        fill_rect(draw, hx + 19*s, hy, 3*s, 10*s, hair_c)
    elif hair_style == "ponytail":
        fill_rect(draw, hx - s, hy - 4*s, 22*s, 6*s, hair_c)
        fill_rect(draw, hx + 2*s, hy - 5*s, 16*s, 3*s, hair_c)
        fill_rect(draw, hx - 2*s, hy, 3*s, 10*s, hair_c)
        fill_rect(draw, hx + 19*s, hy, 3*s, 10*s, hair_c)
        fill_rect(draw, hx + 18*s, hy + 8*s, 3*s, 3*s, hair_c)
        fill_rect(draw, hx + 19*s, hy + 10*s, 3*s, 8*s, hair_c)
        fill_rect(draw, hx + 20*s, hy + 16*s, 2*s, 4*s, hair_light)
    elif hair_style == "bald":
        fill_rect(draw, hx + 2*s, hy - 2*s, 16*s, 2*s, skin_dark)
    else:  # short (default)
        fill_rect(draw, hx - s, hy - 4*s, 22*s, 6*s, hair_c)
        fill_rect(draw, hx + 2*s, hy - 5*s, 16*s, 3*s, hair_c)
        fill_rect(draw, hx + 4*s, hy - 6*s, 12*s, 2*s, hair_light)
        fill_rect(draw, hx - 2*s, hy, 3*s, 10*s, hair_c)
        fill_rect(draw, hx + 19*s, hy, 3*s, 10*s, hair_c)

    # --- FACE ---
    ey = hy + 8*s

    if expression == "blink":
        fill_rect(draw, hx + 4*s, ey + s, 4*s, s, eye_c)
        fill_rect(draw, hx + 12*s, ey + s, 4*s, s, eye_c)
    elif expression == "happy":
        fill_rect(draw, hx + 4*s, ey, 4*s, s, eye_c)
        fill_rect(draw, hx + 3*s, ey + s, s, s, eye_c)
        fill_rect(draw, hx + 8*s, ey + s, s, s, eye_c)
        fill_rect(draw, hx + 12*s, ey, 4*s, s, eye_c)
        fill_rect(draw, hx + 11*s, ey + s, s, s, eye_c)
        fill_rect(draw, hx + 16*s, ey + s, s, s, eye_c)
        fill_rect(draw, hx + 7*s, ey + 5*s, 6*s, s, mouth_c)
        fill_rect(draw, hx + 6*s, ey + 4*s, s, s, mouth_c)
        fill_rect(draw, hx + 13*s, ey + 4*s, s, s, mouth_c)
        fill_rect(draw, hx + 2*s, ey + 3*s, 3*s, 2*s, blush_c)
        fill_rect(draw, hx + 15*s, ey + 3*s, 3*s, 2*s, blush_c)
    elif expression == "sad":
        fill_rect(draw, hx + 4*s, ey, 4*s, 3*s, eye_w)
        fill_rect(draw, hx + 5*s, ey + s, 2*s, 2*s, eye_c)
        fill_rect(draw, hx + 12*s, ey, 4*s, 3*s, eye_w)
        fill_rect(draw, hx + 13*s, ey + s, 2*s, 2*s, eye_c)
        fill_rect(draw, hx + 3*s, ey - 2*s, 5*s, s, hair_c)
        fill_rect(draw, hx + 12*s, ey - 2*s, 5*s, s, hair_c)
        fill_rect(draw, hx + 8*s, ey + 5*s, 4*s, s, mouth_c)
        fill_rect(draw, hx + 7*s, ey + 6*s, s, s, mouth_c)
        fill_rect(draw, hx + 12*s, ey + 6*s, s, s, mouth_c)
    elif expression == "surprised":
        fill_rect(draw, hx + 3*s, ey - s, 5*s, 4*s, eye_w)
        fill_rect(draw, hx + 4*s, ey, 3*s, 3*s, eye_c)
        fill_rect(draw, hx + 5*s, ey + s, s, s, (255, 255, 255))
        fill_rect(draw, hx + 12*s, ey - s, 5*s, 4*s, eye_w)
        fill_rect(draw, hx + 13*s, ey, 3*s, 3*s, eye_c)
        fill_rect(draw, hx + 14*s, ey + s, s, s, (255, 255, 255))
        fill_rect(draw, hx + 8*s, ey + 4*s, 4*s, 3*s, mouth_c)
        fill_rect(draw, hx + 9*s, ey + 5*s, 2*s, s, (180, 80, 80))
    elif expression == "determined":
        fill_rect(draw, hx + 4*s, ey, 4*s, 3*s, eye_w)
        fill_rect(draw, hx + 6*s, ey + s, 2*s, 2*s, eye_c)
        fill_rect(draw, hx + 12*s, ey, 4*s, 3*s, eye_w)
        fill_rect(draw, hx + 14*s, ey + s, 2*s, 2*s, eye_c)
        fill_rect(draw, hx + 3*s, ey - 2*s, 6*s, s, hair_c)
        fill_rect(draw, hx + 11*s, ey - 2*s, 6*s, s, hair_c)
        fill_rect(draw, hx + 8*s, ey + 5*s, 4*s, s, mouth_c)
    else:  # normal
        fill_rect(draw, hx + 4*s, ey, 4*s, 3*s, eye_w)
        fill_rect(draw, hx + 5*s, ey + s, 2*s, 2*s, eye_c)
        fill_rect(draw, hx + 5*s, ey + s, s, s, (255, 255, 255))
        fill_rect(draw, hx + 12*s, ey, 4*s, 3*s, eye_w)
        fill_rect(draw, hx + 13*s, ey + s, 2*s, 2*s, eye_c)
        fill_rect(draw, hx + 13*s, ey + s, s, s, (255, 255, 255))
        fill_rect(draw, hx + 8*s, ey + 5*s, 4*s, s, mouth_c)
        fill_rect(draw, hx + 7*s, ey + 4*s, s, s, mouth_c)
        fill_rect(draw, hx + 12*s, ey + 4*s, s, s, mouth_c)

    # --- HEADGEAR ---
    draw_headgear(draw, hx, hy, s, colors, features, flip)


def gen_row(sheet, row, colors, features, frame_configs):
    """Generate one animation row from frame configs."""
    for col, fc in enumerate(frame_configs):
        img = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        draw_character(
            d, CW // 2 + fc.get("dx", 0), CH // 2 + 20,
            colors, features, scale=3,
            flip=fc.get("flip", False),
            arm_angle=fc.get("arm_angle", 0),
            leg_offset=fc.get("leg_offset", 0),
            body_tilt=fc.get("body_tilt", 0),
            head_tilt=fc.get("head_tilt", 0),
            expression=fc.get("expression", "normal"),
            arm_wave=fc.get("arm_wave", False),
            jump_y=fc.get("jump_y", 0),
            collapsed=fc.get("collapsed", False),
        )
        sheet.paste(img, (col * CW, row * CH), img)


def gen_all_animations(sheet, colors, features):
    """Generate all 9 animation rows."""

    # Row 0: idle
    gen_row(sheet, 0, colors, features, [
        {"jump_y": 0, "expression": "normal"},
        {"jump_y": -1, "expression": "normal"},
        {"jump_y": -2, "expression": "blink"},
        {"jump_y": -1, "expression": "normal"},
        {"jump_y": 0, "expression": "normal"},
        {"jump_y": -1, "expression": "normal"},
        {"jump_y": 0, "expression": "normal"},
        {"jump_y": 0, "expression": "blink"},
    ])

    # Row 1: running right
    gen_row(sheet, 1, colors, features, [
        {"leg_offset": 0, "body_tilt": 0, "head_tilt": 0, "arm_angle": 0, "jump_y": 0, "dx": 8},
        {"leg_offset": 4, "body_tilt": 1, "head_tilt": 1, "arm_angle": 2, "jump_y": -2, "dx": 8},
        {"leg_offset": 0, "body_tilt": 2, "head_tilt": 2, "arm_angle": 3, "jump_y": -3, "dx": 8},
        {"leg_offset": -4, "body_tilt": 1, "head_tilt": 1, "arm_angle": 2, "jump_y": -2, "dx": 8},
        {"leg_offset": 0, "body_tilt": 0, "head_tilt": 0, "arm_angle": 0, "jump_y": 0, "dx": 8},
        {"leg_offset": 4, "body_tilt": -1, "head_tilt": -1, "arm_angle": -2, "jump_y": -2, "dx": 8},
        {"leg_offset": 0, "body_tilt": -2, "head_tilt": -2, "arm_angle": -3, "jump_y": -3, "dx": 8},
        {"leg_offset": -4, "body_tilt": -1, "head_tilt": -1, "arm_angle": -2, "jump_y": -2, "dx": 8},
    ])

    # Row 2: running left
    gen_row(sheet, 2, colors, features, [
        {"leg_offset": 0, "body_tilt": 0, "head_tilt": 0, "arm_angle": 0, "jump_y": 0, "flip": True, "dx": -8},
        {"leg_offset": 4, "body_tilt": -1, "head_tilt": -1, "arm_angle": 2, "jump_y": -2, "flip": True, "dx": -8},
        {"leg_offset": 0, "body_tilt": -2, "head_tilt": -2, "arm_angle": 3, "jump_y": -3, "flip": True, "dx": -8},
        {"leg_offset": -4, "body_tilt": -1, "head_tilt": -1, "arm_angle": 2, "jump_y": -2, "flip": True, "dx": -8},
        {"leg_offset": 0, "body_tilt": 0, "head_tilt": 0, "arm_angle": 0, "jump_y": 0, "flip": True, "dx": -8},
        {"leg_offset": 4, "body_tilt": 1, "head_tilt": 1, "arm_angle": -2, "jump_y": -2, "flip": True, "dx": -8},
        {"leg_offset": 0, "body_tilt": 2, "head_tilt": 2, "arm_angle": -3, "jump_y": -3, "flip": True, "dx": -8},
        {"leg_offset": -4, "body_tilt": 1, "head_tilt": 1, "arm_angle": -2, "jump_y": -2, "flip": True, "dx": -8},
    ])

    # Row 3: waving
    gen_row(sheet, 3, colors, features, [
        {"arm_wave": True, "jump_y": 0, "expression": "happy"},
        {"arm_wave": False, "jump_y": -1, "expression": "happy"},
        {"arm_wave": True, "jump_y": 0, "expression": "happy"},
        {"arm_wave": False, "jump_y": -1, "expression": "happy"},
        {"arm_wave": True, "jump_y": 0, "expression": "happy"},
        {"arm_wave": False, "jump_y": 0, "expression": "happy"},
        {"arm_wave": True, "jump_y": 0, "expression": "normal"},
        {"arm_wave": False, "jump_y": 0, "expression": "normal"},
    ])

    # Row 4: jumping
    gen_row(sheet, 4, colors, features, [
        {"jump_y": 0, "arm_angle": 0, "expression": "normal"},
        {"jump_y": -8, "arm_angle": 3, "expression": "happy"},
        {"jump_y": -20, "arm_angle": 5, "expression": "happy"},
        {"jump_y": -30, "arm_angle": 5, "expression": "happy"},
        {"jump_y": -35, "arm_angle": 5, "expression": "happy"},
        {"jump_y": -25, "arm_angle": 3, "expression": "happy"},
        {"jump_y": -10, "arm_angle": 0, "expression": "happy"},
        {"jump_y": 0, "arm_angle": 0, "expression": "normal"},
    ])

    # Row 5: failed
    gen_row(sheet, 5, colors, features, [
        {"body_tilt": 0, "head_tilt": 0, "expression": "sad"},
        {"body_tilt": -1, "head_tilt": -2, "expression": "sad"},
        {"body_tilt": -2, "head_tilt": -4, "expression": "sad"},
        {"body_tilt": -3, "head_tilt": -6, "expression": "sad"},
        {"body_tilt": -3, "head_tilt": -6, "expression": "sad", "collapsed": True},
        {"body_tilt": -2, "head_tilt": -4, "expression": "sad", "collapsed": True},
        {"body_tilt": -1, "head_tilt": -2, "expression": "sad"},
        {"body_tilt": 0, "head_tilt": 0, "expression": "sad"},
    ])

    # Row 6: waiting
    gen_row(sheet, 6, colors, features, [
        {"jump_y": 0, "head_tilt": 0, "expression": "normal"},
        {"jump_y": -1, "head_tilt": 0, "expression": "normal"},
        {"jump_y": 0, "head_tilt": 2, "expression": "normal"},
        {"jump_y": -1, "head_tilt": 0, "expression": "normal"},
        {"jump_y": 0, "head_tilt": -2, "expression": "blink"},
        {"jump_y": 0, "head_tilt": 0, "expression": "blink"},
        {"jump_y": 0, "head_tilt": 0, "expression": "normal"},
        {"jump_y": 0, "head_tilt": 0, "expression": "normal"},
    ])

    # Row 7: running (generic, same as row 1)
    gen_row(sheet, 7, colors, features, [
        {"leg_offset": 0, "body_tilt": 0, "head_tilt": 0, "arm_angle": 0, "jump_y": 0, "dx": 8},
        {"leg_offset": 4, "body_tilt": 1, "head_tilt": 1, "arm_angle": 2, "jump_y": -2, "dx": 8},
        {"leg_offset": 0, "body_tilt": 2, "head_tilt": 2, "arm_angle": 3, "jump_y": -3, "dx": 8},
        {"leg_offset": -4, "body_tilt": 1, "head_tilt": 1, "arm_angle": 2, "jump_y": -2, "dx": 8},
        {"leg_offset": 0, "body_tilt": 0, "head_tilt": 0, "arm_angle": 0, "jump_y": 0, "dx": 8},
        {"leg_offset": 4, "body_tilt": -1, "head_tilt": -1, "arm_angle": -2, "jump_y": -2, "dx": 8},
        {"leg_offset": 0, "body_tilt": -2, "head_tilt": -2, "arm_angle": -3, "jump_y": -3, "dx": 8},
        {"leg_offset": -4, "body_tilt": -1, "head_tilt": -1, "arm_angle": -2, "jump_y": -2, "dx": 8},
    ])

    # Row 8: review/thinking
    gen_row(sheet, 8, colors, features, [
        {"head_tilt": 0, "arm_angle": 2, "expression": "surprised"},
        {"head_tilt": 2, "arm_angle": 2, "expression": "surprised", "jump_y": -1},
        {"head_tilt": 4, "arm_angle": 2, "expression": "surprised", "jump_y": -1},
        {"head_tilt": 4, "arm_angle": 0, "expression": "normal"},
        {"head_tilt": 2, "arm_angle": 0, "expression": "happy"},
        {"head_tilt": 0, "arm_angle": 0, "expression": "happy"},
        {"head_tilt": 0, "arm_angle": 0, "expression": "normal"},
        {"head_tilt": 0, "arm_angle": 0, "expression": "normal"},
    ])


def main():
    parser = argparse.ArgumentParser(description="Generate desktop pet spritesheet")
    parser.add_argument("--output", "-o", required=True, help="Output .webp file path")
    parser.add_argument("--config", "-c", type=str, help="JSON config string")
    parser.add_argument("--config-file", "-f", help="Path to JSON config file")
    args = parser.parse_args()

    config = {}
    if args.config_file:
        with open(args.config_file) as f:
            config = json.load(f)
    elif args.config:
        config = json.loads(args.config)

    # Merge colors with defaults (convert all to tuples)
    colors = {k: tuple_color(v) for k, v in DEFAULT_COLORS.items()}
    for k, v in config.get("colors", {}).items():
        colors[k] = tuple_color(v)

    # Auto-derive missing colors
    if "hair_light" not in config.get("colors", {}):
        colors["hair_light"] = lighten(colors["hair"], 30)
    if "mouth" not in config.get("colors", {}):
        colors["mouth"] = darken(colors["skin"], 80)

    # Merge features with defaults
    features = dict(DEFAULT_FEATURES)
    features.update(config.get("features", {}))

    sheet = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gen_all_animations(sheet, colors, features)

    import os
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    sheet.save(args.output, "WEBP", quality=95, lossless=True)
    print(f"Saved spritesheet to {args.output} ({sheet.size[0]}x{sheet.size[1]})")


if __name__ == "__main__":
    main()
