---
name: desktop-pet
description: Create pixel-art desktop pet companions for Qwen Code. Generates a customized chibi spritesheet (1536×1872, 8×9 grid) for any character the user names — F1 drivers, anime characters, celebrities, fictional characters, animals, etc. Use when the user says "desktop pet", "桌宠", "桌面宠物", "想要XXX当桌宠", "换个宠物", or similar.
---

# Desktop Pet Creator

Create pixel-art chibi desktop pet companions for Qwen Code's floating pet window.
Given any character name, generate a complete pet package with animated spritesheet
and place it in `~/.qwen/pets/` where Qwen Code auto-discovers it.

## Prerequisites

- Python 3 with Pillow (`pip3 install Pillow`). Check before running the script:

```bash
python3 -c "from PIL import Image; print('OK')" 2>/dev/null || echo "Pillow not installed — run: pip3 install Pillow"
```

## Step 1: Identify the Character

Ask the user who they want as their desktop pet if not already specified.
Then research the character's visual appearance:

- **Team/organization colors** (e.g., McLaren papaya orange, Ferrari red)
- **Outfit/uniform** (racing suit, school uniform, armor, etc.)
- **Distinguishing features** (hair color/style, accessories, number, helmet)
- **Personality traits** (for animation style — energetic, calm, goofy, serious)
- **Iconic items** (steering wheel, lightsaber, guitar, etc.)

Use web search if needed. For well-known characters (F1 drivers, popular anime,
etc.), rely on training knowledge.

## Step 2: Design the Color Palette

Define 8–12 colors for the character. All colors must be distinct and work at
small pixel scale (3× = 9 px details).

| Color Role     | Example (F1 Driver)       | Example (Anime)      |
| -------------- | ------------------------- | -------------------- |
| `outfit`       | Team color `[255,135,32]` | Uniform `[30,30,50]` |
| `outfit_dark`  | Darker shade              | Darker shade         |
| `outfit_light` | Lighter shade             | Lighter shade        |
| `skin`         | Warm skin tone            | Skin tone            |
| `skin_dark`    | Shadow skin               | Shadow skin          |
| `hair`         | Character hair color      | Character hair color |
| `accent`       | Number/logo color         | Eye color            |
| `shoe`         | Dark grey/black           | Shoe color           |

## Step 3: Generate the Spritesheet

Run the generation script. Always resolve the path relative to the skill's base
directory:

```bash
python3 <skill_dir>/scripts/gen_spritesheet.py \
  --output ~/.qwen/pets/<character_id>/spritesheet.webp \
  --config '{"colors":{...},"features":{...}}'
```

**Atlas format:** 1536×1872 px, RGBA, 8 cols × 9 rows, 192×208 px cells.

**Animation rows:**

| Row | State         | Description                       |
| --- | ------------- | --------------------------------- |
| 0   | idle          | Breathing + blinking (8 frames)   |
| 1   | running-right | Running to the right (8 frames)   |
| 2   | running-left  | Running to the left (8 frames)    |
| 3   | waving        | Waving at user (8 frames)         |
| 4   | jumping       | Jumping celebration (8 frames)    |
| 5   | failed        | Sad/collapsed on error (8 frames) |
| 6   | waiting       | Idle tapping (8 frames)           |
| 7   | running       | Generic running (8 frames)        |
| 8   | review        | Thinking/examining (8 frames)     |

## Step 4: Create `pet.json`

Write the manifest to `~/.qwen/pets/<character_id>/pet.json`:

```json
{
  "id": "<character_id>",
  "displayName": "<Display Name>",
  "description": "<Short description — who is this character?>",
  "spritesheetPath": "spritesheet.webp"
}
```

Rules:

- `id`: lowercase, no spaces, URL-safe (e.g., `piastri`, `satoru`, `goku`)
- `displayName`: The name shown in the UI (e.g., "Piastri", "五条悟", "悟空")
- `description`: One short sentence describing the character

## Step 5: Verify and Activate

1. Confirm the files exist:

```bash
ls -lh ~/.qwen/pets/<character_id>/
```

2. Open the spritesheet for the user to check:

```bash
open ~/.qwen/pets/<character_id>/spritesheet.webp
```

3. Tell the user to activate: open Qwen Code **Settings → Appearance → Pet
   Companion**, click **Refresh**, then select the new pet.

## Design Guidelines

### Chibi Proportions

- **Head**: ~40% of total height (big head = cute)
- **Body**: ~30% of total height
- **Legs**: ~25% of total height
- **Scale**: Each "pixel" in the art = 3×3 actual pixels (scale=3)
- **Character center**: approximately (96, 124) within the 192×208 cell

### Drawing Order (back to front)

1. Legs (behind body)
2. Body / outfit
3. Arms
4. Head shape
5. Hair (back layer)
6. Hair (front/top layer)
7. Face features (eyes, mouth, expression)
8. Accessories (hat, helmet, glasses, etc.)
9. Foreground details (number, logo, badge)

### Animation Tips

- **Idle**: subtle Y bob (0 to −2 px) + blink every 3rd–4th frame
- **Running**: alternating leg offset (±4 px), body tilt (±2 px), arm swing
- **Waving**: one arm raised high, alternating frames
- **Jumping**: Y offset curve (0 → −30 → 0), arms up
- **Failed**: body tilt increases, then collapse to sitting pose
- **Happy expression**: curved eyes (∧ shape), blush marks on cheeks
- **Sad expression**: straight eyebrows, downturned mouth

### Headgear Options (`features.headgear`)

`cap` · `helmet` · `hat` · `hood` · `crown` · `horns` · `ears` · `halo` · `headband` · `none`

### Hair Styles (`features.hair_style`)

`short` · `long` · `spiky` · `ponytail` · `bald`

### Extras (`features.extras` list)

`glasses` · `scarf` · `tail` · `wings` · `number` (set `features.number`) · `logo` · `sweat_drop`

## Example Characters

### F1 Driver (e.g., Piastri)

```json
{
  "colors": {
    "outfit": [255, 135, 32],
    "outfit_dark": [220, 110, 20],
    "outfit_light": [255, 170, 80],
    "hair": [120, 80, 40],
    "accent": [30, 30, 30]
  },
  "features": {
    "headgear": "cap",
    "number": "81",
    "extras": ["logo"]
  }
}
```

### Anime Character (e.g., Gojo Satoru)

```json
{
  "colors": {
    "outfit": [30, 30, 50],
    "outfit_dark": [20, 20, 35],
    "outfit_light": [60, 60, 80],
    "hair": [230, 230, 250],
    "accent": [100, 180, 255]
  },
  "features": {
    "headgear": "none",
    "hair_style": "spiky",
    "extras": ["glasses"]
  }
}
```

### Animal (e.g., Shiba Inu)

```json
{
  "colors": {
    "outfit": [220, 170, 100],
    "outfit_dark": [180, 130, 70],
    "outfit_light": [240, 200, 140],
    "hair": [220, 170, 100]
  },
  "features": {
    "headgear": "ears",
    "extras": ["tail"]
  }
}
```

## Troubleshooting

- **Pet not showing**: Click Refresh in Settings → Appearance → Pet Companion
- **Colors look wrong**: Check that RGB values are tuples, not hex strings
- **Spritesheet too large**: Must be under 5 MB (webp lossless usually ~8–50 KB)
- **Animation jittery**: Ensure all 8 frames per row are visually distinct but not jarring
