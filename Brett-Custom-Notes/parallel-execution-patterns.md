# Parallel Execution Patterns

## Proven Patterns That Work

### Research & Analysis Pattern
```
rag codebase "authentication" +
rag knowledge-base "security" +  
read_file "/config/auth.ts" +
grep "auth.*function" +
tts_speak "Analyzing auth system..."
```

### Multi-Collection RAG Search
```
rag collection1 "query" +
rag collection2 "query" +
ragkb "query" +
tts_speak "Searching all collections..."
```

### File Discovery Pattern
```
glob "**/*.ts" +
grep "specific_pattern" +
read_file "/package.json" +
tts_speak "Discovering structure..."
```

### Development Workflow
```
git status +
git diff +
rag codebase "testing" +
qwen_tasks add "Code review prep" +
tts_speak "Preparing dev context..."
```

## Don't Parallelize These

- `searcha` calls (rate limits)
- Dependent operations (read then edit based on content)
- Multiple heavy file operations

## Performance Guidelines

- Sweet spot: 3-5 parallel operations
- Mix quick + slow operations
- Always include TTS for progress feedback
- Use task management to track completion