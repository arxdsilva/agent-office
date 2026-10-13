#!/usr/bin/env node
// Night City asset build (docs/graphics-contract.md §14, docs/special-3d/assets.md).
//
//   node assets/special3d/build.mjs --quality final|draft   Blender build → gltf-transform → public/special3d
//   node assets/special3d/build.mjs --test                  Blender-side tests (naming, budgets, no logos, wall ids)
//   node assets/special3d/build.mjs --previews [--shots a,b] stills of the set → assets/previews/special3d/
//   node assets/special3d/build.mjs --verify                re-validate public/special3d (the 'special' profile)
//
// Options: --modules hq-atrium,command,skyline (default: all)  --jobs N  --skip-character
//
// It shares the optimizer, lightmap tiers and Blender helpers with the classic build (assets/lib/pipeline.mjs)
// but never reads or writes packages/web/public/assets: it publishes only to packages/web/public/special3d and
// assets/special3d/{out,draft}.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSETS,
  BLENDER_DIR,
  CACHE,
  ROOT,
  blenderArgs,
  ensureSources,
  findBlender,
  glbStats,
  gltfTools,
  lightmapEntries,
  lightmapTiers,
  mergeFragments,
  moduleFiles,
  optimizeGlb,
  optimizePng,
  pool,
  run,
  sha256,
  walk,
} from '../lib/pipeline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECIAL_DIR = path.join(BLENDER_DIR, 'special3d');
const PUBLIC = path.join(ROOT, 'packages', 'web', 'public', 'special3d');
const PREVIEWS = path.join(ASSETS, 'previews', 'special3d');
const ALL_MODULES = ['hq-atrium', 'command', 'skyline'];

function parseArgs(argv) {
  const a = { quality: 'final', modules: ALL_MODULES, jobs: 0, mode: 'build', skipCharacter: false, shots: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--quality') a.quality = argv[++i];
    else if (k === '--modules') a.modules = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--jobs') a.jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (k === '--test') a.mode = 'test';
    else if (k === '--previews') a.mode = 'previews';
    else if (k === '--verify') a.mode = 'verify';
    else if (k === '--shots') a.shots = argv[++i];
    else if (k === '--skip-character') a.skipCharacter = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!['final', 'draft'].includes(a.quality)) throw new Error('--quality must be final|draft');
  // GPU memory is shared with any other Blender (the classic build may run concurrently): final bakes one at a time.
  if (!a.jobs) a.jobs = a.quality === 'final' || a.mode === 'previews' ? 1 : 2;
  for (const m of a.modules) if (!ALL_MODULES.includes(m)) throw new Error(`unknown module ${m}`);
  return a;
}

/** Build inputs: the Night City scripts, the shared Blender lib and character, the pins and both .mjs files. */
function inputHash(quality, pins) {
  const h = createHash('sha256');
  h.update(`set=special\nquality=${quality}\n`);
  const dirs = [SPECIAL_DIR, path.join(BLENDER_DIR, 'lib'), path.join(BLENDER_DIR, 'character')];
  for (const f of dirs.flatMap((d) => walk(d)).sort())
    h.update(`${path.relative(ASSETS, f).split(path.sep).join('/')}\0${sha256(fs.readFileSync(f))}\n`);
  for (const [file, sum] of Object.entries(pins.sha256).sort(([a], [b]) => a.localeCompare(b))) h.update(`${file}\0${sum}\n`);
  for (const f of [fileURLToPath(import.meta.url), path.join(ASSETS, 'lib', 'pipeline.mjs')])
    h.update(`${path.relative(ASSETS, f)}\0${sha256(fs.readFileSync(f))}\n`);
  return h.digest('hex');
}

