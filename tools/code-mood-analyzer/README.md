# 🎭 Code Mood Analyzer

Give your code a personality check! This AI-powered tool analyzes your codebase's "mood" and provides witty, insightful feedback with actionable suggestions.

## What is Code Mood?

Your code has feelings too! The Code Mood Analyzer examines:

- 💚 **Code Quality** - Clean, maintainable code makes happy code
- 🧪 **Test Coverage** - Well-tested code is confident code
- 🔧 **Complexity** - Simple code is peaceful code
- 📝 **Documentation** - Well-documented code is friendly code
- 🐛 **Bug Density** - Few bugs = happy code
- 🚀 **Performance** - Fast code is energetic code
- 📦 **Dependencies** - Light dependencies = free-spirited code

## Mood States

Your code can be in various moods:

| Mood | Score | Emoji | Description |
|------|-------|-------|-------------|
| **Ecstatic** | 90-100 | 😄✨ | Perfect code! Living its best life! |
| **Happy** | 75-89 | 😊 | Great code! Minor tweaks could help |
| **Content** | 60-74 | 🙂 | Solid code with room for improvement |
| **Neutral** | 40-59 | 😐 | Okay code, needs some attention |
| **Concerned** | 25-39 | 😟 | Worried code, refactoring recommended |
| **Stressed** | 10-24 | 😰 | Struggling code, needs help ASAP |
| **Overwhelmed** | 0-9 | 😱 | Code in crisis! Intervention needed! |

## Usage

```bash
# Analyze entire project
qwen-code mood

# Analyze specific directory
qwen-code mood ./src

# Get detailed breakdown
qwen-code mood --detailed

# Compare with previous analysis
qwen-code mood --compare

# Get AI-powered suggestions
qwen-code mood --suggest
```

## Example Output

```
🎭 Code Mood Analysis
═══════════════════════════════════════════════════════

Overall Mood: 😊 Happy (Score: 82/100)

Your code is feeling pretty good today! It's well-structured
and mostly healthy, but there are a few things bothering it...

Mood Breakdown:
  💚 Code Quality    ████████░░ 80% - "I'm clean but could use some polish"
  🧪 Test Coverage   ███████░░░ 75% - "More tests would make me confident!"
  🔧 Complexity      ████████░░ 85% - "I'm pretty straightforward"
  📝 Documentation   ██████░░░░ 60% - "I could explain myself better"
  🐛 Bug Density     █████████░ 90% - "Very few bugs here!"
  🚀 Performance     ████████░░ 82% - "Running smoothly!"
  📦 Dependencies    ███████░░░ 78% - "A bit heavy, could slim down"

What's Making Me Happy:
  ✓ Low cyclomatic complexity (avg: 3.2)
  ✓ Consistent code style
  ✓ Good separation of concerns
  ✓ Fast response times

What's Bothering Me:
  ✗ Missing documentation in 23 files
  ✗ Test coverage below 80% in /src/utils
  ✗ Some functions are getting too long (>50 lines)
  ✗ 3 TODO comments lingering for 2+ months

AI Wisdom:
  "Your code is like a well-organized desk with a few papers
   out of place. Add some comments, write a few more tests,
   and I'll be ecstatic! 🌟"

Suggested Actions:
  1. Document public APIs in src/core/engine.ts
  2. Add tests for src/utils/helpers.ts (currently 45% covered)
  3. Refactor handleComplexOperation() - it's 127 lines!
  4. Resolve old TODOs or convert to issues

Mood Trend:
  Last week: 😐 Neutral (55)
  Today:     😊 Happy (82)
  Change:    ↑ +27 points - Great improvement! 🎉

═══════════════════════════════════════════════════════
Keep up the good work! Run 'qwen-code mood --suggest'
for personalized refactoring suggestions.
```

## Configuration

Create `.qwenmoodrc.json`:

```json
{
  "weights": {
    "quality": 25,
    "tests": 20,
    "complexity": 15,
    "documentation": 15,
    "bugs": 10,
    "performance": 10,
    "dependencies": 5
  },
  "thresholds": {
    "happy": 75,
    "content": 60,
    "neutral": 40
  },
  "personality": "witty",
  "enableHumor": true,
  "trackHistory": true
}
```

## Personality Modes

Choose your analyzer's personality:

- **witty** (default) - Clever and humorous
- **zen** - Calm and philosophical
- **coach** - Motivational and encouraging
- **scientist** - Analytical and precise
- **friend** - Casual and supportive

## Integration

```typescript
import { CodeMoodAnalyzer } from '@qwen-code/code-mood-analyzer';

const analyzer = new CodeMoodAnalyzer({
  personality: 'witty',
  enableHumor: true
});

const mood = await analyzer.analyze('./src');
console.log(mood.message);
console.log(`Score: ${mood.score}/100`);
console.log(`Mood: ${mood.emoji} ${mood.state}`);
```

## History Tracking

Track your code's mood over time:

```bash
# View mood history
qwen-code mood --history

# See mood chart
qwen-code mood --chart
```

Example:
```
Mood History (Last 30 Days)

  100 ┤
   90 ┤                                       ╭──●
   80 ┤                          ╭────────────╯
   70 ┤                   ╭──────╯
   60 ┤            ╭──────╯
   50 ┤     ╭──────╯
   40 ┤●────╯
      └┬────┬────┬────┬────┬────┬────┬────┬────┬───
       1    5    10   15   20   25   30   (days)

Trend: Improving! Keep it up! 📈
```

## Pro Tips

1. **Daily Check-ins** - Run mood analysis daily to catch issues early
2. **Before Commits** - Check mood before big commits
3. **Team Competition** - Compete for the happiest code on your team
4. **Mood Goals** - Set team goals for mood improvements
5. **Celebrate Wins** - When your code hits "Ecstatic", celebrate! 🎉

## Philosophy

Code isn't just logic—it's a living artifact that reflects its creators and affects its maintainers. Happy code means:
- Easy to understand
- Joy to modify
- Confidence in changes
- Pride in craftsmanship

When your code is happy, you're happy! 😊

## License

Apache 2.0
