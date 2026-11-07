import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validate, generate, filename } from './generate-manifests.mjs';

const pack = () => ({id: 'one', name: 'One', minecraft_version: '1.21.1', mod_loader: 'neoforge', mod_loader_version: '21.1.265', mods_directory: 'mods', legacy_manifest: 'mods-manifest.json'});
const config = (...modpacks) => ({schema_version: 1, modpacks});

test('all supported loaders require explicit versions', () => {
  for (const loader of ['forge', 'neoforge', 'fabric', 'quilt']) {
    assert.doesNotThrow(() => validate(config({...pack(), mod_loader: loader})));
    assert.throws(() => validate(config({...pack(), mod_loader: loader, mod_loader_version: ''})));
  }
  assert.doesNotThrow(() => validate(config({...pack(), mod_loader: 'vanilla', mod_loader_version: ''})));
  assert.throws(() => validate(config({...pack(), mod_loader: 'unknown'})));
});
test('reject unsafe identifiers and Windows filenames', () => {
  for (const value of ['../evil', 'x\\y', 'CON', 'name.', 'name ', 'C:evil', '']) assert.throws(() => filename(value));
  assert.throws(() => validate(config({...pack(), id: '../evil'})));
  assert.throws(() => validate(config({...pack(), mods_directory: '../mods'})));
  assert.throws(() => validate(config({...pack(), additional_files: 'C:/evil.zip'})));
});
test('reject duplicate IDs and legacy filenames', () => {
  assert.throws(() => validate(config(pack(), {...pack(), id: 'ONE'})));
  assert.throws(() => validate(config(pack(), {...pack(), id: 'two'})));
});
test('reject empty, missing and unsupported catalogs', () => {
  for (const value of [{}, config(), {schema_version: 2, modpacks: [pack()]}]) assert.throws(() => validate(value));
});
test('generate both packs with exact runtimes, hashes and commit-pinned escaped URLs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'larston-generator-'));
  try {
    await mkdir(path.join(root, 'mods'));
    await mkdir(path.join(root, 'mods1'));
    await writeFile(path.join(root, 'mods', 'a + b.jar'), 'neo');
    await writeFile(path.join(root, 'mods1', 'optExtra.jar'), 'fabric');
    await writeFile(path.join(root, 'data.zip'), 'zip');
    await writeFile(path.join(root, 'modpacks.json'), JSON.stringify(config(
      {...pack(), additional_files: 'data.zip'},
      {...pack(), id: 'two', mod_loader: 'fabric', minecraft_version: '1.21.11', mod_loader_version: '0.20.1', mods_directory: 'mods1', legacy_manifest: 'mods-manifest2.json'})));
    const output = path.join(root, 'out');
    const catalog = await generate({root, output, repository: 'fen417/Minecraft-Mods', revision: 'a'.repeat(40)});
    assert.equal(catalog.modpacks[1].minecraft_version, '1.21.11');
    assert.equal(catalog.modpacks[1].mod_loader_version, '0.20.1');
    assert.match(catalog.modpacks[0].mods[0].download_url, /a{40}\/mods\/a%20%2B%20b.jar$/);
    assert.equal(catalog.modpacks[0].mods[0].hash.length, 64);
    assert.equal(catalog.modpacks[0].additional_files.hash.length, 64);
    assert.equal(catalog.modpacks[1].mods[0].is_optional, true);
    const legacy = JSON.parse(await readFile(path.join(output, 'mods-manifest.json'), 'utf8'));
    assert.equal(legacy.mods[0].hash.length, 32);
    assert.equal(legacy.minecraft_version, '1.21.1');
  } finally { await rm(root, {recursive: true, force: true}); }
});
test('refuse empty modded pack instead of publishing a manifest that removes all mods', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'larston-empty-'));
  try {
    await mkdir(path.join(root, 'mods'));
    await writeFile(path.join(root, 'modpacks.json'), JSON.stringify(config(pack())));
    await assert.rejects(generate({root, output: path.join(root, 'out'), repository: 'a/b', revision: 'b'.repeat(40)}), /No mods found/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
