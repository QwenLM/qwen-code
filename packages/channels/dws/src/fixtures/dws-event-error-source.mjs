import process from 'node:process';
import { setTimeout } from 'node:timers';

process.stdin.resume();
process.stderr.write('[event] ready\n');
setTimeout(() => {
  process.stderr.write(
    '{"message":"subscription denied","retryable":false,"retry_after_seconds":3}\n',
  );
  process.exit(1);
}, 10);