/** Publish a staged build: public/special3d gets exactly the stage; assets/special3d/out|draft also keeps the PNG lightmaps. */
function publish(stage, pngStage, outDir) {
  if (!PUBLIC.endsWith(path.join('public', 'special3d'))) throw new Error(`refusing to publish to ${PUBLIC}`);
  fs.rmSync(PUBLIC, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC, { recursive: true });
  fs.cpSync(stage, PUBLIC, { recursive: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(stage, outDir, { recursive: true });
  fs.cpSync(pngStage, outDir, { recursive: true });
}

async function verify(dir) {
  const { validateAssets, MB } = await import('../validate.ts');
  const r = await validateAssets(dir, 'special');
  console.table(r.files.map((f) => ({ file: f.file, MB: +(f.bytes / MB).toFixed(2), tris: f.triangles })));
  console.log(`[asset] special set total ${(r.totalBytes / MB).toFixed(1)} MB; GPU textures ${(r.vram.textures / MB).toFixed(1)} MB in ${r.vram.uniqueTextures} unique`);
  if (r.problems.length) {
    for (const p of r.problems) console.error(`[asset] FAIL ${p}`);
    throw new Error(`${r.problems.length} Night City asset problem(s)`);
  }
  console.log('[asset] special verify ok');
}

async function build(args) {
  const t0 = Date.now();
  const blender = await findBlender();
  const { pins } = await ensureSources();
  const hash = inputHash(args.quality, pins);
  const outDir = path.join(HERE, args.quality === 'final' ? 'out' : 'draft');
  const work = path.join(CACHE, `special-work-${args.quality}`);
  const logs = path.join(work, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  console.log(`[asset] Night City: Blender ${blender.version}, quality ${args.quality}, ${args.modules.length} module(s), hash ${hash.slice(0, 12)}`);
  const script = path.join(SPECIAL_DIR, 'build.py');
  const hdri = path.join(work, 'hdri', 'night.hdr');
  await run(blender.bin, blenderArgs(script, ['--hdri', hdri]), { logFile: path.join(logs, 'hdri.log') });

  await pool(args.modules, args.jobs, async (m) => {
    const t = Date.now();
    await run(blender.bin, blenderArgs(script, ['--out', work, '--quality', args.quality, '--modules', m]), {
      logFile: path.join(logs, `${m}.log`),
    });
    console.log(`[asset] ${m} done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  });

  let character = false;
  const charScript = path.join(SPECIAL_DIR, 'character_cyber.py');
  if (!args.skipCharacter && fs.existsSync(charScript)) {
    const t = Date.now();
    try {
      await run(blender.bin, blenderArgs(charScript, ['--out', work, '--quality', args.quality]), { logFile: path.join(logs, 'character-cyber.log') });
      character = fs.existsSync(path.join(work, 'character-cyber.glb')) && fs.existsSync(path.join(work, 'character-cyber.json'));
      if (character) console.log(`[asset] character-cyber done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
    } catch {
      console.warn(`[asset] WARN character-cyber build failed (${path.join(logs, 'character-cyber.log')}); continuing without it`);
    }
  } else if (!args.skipCharacter) console.warn('[asset] WARN special3d/character_cyber.py not found; continuing without the character');
  // A partial build may reuse the character of an earlier one in the same work dir.
  if (!character && fs.existsSync(path.join(work, 'character-cyber.glb')) && fs.existsSync(path.join(work, 'character-cyber.json'))) character = true;

  const modules = mergeFragments(work, ALL_MODULES);
  const manifest = { version: 1, set: 'special', blender: blender.version, units: 'm', hash, hdri: 'hdri/night.hdr', modules };
  if (character) manifest.character = { file: 'character-cyber.glb', meta: 'character-cyber.json' };

  const stage = path.join(work, 'stage');
  const pngStage = path.join(work, 'stage-png');
  for (const d of [stage, pngStage]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'hdri'), { recursive: true });
  fs.mkdirSync(pngStage, { recursive: true });
  const tools = await gltfTools();
  const rows = [];
  for (const f of moduleFiles(modules)) {
    await optimizeGlb(tools, path.join(work, f), path.join(stage, f));
    const s = await glbStats(tools, path.join(stage, f));
    const stats = JSON.parse(fs.readFileSync(path.join(work, f.replace(/\.glb$/, '.stats.json')), 'utf8'));
    rows.push({ file: f, MB: +(fs.statSync(path.join(stage, f)).size / 2 ** 20).toFixed(2), tris: s.tris, draws: s.draws, bake_s: stats.bake_seconds ?? '-' });
  }
  for (const { base, lm } of lightmapEntries(manifest)) {
    await optimizePng(tools, path.join(work, lm.file), path.join(pngStage, lm.file));
    lm.variants = await lightmapTiers(tools, path.join(work, lm.file), stage, base);
    lm.file = lm.variants.full;
  }
  if (character) {
    await optimizeGlb(tools, path.join(work, 'character-cyber.glb'), path.join(stage, 'character-cyber.glb'), { skinned: true });
    fs.copyFileSync(path.join(work, 'character-cyber.json'), path.join(stage, 'character-cyber.json'));
    rows.push({ file: 'character-cyber.glb', MB: +(fs.statSync(path.join(stage, 'character-cyber.glb')).size / 2 ** 20).toFixed(2) });
  }
  fs.copyFileSync(hdri, path.join(stage, 'hdri', 'night.hdr'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  publish(stage, pngStage, outDir);
  console.table(rows);
  console.log(`[asset] published ${walk(stage).length} files to ${path.relative(ROOT, PUBLIC)} and ${path.relative(ROOT, outDir)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await verify(PUBLIC);
}

async function test() {
  const blender = await findBlender();
  await ensureSources();
  const work = path.join(CACHE, 'special-work-test');
  fs.mkdirSync(work, { recursive: true });
  await run(blender.bin, blenderArgs(path.join(SPECIAL_DIR, 'tests', 'test_special.py'), []), { logFile: path.join(work, 'test_special.log') });
  console.log('[asset] special tests ok');
}

async function previews(args) {
  const blender = await findBlender();
  await ensureSources();
  const logs = path.join(CACHE, 'special-work-previews');
  fs.mkdirSync(PREVIEWS, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  const extra = args.shots ? ['--shots', args.shots] : [];
  await run(blender.bin, blenderArgs(path.join(SPECIAL_DIR, 'build.py'), ['--previews', PREVIEWS, '--quality', args.quality, '--modules', args.modules.join(','), ...extra]), {
    logFile: path.join(logs, 'previews.log'),
  });
  console.log(`[asset] previews in ${path.relative(ROOT, PREVIEWS)}`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.mode === 'build') await build(args);
  else if (args.mode === 'test') await test();
  else if (args.mode === 'previews') await previews(args);
  else if (args.mode === 'verify') await verify(PUBLIC);
} catch (e) {
  console.error(`[asset] ERROR ${e.message}`);
  process.exit(1);
}
