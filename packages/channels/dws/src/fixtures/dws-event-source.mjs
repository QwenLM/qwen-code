import process from 'node:process';

process.stdin.resume();
process.stderr.write('[event] ready\n');
process.stdout.write('{"type":"fixture"}\n');
process.stdin.on('end', () => process.exit(0));
