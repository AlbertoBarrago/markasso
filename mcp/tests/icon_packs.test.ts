import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sceneToSVG } from '../../src/rendering/export';
import { makeZip } from '../../tests/helpers/zip';
import { describeDiagram } from '../src/describe';
import { Diagram, resolveIcon } from '../src/diagram';
import { IconPackError, UserIconPacks, userIconPacks } from '../src/icon_packs';
import { exportPng } from '../src/png';

/** Small, self-made SVGs laid out like the official AWS package. */
const svg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="${fill}"/></svg>`;
const AWS_FILES = [
  {
    name: 'Architecture-Service-Icons/Arch_Compute/48/Arch_Amazon-EC2_48.svg',
    text: svg('#ed7100'),
  },
  {
    name: 'Architecture-Service-Icons/Arch_Compute/64/Arch_Amazon-EC2_64.svg',
    text: svg('#ed7100'),
  },
  {
    name: 'Architecture-Service-Icons/Arch_Compute/48/Arch_AWS-Lambda_48.svg',
    text: svg('#ed7100'),
  },
  {
    name: 'Architecture-Service-Icons/Arch_Database/48/Arch_Amazon-DynamoDB_48.svg',
    text: svg('#c925d1'),
  },
  {
    name: 'Architecture-Service-Icons/Arch_Database/48/Arch_Evil_48.svg',
    text: '<svg onload="alert(1)"><rect/></svg>',
  },
];

let dir: string;
let zipPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'markasso-icons-'));
  zipPath = join(dir, 'Icon-package_07312026.zip');
  await writeFile(zipPath, await makeZip(AWS_FILES));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('UserIconPacks', () => {
  it('reads a vendor ZIP like the app import does, skipping unsafe SVGs', async () => {
    const packs = new UserIconPacks();
    const pack = await packs.load(zipPath);
    expect(pack.name).toBe('AWS');
    expect(pack.slug).toBe('aws');
    // The 48 and 64 px EC2 variants collapse into one icon.
    expect(pack.icons.map((i) => i.ref).sort()).toEqual([
      'aws/amazon-dynamodb',
      'aws/amazon-ec2',
      'aws/aws-lambda',
    ]);
    expect(pack.skipped).toBe(1);
    expect(pack.icons[0]!.src).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('reads an extracted folder and ignores links pointing out of it', async () => {
    const folder = join(dir, 'extracted');
    const outside = join(dir, 'outside');
    await mkdir(join(folder, 'Arch_Compute'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(folder, 'Arch_Compute', 'Arch_AWS-Lambda_48.svg'),
      svg('#f90'),
    );
    await writeFile(join(outside, 'Secret_48.svg'), svg('#000'));
    await symlink(
      join(outside, 'Secret_48.svg'),
      join(folder, 'Arch_Compute', 'Secret_48.svg'),
    );
    const pack = await new UserIconPacks().load(folder);
    expect(pack.icons.map((i) => i.name)).toEqual(['AWS Lambda']);
  });

  it('finds icons by reference, name or a unique name ending', async () => {
    const packs = new UserIconPacks();
    await packs.load(zipPath);
    expect(packs.find('aws/amazon-ec2')?.name).toBe('Amazon EC2');
    expect(packs.find('Amazon DynamoDB')?.ref).toBe('aws/amazon-dynamodb');
    expect(packs.find('lambda')?.ref).toBe('aws/aws-lambda');
    expect(packs.find('aws/nope')).toBeNull();
    expect(packs.find('amazon')).toBeNull();
  });

  it('picks the base service when several names end the same way', async () => {
    const folder = join(dir, 'endings');
    await mkdir(folder, { recursive: true });
    for (const name of [
      'AWS-Lambda',
      'Amazon-S3-Object-Lambda',
      'Foo-Queue',
      'Bar-Queue',
    ])
      await writeFile(join(folder, `Arch_${name}_48.svg`), svg('#f90'));
    const packs = new UserIconPacks();
    await packs.load(folder);
    expect(packs.find('lambda')?.name).toBe('AWS Lambda');
    // "Foo Queue" and "Bar Queue" are equally short: no guess.
    expect(packs.find('queue')).toBeNull();
  });

  it('ranks exact and word-start matches before the rest', async () => {
    const packs = new UserIconPacks();
    await packs.load(zipPath);
    expect(packs.search('dynamodb')[0]!.ref).toBe('aws/amazon-dynamodb');
    expect(packs.search('database').map((i) => i.ref)).toEqual([
      'aws/amazon-dynamodb',
    ]);
    expect(packs.search('')).toHaveLength(3);
  });

  it('keeps the slug on reload and never takes a built-in pack name', async () => {
    const packs = new UserIconPacks();
    const first = await packs.load(zipPath);
    const again = await packs.load(zipPath);
    expect(again.slug).toBe(first.slug);
    expect(packs.list()).toHaveLength(1);
    const generic = join(dir, 'generic');
    await mkdir(generic, { recursive: true });
    await writeFile(join(generic, 'Thing_48.svg'), svg('#123'));
    expect((await packs.load(generic)).slug).toBe('generic-2');
  });

  it('loads MARKASSO_ICON_PACKS once and reports the paths it could not use', async () => {
    const packs = new UserIconPacks();
    const missing = join(dir, 'missing.zip');
    const errors = await packs.loadFromEnv(`${zipPath}${delimiter}${missing}`);
    expect(packs.list()).toHaveLength(1);
    expect(errors).toEqual([
      `MARKASSO_ICON_PACKS: No file or folder at ${missing}`,
    ]);
    expect(await packs.loadFromEnv('ignored')).toBe(errors);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a ZIP path that is a FIFO or a device instead of hanging',
    async () => {
      const fifo = join(dir, 'fifo.zip');
      execFileSync('mkfifo', [fifo]);
      await expect(new UserIconPacks().load(fifo)).rejects.toThrow(
        'neither a ZIP nor a folder',
      );
      const zero = join(dir, 'zero.zip');
      await symlink('/dev/zero', zero);
      await expect(new UserIconPacks().load(zero)).rejects.toThrow(
        'neither a ZIP nor a folder',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports an unreadable env pack without breaking later lookups',
    async () => {
      const locked = join(dir, 'locked.zip');
      await writeFile(locked, await makeZip(AWS_FILES));
      await chmod(locked, 0o000);
      try {
        const packs = new UserIconPacks();
        const errors = await packs.loadFromEnv(
          `${locked}${delimiter}${zipPath}`,
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('locked.zip');
        expect(packs.find('aws/amazon-ec2')?.name).toBe('Amazon EC2');
        expect(await packs.loadFromEnv()).toBe(errors);
      } finally {
        await chmod(locked, 0o644);
      }
    },
  );

  it('rejects paths that are not a pack', async () => {
    const packs = new UserIconPacks();
    const note = join(dir, 'note.txt');
    await writeFile(note, 'hi');
    await expect(packs.load(note)).rejects.toThrow(IconPackError);
    const empty = join(dir, 'empty');
    await mkdir(empty, { recursive: true });
    await expect(packs.load(empty)).rejects.toThrow('No usable SVG icons');
  });
});

describe('icons from a loaded pack in diagrams', () => {
  beforeAll(async () => {
    await userIconPacks.load(zipPath);
  });

  it('prefers built-in icons for bare names and embeds pack icons', async () => {
    expect(await resolveIcon('database')).toEqual({
      kind: 'builtin',
      ref: 'generic/database',
    });
    expect(await resolveIcon('aws/amazon-ec2')).toMatchObject({
      kind: 'embedded',
      pack: 'AWS',
      name: 'Amazon EC2',
    });
    await expect(resolveIcon('aws/nope')).rejects.toThrow('Unknown icon');
  });

  it('adds embedded icon nodes that read back and export', async () => {
    const d = new Diagram();
    await d.addNodes([
      { key: 'fn', kind: 'icon', icon: 'lambda', label: 'Handler' },
      { key: 'db', kind: 'icon', icon: 'aws/amazon-dynamodb', label: 'Orders' },
    ]);
    d.connect([{ from: 'fn', to: 'db' }]);
    const [fn] = d.elements;
    expect(fn).toMatchObject({
      type: 'stencil',
      source: { kind: 'embedded', pack: 'AWS', name: 'AWS Lambda' },
    });
    expect(describeDiagram(d)).toContain(
      '- fn [icon AWS: AWS Lambda] "Handler"',
    );
    const [image] = await exportPng(d, {});
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    // The SVG export (which the PNG is rendered from) embeds the icon itself.
    const svgOut = sceneToSVG(d.elements, {
      canvasColor: '#080808',
      withBackground: false,
    })!;
    const lambda = userIconPacks.find('aws/aws-lambda')!;
    expect(svgOut).toContain(lambda.src);
  });
});
