const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async function verifyLiveHostHelper(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appBundle = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const helper = join(
    appBundle,
    'Contents',
    'Resources',
    'native',
    'qwen-live-command-monitor',
  );
  if (!existsSync(helper)) {
    throw new Error(`Missing packaged command monitor: ${helper}`);
  }

  const teamIdentifier = (path) => {
    const result = spawnSync(
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', path],
      { encoding: 'utf8' },
    );
    const match = result.stderr.match(/^TeamIdentifier=(.+)$/m);
    return match?.[1];
  };
  const appTeam = teamIdentifier(appBundle);
  if (!appTeam || appTeam === 'not set') return;

  execFileSync(
    '/usr/bin/codesign',
    ['--verify', '--strict', '--verbose=2', helper],
    {
      stdio: 'inherit',
    },
  );

  const helperTeam = teamIdentifier(helper);
  if (!helperTeam || helperTeam === 'not set' || helperTeam !== appTeam) {
    throw new Error(
      'The command monitor must carry the same Developer ID team as Qwen Live Host.',
    );
  }
};
