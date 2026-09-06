import process from 'node:process';
import { setTimeout } from 'node:timers';

process.stdin.resume();
process.stderr.write('[event] ready\n');
setTimeout(() => {
  const depth = 20_000;
  process.stderr.write(
    `${'{"nested":'.repeat(depth)}{"message":"subscription denied","retryable":false,"retry_after_seconds":3}${'}'.repeat(depth)}\n`,
    () => process.exit(1),
  );
}, 10);
