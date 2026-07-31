import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

interface BrandInput {
  brandId?: string;
  logo?: string;
  website?: string;
  appName?: string;
  appId?: string;
  artifactPrefix?: string;
  copyright?: string;
}

interface BrandConfig {
  brandId: string;
  logo: string;
  website?: string;
  appName: string;
  appId: string;
  artifactPrefix: string;
  copyright: string;
}

const BRAND_ID_RE = /^[a-z][a-z0-9-]*$/;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function configPathFromArgs(): string {
  const value = argValue('--config');
  if (!value) {
    throw new Error(
      'Usage: bun run scripts/brand-create.ts --desktop-root /path/to/packages/desktop --config /path/to/brand.json',
    );
  }
  return resolve(value);
}

function desktopRootFromArgs(): string {
  const value = argValue('--desktop-root');
  if (!value) {
    throw new Error(
      'Usage: bun run scripts/brand-create.ts --desktop-root /path/to/packages/desktop --config /path/to/brand.json',
    );
  }

  const desktopRoot = resolve(value);
  if (!existsSync(join(desktopRoot, 'package.json'))) {
    throw new Error(`Desktop package not found: ${desktopRoot}`);
  }
  return desktopRoot;
}

function titleWords(brandId: string): string[] {
  return brandId
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1));
}

function deriveAppId(website: string | undefined, brandId: string): string {
  if (!website) return `app.${brandId}.desktop`;

  try {
    const withProtocol = website.includes('://')
      ? website
      : `https://${website}`;
    const host = new URL(withProtocol).hostname.replace(/^www\./, '');
    const parts = host.split('.').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts.reverse().join('.')}.desktop`;
    }
  } catch {
    // Fall through to the deterministic fallback.
  }

  return `app.${brandId}.desktop`;
}

function loadConfig(path: string): BrandConfig {
  const input = JSON.parse(readFileSync(path, 'utf8')) as BrandInput;
  const brandId = input.brandId?.trim();
  const logo = input.logo ? resolve(input.logo) : undefined;

  if (!brandId || !BRAND_ID_RE.test(brandId)) {
    throw new Error(`brandId must match ${BRAND_ID_RE}`);
  }
  if (!logo || !existsSync(logo)) {
    throw new Error(`Logo file not found: ${logo ?? '(missing)'}`);
  }

  const words = titleWords(brandId);
  const appName = input.appName?.trim() || words.join(' ');
  const artifactPrefix = input.artifactPrefix?.trim() || words.join('-');

  return {
    brandId,
    logo,
    website: input.website?.trim() || undefined,
    appName,
    appId: input.appId?.trim() || deriveAppId(input.website, brandId),
    artifactPrefix,
    copyright:
      input.copyright?.trim() ||
      `Copyright \u00a9 ${new Date().getFullYear()} ${appName}`,
  };
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed with exit code ${exitCode}`);
  }
}

interface BrandAssetsResult {
  macIcon: string;
  hasAssetsCar: boolean;
}

async function writeBrandAssets(
  config: BrandConfig,
  desktopRoot: string,
): Promise<BrandAssetsResult> {
  const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'));
  const sharp = requireFromDesktop('sharp') as typeof import('sharp');
  const electronDir = join(desktopRoot, 'apps', 'electron');
  const brandDir = join(electronDir, 'resources', 'brands', config.brandId);
  mkdirSync(brandDir, { recursive: true });

  async function writePng(output: string, size: number) {
    await sharp(config.logo)
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(output);
  }

  const sourceExt = extname(config.logo) || '.logo';
  copyFileSync(config.logo, join(brandDir, `source${sourceExt}`));

  await writePng(join(brandDir, 'icon.png'), 512);
  await writePng(join(brandDir, 'dock.png'), 512);
  await writePng(join(brandDir, 'symbol.png'), 512);

  if (process.platform !== 'darwin') return { macIcon: 'icon.png', hasAssetsCar: false };

  const iconset = join(brandDir, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });

  const sizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ] as const;

  for (const [file, size] of sizes) {
    await writePng(join(iconset, file), size);
  }

  await run(
    ['iconutil', '-c', 'icns', iconset, '-o', join(brandDir, 'icon.icns')],
    brandDir,
  );

  const hasAssetsCar = await compileAssetsCar(config, brandDir, writePng);
  return { macIcon: 'icon.icns', hasAssetsCar };
}

