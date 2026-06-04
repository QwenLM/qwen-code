import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

import { BRAND } from '../packages/shared/src/branding.ts';

type MutableRecord = Record<string, unknown>;

function section(config: MutableRecord, key: string): MutableRecord {
  const existing = config[key];
  if (
    existing &&
    typeof existing === 'object' &&
    !Array.isArray(existing)
  ) {
    return existing as MutableRecord;
  }

  const next: MutableRecord = {};
  config[key] = next;
  return next;
}

const electronDir = join(process.cwd(), 'apps', 'electron');
const inputPath = join(electronDir, 'electron-builder.yml');
const outputPath = join(electronDir, 'electron-builder.generated.yml');
const config = yaml.load(readFileSync(inputPath, 'utf8')) as MutableRecord;
const artifactName = `${BRAND.artifactPrefix}-\${arch}.\${ext}`;

config.appId = BRAND.appId;
config.productName = BRAND.productName;
config.copyright = BRAND.copyright;

const mac = section(config, 'mac');
mac.icon = BRAND.assets.macIcon;
mac.artifactName = artifactName;

const dmg = section(config, 'dmg');
dmg.artifactName = `${BRAND.artifactPrefix}-\${arch}.dmg`;
dmg.icon = BRAND.assets.macIcon;
dmg.title = BRAND.productName;

const win = section(config, 'win');
win.icon = BRAND.assets.winIcon;
win.artifactName = artifactName;

const linux = section(config, 'linux');
linux.icon = BRAND.assets.linuxIcon;
linux.artifactName = artifactName;

writeFileSync(outputPath, yaml.dump(config, { lineWidth: -1 }));
console.log(`Generated ${outputPath} for ${BRAND.id}`);
