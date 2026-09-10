import process from 'node:process';

process.stdin.resume();
process.stderr.write('[event] ready\n');
process.stdout.write('{"sequence":1}\n{"sequence":2}\n{"sequence":3}\n');
process.stdin.on('end', () => process.exit(0));