async function compileAssetsCar(
  config: BrandConfig,
  brandDir: string,
  writePng: (output: string, size: number) => Promise<void>,
): Promise<boolean> {
  const xcassets = join(brandDir, 'Assets.xcassets');
  const appiconset = join(xcassets, 'AppIcon.appiconset');
  rmSync(xcassets, { recursive: true, force: true });
  mkdirSync(appiconset, { recursive: true });

  writeFileSync(
    join(xcassets, 'Contents.json'),
    JSON.stringify({ info: { author: 'xcode', version: 1 } }),
  );

  const entries = [
    { file: 'icon_16.png', size: 16, scale: '1x', dims: '16x16' },
    { file: 'icon_32.png', size: 32, scale: '2x', dims: '16x16' },
    { file: 'icon_32.png', size: 32, scale: '1x', dims: '32x32' },
    { file: 'icon_64.png', size: 64, scale: '2x', dims: '32x32' },
    { file: 'icon_128.png', size: 128, scale: '1x', dims: '128x128' },
    { file: 'icon_256.png', size: 256, scale: '2x', dims: '128x128' },
    { file: 'icon_256.png', size: 256, scale: '1x', dims: '256x256' },
    { file: 'icon_512.png', size: 512, scale: '2x', dims: '256x256' },
    { file: 'icon_512.png', size: 512, scale: '1x', dims: '512x512' },
    { file: 'icon_1024.png', size: 1024, scale: '2x', dims: '512x512' },
  ];

  const uniqueSizes = new Set(entries.map((e) => e.size));
  for (const size of uniqueSizes) {
    await writePng(join(appiconset, `icon_${size}.png`), size);
  }

  writeFileSync(
    join(appiconset, 'Contents.json'),
    JSON.stringify({
      images: entries.map((e) => ({
        filename: e.file,
        idiom: 'mac',
        scale: e.scale,
        size: e.dims,
      })),
      info: { author: 'xcode', version: 1 },
    }),
  );

  const outDir = mkdtempSync(join(tmpdir(), 'assets-car-'));
  const partialPlist = join(outDir, 'partial-info.plist');
  const proc = Bun.spawn({
    cmd: [
      'xcrun', 'actool', xcassets,
      '--compile', outDir,
      '--app-icon', 'AppIcon',
      '--platform', 'macosx',
      '--minimum-deployment-target', '14.0',
      '--output-partial-info-plist', partialPlist,
    ],
    cwd: brandDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.log('Warning: actool compilation failed, skipping Assets.car');
    rmSync(xcassets, { recursive: true, force: true });
    return false;
  }

  const compiledCar = join(outDir, 'Assets.car');
  if (!existsSync(compiledCar)) {
    console.log('Warning: actool produced no Assets.car, skipping');
    rmSync(xcassets, { recursive: true, force: true });
    return false;
  }

  copyFileSync(compiledCar, join(brandDir, 'Assets.car'));
  rmSync(xcassets, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  console.log('Assets.car compiled successfully');
  return true;
}

function tsString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function helpMenuLinks(config: BrandConfig): string {
  if (!config.website) return '[]';

  return `[
      {
        labelKey: 'menu.homepage',
        url: ${tsString(config.website)},
        icon: 'House',
      },
    ]`;
}

function brandBlock(config: BrandConfig, macIcon: string, hasAssetsCar: boolean): string {
  const resourceDir = `resources/brands/${config.brandId}`;
  const liquidGlassLine = hasAssetsCar
    ? `\n      liquidGlassAssetsCar: ${tsString(`${resourceDir}/Assets.car`)},`
    : '';

  return `  ${tsString(config.brandId)}: {
    id: ${tsString(config.brandId)},
    appName: ${tsString(config.appName)},
    appId: ${tsString(config.appId)},
    productName: ${tsString(config.appName)},
    artifactPrefix: ${tsString(config.artifactPrefix)},
    copyright: ${tsString(config.copyright)},
    coAuthorLine: ${tsString(`Co-Authored-By: ${config.appName} <noreply@${config.brandId}.local>`)},
    selfReferName: ${tsString(config.appName)},
    viewerUrl: 'https://agents.craft.do',
    helpMenuLinks: ${helpMenuLinks(config)},
    assets: {
      resourceDir: ${tsString(resourceDir)},
      rendererSymbol: ${tsString(`${resourceDir}/symbol.png`)},
      macIcon: ${tsString(`${resourceDir}/${macIcon}`)},
      winIcon: ${tsString(`${resourceDir}/icon.png`)},
      linuxIcon: ${tsString(`${resourceDir}/icon.png`)},
      devDockIcon: ${tsString(`${resourceDir}/dock.png`)},${liquidGlassLine}
    },
    credits: '',
    creditsShort: '',
    creditsEntries: [],
  },
`;
}

function registerBrand(
  config: BrandConfig,
  desktopRoot: string,
  macIcon: string,
  hasAssetsCar: boolean,
): void {
  const brandingPath = join(
    desktopRoot,
    'packages',
    'shared',
    'src',
    'branding.ts',
  );
  const source = readFileSync(brandingPath, 'utf8');
  if (
    source.includes(`${tsString(config.brandId)}:`) ||
    source.includes(`id: ${tsString(config.brandId)}`)
  ) {
    throw new Error(`Brand already exists in branding.ts: ${config.brandId}`);
  }

  const marker = '\n};\n\n/** Active brand';
  if (!source.includes(marker)) {
    throw new Error(`Could not find BRANDS insertion point in ${brandingPath}`);
  }

  writeFileSync(
    brandingPath,
    source.replace(marker, `\n${brandBlock(config, macIcon, hasAssetsCar)}${marker}`),
  );
}

async function main(): Promise<void> {
  const desktopRoot = desktopRootFromArgs();
  const config = loadConfig(configPathFromArgs());
  const { macIcon, hasAssetsCar } = await writeBrandAssets(config, desktopRoot);
  registerBrand(config, desktopRoot, macIcon, hasAssetsCar);

  console.log(`Created brand ${config.brandId}`);
  console.log(`App name: ${config.appName}`);
  console.log(`App ID: ${config.appId}`);
  console.log(
    `Assets: ${join(desktopRoot, 'apps', 'electron', 'resources', 'brands', config.brandId)}`,
  );
  if (hasAssetsCar) {
    console.log('Assets.car: generated (macOS 26+ Liquid Glass icon)');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
