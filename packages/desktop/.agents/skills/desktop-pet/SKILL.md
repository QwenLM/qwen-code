---
name: desktop-pet
description: Create pixel-art desktop pet companions for OpenWork/Qwen Code. Generates a customized chibi spritesheet (1536×1872, 8×9 grid) for any character the user names — F1 drivers, anime characters, celebrities, fictional characters, animals, etc. Use when the user says "桌面宠物", "desktop pet", "想要XXX当桌宠", "换个宠物" or similar.
version: 1.0.0
---

# Desktop Pet Creator

Create pixel-art chibi desktop pet companions for OpenWork's floating pet window.
Given any character name, generate a complete pet package with animated spritesheet
and place it in `~/.qwen/pets/` where OpenWork auto-discovers it.

## Workflow

### Step 1: Identify the Character

Ask the user who they want as their desktop pet if not already specified.
Then research the character's visual appearance:

- **Team/organization colors** (e.g., McLaren papaya orange, Ferrari red)
- **Outfit/uniform** (racing suit, school uniform, armor, etc.)
- **Distinguishing features** (hair color/style, accessories, number, helmet)
- **Personality traits** (for animation style — energetic, calm, goofy, serious)
- **Iconic items** (steering wheel, lightsaber, guitar, etc.)

Use web search if needed to gather visual reference. For well-known characters
(F1 drivers, popular anime, etc.), rely on training knowledge.

### Step 2: Design the Color Palette

Define 8-12 colors for the character:

| Color Role     | Example (F1 Driver)  | Example (Anime Character) |
| -------------- | -------------------- | ------------------------- |
| Primary outfit | Team color (papaya)  | Uniform color (navy)      |
| Outfit dark    | Darker shade         | Darker shade              |
| Outfit light   | Lighter shade        | Lighter shade             |
| Skin           | Warm skin tone       | Skin tone                 |
| Skin dark      | Shadow skin          | Shadow skin               |
| Hair           | Character hair color | Character hair color      |
| Accent         | Number/logo color    | Eye color / accessory     |
| Shoe           | Dark grey/black      | Character shoe color      |

**Important:** All colors must be distinct and work at small pixel scale (3x = 9px details).

### Step 3: Generate the Spritesheet

Use the template script at `scripts/gen_spritesheet.py` as a starting point.
The script generates a **1536×1872 pixel RGBA spritesheet** (8 columns × 9 rows,
192×208 px cells) — the exact format OpenWork expects.

**Run it like this:**

```bash
python3 <skill_dir>/scripts/gen_spritesheet.py \
  --output ~/.qwen/pets/<character_id>/spritesheet.webp \
  --config '{"name":"...","colors":{...},"features":{...}}'
```

Or copy and customize the script for characters that need unique visual elements
not covered by the parameterized version.

**The 9 animation rows are:**

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

### Step 4: Create pet.json

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

### Step 5: Verify and Activate

1. Confirm the files exist:

   ```bash
   ls -lh ~/.qwen/pets/<character_id>/
   ```

2. Open the spritesheet in Preview for the user to check:

   ```bash
   open ~/.qwen/pets/<character_id>/spritesheet.webp
   ```

3. Tell the user to activate:
   > Open **OpenWork → Settings → Appearance → Pet Companion**,
   > click **Refresh**, then select **<Display Name>**.

## Character Design Guidelines

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

- **Idle**: subtle Y bob (0 to -2px) + blink every 3rd-4th frame
- **Running**: alternating leg offset (±4px), body tilt (±2px), arm swing
- **Waving**: one arm raised high, alternating frames
- **Jumping**: Y offset curve (0 → -30 → 0), arms up
- **Failed**: body tilt increases, then collapse to sitting pose
- **Happy expression**: curved eyes (∧ shape), blush marks on cheeks
- **Sad expression**: straight eyebrows, downturned mouth

### Headgear Variants

The template supports several headgear types. Set via `features.headgear`:

- `cap` — baseball cap with brim (default for F1 drivers)
- `helmet` — full racing helmet with visor
- `none` — no headgear (just hair)
- `hat` — generic hat
- `hood` — hooded outfit
- `crown` — royal crown
- `horns` — devil/dragon horns
- `ears` — animal ears (cat, dog, etc.)
- `halo` — angel halo
- `headband` — ninja/sports headband

### Special Features

Set via `features.extras` (list):

- `glasses` — round or rectangular glasses
- `scarf` — neck scarf
- `tail` — animal tail
- `wings` — small wings on back
- `number` — chest number (set `features.number` to the number string)
- `logo` — chest badge/logo area
- `sweat_drop` — anime sweat drop (in waiting/failed states)

## Example Characters

### F1 Driver (e.g., Piastri, Norris, Verstappen)

```json
{
  "colors": {
    "outfit": [255, 135, 32],
    "outfit_dark": [220, 110, 20],
    "outfit_light": [255, 170, 80],
    "hair": [120, 80, 40],
    "number": [30, 30, 30]
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
    "hair": [220, 170, 100],
    "accent": [255, 255, 255]
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
- **Spritesheet too large**: Must be under 5MB (webp lossless usually ~8-50KB)
- **Animation jittery**: Ensure all 8 frames per row are visually distinct but not jarring
