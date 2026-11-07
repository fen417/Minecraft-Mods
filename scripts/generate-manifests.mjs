import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const segment = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;
const reserved = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i;
export function filename(value) {
  if (typeof value !== 'string' || !value || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || reserved.test(value))
    throw new Error(`Invalid filename: ${value}`);
  return value;
}
function identifier(value) {
  filename(value);
  if (!segment.test(value)) throw new Error(`Invalid identifier: ${value}`);
  return value;
}
function relativePath(value) {
  if (typeof value !== 'string') throw new Error('Expected a relative path');
  value.split('/').forEach(filename);
  return value;
}
export function validate(config) {
  if (config.schema_version !== 1 || !Array.isArray(config.modpacks) || !config.modpacks.length)
    throw new Error('Expected schema_version 1 and a nonempty modpacks array');
  const ids = new Set(), legacyNames = new Set();
  for (const pack of config.modpacks) {
    identifier(pack.id);
    if (ids.has(pack.id.toLowerCase())) throw new Error(`Duplicate modpack id: ${pack.id}`);
    ids.add(pack.id.toLowerCase());
    if (typeof pack.name !== 'string' || !pack.name.trim()) throw new Error('Missing modpack name');
    identifier(pack.minecraft_version);
    if (!['vanilla', 'forge', 'neoforge', 'fabric', 'quilt'].includes(pack.mod_loader)) throw new Error(`Unknown loader: ${pack.mod_loader}`);
    if (pack.mod_loader === 'vanilla') {
      if (pack.mod_loader_version !== '') throw new Error('Vanilla loader version must be empty');
    } else identifier(pack.mod_loader_version);
    relativePath(pack.mods_directory);
    if (pack.additional_files != null) relativePath(pack.additional_files);
    if (pack.legacy_manifest) {
      filename(pack.legacy_manifest);
      if (!/^mods-manifest[0-9]*\.json$/.test(pack.legacy_manifest) || legacyNames.has(pack.legacy_manifest))
        throw new Error('Invalid or duplicate legacy manifest filename');
      legacyNames.add(pack.legacy_manifest);
    }
  }
  return config;
}
async function hash(file, algorithm = 'sha256') {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function inside(root, relative) {
  relativePath(relative);
  const canonicalRoot = await realpath(root);
  const resolved = await realpath(path.join(root, relative));
  const rel = path.relative(canonicalRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes repository: ${relative}`);
  return resolved;
}

export async function generate({root = '.', output = 'generated', repository, revision}) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Expected full commit SHA');
  const config = validate(JSON.parse(await readFile(path.join(root, 'modpacks.json'), 'utf8')));
  const url = relative => `https://raw.githubusercontent.com/${repository}/${revision}/${relative.split('/').map(encodeURIComponent).join('/')}`;
  const catalog = {schema_version: 1, revision, modpacks: []};
  const legacy = [];
  for (const pack of config.modpacks) {
    const directory = await inside(root, pack.mods_directory);
    const mods = [], legacyMods = [], names = new Set();
    for (const name of (await readdir(directory)).sort()) {
      if (!name.toLowerCase().endsWith('.jar')) continue;
      filename(name);
      if (names.has(name.toLowerCase())) throw new Error(`Case-insensitive duplicate: ${name}`);
      names.add(name.toLowerCase());
      const file = await inside(root, `${pack.mods_directory}/${name}`);
      if (!(await stat(file)).isFile()) throw new Error(`Not a file: ${file}`);
      const mod = {name: name.slice(0, -4), filename: name, download_url: url(`${pack.mods_directory}/${name}`), hash: await hash(file), is_optional: /^opt/i.test(name)};
      mods.push(mod);
      legacyMods.push({...mod, hash: await hash(file, 'md5')});
    }
    if (pack.mod_loader !== 'vanilla' && mods.length === 0) throw new Error(`No mods found for ${pack.id}; refusing to publish an empty pack`);
    const {id, name, minecraft_version, mod_loader, mod_loader_version} = pack;
    const entry = {id, name, minecraft_version, mod_loader, mod_loader_version, mods};
    if (pack.additional_files) {
      const file = await inside(root, pack.additional_files);
      entry.additional_files = {url: url(pack.additional_files), hash: await hash(file)};
    }
    catalog.modpacks.push(entry);
    if (pack.legacy_manifest) legacy.push([pack.legacy_manifest, {version: revision, minecraft_version, mod_loader, mod_loader_version, mods: legacyMods}]);
  }
  // Write nothing until every pack is validated and hashed.
  await mkdir(output, {recursive: true});
  await writeFile(path.join(output, 'modpacks-manifest.json'), JSON.stringify(catalog, null, 2) + '\n');
  for (const [name, content] of legacy) await writeFile(path.join(output, name), JSON.stringify(content, null, 2) + '\n');
  return catalog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await generate({repository: process.env.GITHUB_REPOSITORY, revision: process.env.GITHUB_SHA});
}
