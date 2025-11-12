# 🎨 ASCII Art Code Visualizer

Transform your code architecture into beautiful ASCII art visualizations!

## Features

- **Class Hierarchy Trees** - Visualize inheritance and composition
- **Dependency Graphs** - See how your modules connect
- **File Structure Art** - Beautiful directory tree representations
- **Function Flow Diagrams** - Trace execution paths visually
- **Complexity Heatmaps** - Visual representation of code complexity
- **Git History Timeline** - ASCII timeline of your project evolution

## Usage

```bash
# Visualize file structure
qwen-code visualize structure ./src

# Show class hierarchy
qwen-code visualize classes ./src/models

# Display dependency graph
qwen-code visualize deps

# Show complexity heatmap
qwen-code visualize complexity

# Git timeline
qwen-code visualize timeline
```

## Example Output

```
┌─────────────────────────────────────────┐
│        Code Architecture Map            │
├─────────────────────────────────────────┤
│                                         │
│     ┌──────────┐                        │
│     │  Core    │                        │
│     └────┬─────┘                        │
│          │                              │
│     ┌────┴────┬────────┐                │
│     │         │        │                │
│  ┌──▼──┐  ┌──▼──┐  ┌──▼──┐             │
│  │ API │  │ CLI │  │Utils│             │
│  └──┬──┘  └─────┘  └─────┘             │
│     │                                   │
│  ┌──▼────────────┐                      │
│  │  Extensions   │                      │
│  └───────────────┘                      │
│                                         │
└─────────────────────────────────────────┘
```

## ASCII Art Styles

- **Classic** - Traditional box drawing characters
- **Double** - Bold double-line boxes
- **Rounded** - Smooth rounded corners
- **Dot Matrix** - Retro dot-style art
- **3D** - Isometric 3D representations
- **Organic** - Flowing, artistic style

## Installation

This tool is included with qwen-code. No additional installation required!

## API

```typescript
import { AsciiVisualizer } from '@qwen-code/ascii-art-visualizer';

const visualizer = new AsciiVisualizer({
  style: 'rounded',
  colors: true,
  width: 80,
  height: 40
});

const art = await visualizer.visualizeStructure('./src');
console.log(art);
```

## Configuration

Create `.qwenvizrc.json` in your project root:

```json
{
  "style": "rounded",
  "colors": true,
  "maxDepth": 5,
  "showMetrics": true,
  "animations": true
}
```

## Contributing

Contributions welcome! Add new visualization types or ASCII art styles.

## License

Apache 2.0
