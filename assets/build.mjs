#!/usr/bin/env node
// Asset pipeline orchestrator (see docs/graphics-contract.md).
//
//   node assets/build.mjs --quality final|draft   headless Blender build → gltf-transform → public/assets
//   node assets/build.mjs --test                  Blender-side asset tests (+ the character's, when present)
//   node assets/build.mjs --previews              Eevee stills of every module → assets/previews/
//   node assets/build.mjs --verify                re-check the published assets (validator, budgets, anchors, VRAM)
//   node assets/build.mjs --verify --visual       … plus SSIM of the lightmap tiers against their sources
//   node assets/build.mjs --repack                re-run the optimize step (WebP textures + extras.hash, lightmap
//                                                 tiers) from the last Blender export, no bake
//   node assets/build.mjs --pin                   download Poly Haven sources and pin their sha256
//   node assets/build.mjs --plan-only             export the floor plans (contract §11) into the published
//                                                 manifest.json (public/assets + assets/out); no bake, glbs
//                                                 and lightmaps untouched
//
// Options: --modules atrium,street,garden,cap,wing:terracotta,…  (default: all)   --jobs N (parallel Blender
// processes; default 3 for draft, 1 for final and previews)   --skip-character
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
  gltfTools,
  glbStats,
  lightmapEntries,
  lightmapTiers,
  mergeFragments,
  moduleFiles,
  moduleSlug,
  mergeWingPlans,
  optimizeGlb,
  optimizePng,
  pool,
  rgbaOf,
  run,
  sha256,
  walk,
} from './lib/pipeline.mjs';

const PUBLIC = path.join(ROOT, 'packages', 'web', 'public', 'assets');
const OUT = path.join(ASSETS, 'out');
/** Raw Blender exports of the last final build (full-quality JPEG textures, 8-bit PNG lightmaps). */
const RAW = path.join(CACHE, 'work-final');
const THEMES = ['terracotta', 'nordic', 'forest', 'ocean', 'neon', 'brass'];
const ALL_MODULES = ['atrium', 'street', 'garden', 'cap', ...THEMES.map((t) => `wing:${t}`)];

const BUDGETS = {
  atrium: { bytes: 12e6, tris: 250e3, draws: 120 },
  wing: { bytes: 6e6, tris: 190e3, draws: 140 },
  street: { bytes: 3e6, tris: 60e3, draws: 40 },
  garden: { bytes: 3e6, tris: 60e3, draws: 40 },
  cap: { bytes: 3e6, tris: 60e3, draws: 40 },
  character: { bytes: 1.5e6 },
  total: 55e6,
};

// ---------------------------------------------------------------------------------------------- args
function parseArgs(argv) {
  const a = { quality: 'final', modules: ALL_MODULES, jobs: 0, mode: 'build', skipCharacter: false, visual: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--quality') a.quality = argv[++i];
    else if (k === '--modules') a.modules = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--jobs') a.jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (k === '--test') a.mode = 'test';
    else if (k === '--previews') a.mode = 'previews';
    else if (k === '--verify') a.mode = 'verify';
    else if (k === '--pin') a.mode = 'pin';
    else if (k === '--repack') a.mode = 'repack';
    else if (k === '--plan-only') a.mode = 'plan';
    else if (k === '--visual') a.visual = true;
    else if (k === '--skip-character') a.skipCharacter = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!['final', 'draft'].includes(a.quality)) throw new Error(`--quality must be final|draft`);
  // GPU memory (unified, shared with any open Blender): final bakes and Cycles previews run one at a time.
  if (!a.jobs) a.jobs = a.mode === 'plan' ? 4 : a.quality === 'final' || a.mode === 'previews' ? 1 : 3;
  for (const m of a.modules) if (!ALL_MODULES.includes(m)) throw new Error(`unknown module ${m}`);
  return a;
}

// ---------------------------------------------------------------------------------------------- hash
function inputHash(quality, pins) {
  const h = createHash('sha256');
  h.update(`quality=${quality}\n`);
  // The Night City scripts (blender/special3d, contract §14) are not inputs of the classic set.
  const special = path.join(BLENDER_DIR, 'special3d') + path.sep;
  for (const f of walk(BLENDER_DIR).filter((f) => !f.startsWith(special)).sort()) {
    h.update(`${path.relative(ASSETS, f).split(path.sep).join('/')}\0${sha256(fs.readFileSync(f))}\n`);
  }
  for (const [file, sum] of Object.entries(pins.sha256).sort(([a], [b]) => a.localeCompare(b))) h.update(`${file}\0${sum}\n`);
  h.update(`build.mjs\0${sha256(fs.readFileSync(fileURLToPath(import.meta.url)))}\n`);
  h.update(`lib/pipeline.mjs\0${sha256(fs.readFileSync(path.join(ASSETS, 'lib', 'pipeline.mjs')))}\n`);
  return h.digest('hex');
}

/** Publish a staged build: public/assets gets exactly the stage; assets/out|draft also keeps the PNG lightmap sources. */
function publish(stage, pngStage, outDir) {
  fs.rmSync(PUBLIC, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC, { recursive: true });
  fs.cpSync(stage, PUBLIC, { recursive: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(stage, outDir, { recursive: true });
  fs.cpSync(pngStage, outDir, { recursive: true });
}

// -------------------------------------------------------------------------------------------- verify
async function verify(tools, dir) {
  const validator = (await import('gltf-validator')).default;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const problems = [];
  const rows = [];
  let total = 0;
  for (const f of walk(dir)) total += fs.statSync(f).size;
  const files = [];
  for (const [id, m] of Object.entries(manifest.modules)) {
    if (id === 'wing') for (const [t, w] of Object.entries(m.themes)) files.push({ kind: 'wing', label: `wing-${t}`, file: w.file, lightmap: w.lightmap?.file });
    else files.push({ kind: id, label: id, file: m.file, lightmap: m.lightmap?.file });
  }
  if (manifest.character) files.push({ kind: 'character', label: 'character', file: manifest.character.file });
  for (const f of files) {
    const p = path.join(dir, f.file);
    if (!fs.existsSync(p)) {
      problems.push(`${f.file} missing`);
      continue;
    }
    const bytes = fs.readFileSync(p);
    const report = await validator.validateBytes(new Uint8Array(bytes), { maxIssues: 50, ignoredIssues: ['UNUSED_OBJECT'] });
    const info = await glbStats(tools, p);
    const lmBytes = f.lightmap ? fs.statSync(path.join(dir, f.lightmap)).size : 0;
    const b = BUDGETS[f.kind];
    rows.push({ file: f.file, kb: Math.round(bytes.length / 1024), lightmapKb: Math.round(lmBytes / 1024), tris: info.tris, draws: info.draws, errors: report.issues.numErrors, warnings: report.issues.numWarnings });
    if (report.issues.numErrors > 0) problems.push(`${f.file}: ${report.issues.numErrors} validator errors: ${report.issues.messages.filter((m) => m.severity === 0).slice(0, 3).map((m) => `${m.code} ${m.pointer}`).join('; ')}`);
    if (b?.bytes && bytes.length > b.bytes) problems.push(`${f.file}: ${bytes.length} bytes > ${b.bytes}`);
    if (b?.tris && info.tris > b.tris) problems.push(`${f.file}: ${info.tris} triangles > ${b.tris}`);
    if (b?.draws && info.draws > b.draws) problems.push(`${f.file}: ${info.draws} draw calls > ${b.draws}`);
  }
  if (total > BUDGETS.total) problems.push(`public assets total ${total} bytes > ${BUDGETS.total}`);
  console.table(rows);
  console.log(`[asset] total ${(total / 1e6).toFixed(2)} MB (${(total / 2 ** 20).toFixed(1)} MiB)`);
  // The CI validator (assets/validate.ts): texture hashes, lightmap tiers, VRAM estimate (AV-1..4).
  const { validateAssets } = await import('./validate.ts');
  const report = await validateAssets(dir);
  const MiB = (b) => `${(b / 2 ** 20).toFixed(1)} MB`;
  const lm = report.vram.lightmaps;
  console.log(`[asset] GPU texture estimate (RGBA8 × 4/3): glb textures ${MiB(report.vram.textures)} in ${report.vram.uniqueTextures} unique; + lightmaps full ${MiB(report.vram.textures + lm.full)}, half ${MiB(report.vram.textures + lm.half)}, quarter ${MiB(report.vram.textures + lm.quarter)}`);
  problems.push(...report.problems);
  // Anchors / nav (a light duplicate of the Blender-side test, on the published manifest).
  const need = {
    wing: {
      'seat:desk': 24, 'seat:meeting:A': 6, 'seat:meeting:B': 6, 'spot:booth': 4, 'spot:kitchen': 6, 'seat:lounge': 8,
      'spot:station': 8, 'seat:reading': 4, 'spot:shelf': 2, 'port:desk': 24, 'port:station': 8, 'port:book': 24,
      'port:board': 6, 'port:notebook': 8,
    },
    atrium: { 'spot:reception': 4, 'spot:elevator': 6, 'seat:cafe': 24, 'spot:pingpong': 4 },
    garden: { 'spot:garden': 6 },
  };
  for (const [id, m] of Object.entries(manifest.modules)) {
    for (const [prefix, n] of Object.entries(need[id] ?? {})) {
      const got = Object.keys(m.anchors).filter((k) => k.startsWith(prefix + ':')).length;
      if (got !== n) problems.push(`${id}: ${got} anchors ${prefix}:*, expected ${n}`);
    }
    const nodes = m.nav.nodes;
    const adj = new Map(Object.keys(nodes).map((k) => [k, []]));
    for (const [a, b] of m.nav.edges) {
      if (!adj.has(a) || !adj.has(b)) problems.push(`${id}: edge to unknown node ${a}–${b}`);
      else adj.get(a).push(b), adj.get(b).push(a);
    }
    const start = Object.keys(nodes)[0];
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const n of adj.get(stack.pop()) ?? []) if (!seen.has(n)) seen.add(n), stack.push(n);
    if (seen.size !== adj.size) problems.push(`${id}: nav graph disconnected (${seen.size}/${adj.size})`);
    for (const [aid, a] of Object.entries(m.anchors)) {
      if (!a.approach) continue;
      const ok = Object.values(nodes).some((n) => Math.hypot(n.x - a.approach.x, n.z - a.approach.z) <= 0.05);
      if (!ok) problems.push(`${id}: approach of ${aid} not on a nav node`);
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`[asset] FAIL ${p}`);
    throw new Error(`${problems.length} asset problem(s)`);
  }
  console.log('[asset] verify ok');
}

// ------------------------------------------------------------------------------------ visual (AV-visual)
const SSIM_MIN = 0.97;
const VISUAL_MODULES = ['atrium', 'wing-terracotta'];

/**
 * --verify --visual: SSIM of the shipped lightmap tiers against their PNG source (atrium, terracotta),
 * gated at ≥ 0.97 (full tier exact size; ½ and ¼ against a lanczos3 downscale of the source). Base
 * colour (WebP q82, unchanged by this mode) is reported against the raw export for context.
 */
async function visual(tools) {
  const { ssim } = await import('./validate.ts');
  const { sharp, io } = tools;
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf8'));
  const rows = [];
  const fails = [];
  const score = (a, b) => ssim(a.data, b.data, a.width, a.height);
  for (const { base, lm } of lightmapEntries(manifest).filter((e) => VISUAL_MODULES.includes(e.base))) {
    const png = [RAW, OUT].map((d) => path.join(d, `${base}.lightmap.png`)).find((f) => fs.existsSync(f));
    if (!png) {
      console.warn(`[asset] WARN no source PNG for ${base}; skipped`);
      continue;
    }
    for (const tier of ['full', 'half', 'quarter']) {
      const shipped = await rgbaOf(sharp, path.join(PUBLIC, lm.variants[tier]));
      const s = score(shipped, await rgbaOf(sharp, png, [shipped.width, shipped.height]));
      rows.push({ image: `${base} lightmap ${tier}`, size: `${shipped.width}²`, ssim: s.toFixed(4), gated: 'yes' });
      if (s < SSIM_MIN) fails.push(`${base} lightmap ${tier}: SSIM ${s.toFixed(4)} < ${SSIM_MIN}`);
    }
  }
  for (const base of VISUAL_MODULES) {
    const rawGlb = path.join(RAW, `${base}.glb`);
    if (!fs.existsSync(rawGlb)) continue;
    const raw = new Map((await io.read(rawGlb)).getRoot().listTextures().map((t) => [t.getName(), t]));
    const doc = await io.read(path.join(PUBLIC, `${base}.glb`));
    for (const t of doc.getRoot().listTextures()) {
      const src = raw.get(t.getName()) ?? raw.get(t.getName().replace(/\.webp$/, ''));
      if (!src || !/diff/.test(t.getName())) continue;
      const shipped = await rgbaOf(sharp, t.getImage());
      rows.push({ image: `${base} ${t.getName()}`, size: `${shipped.width}²`, ssim: score(shipped, await rgbaOf(sharp, src.getImage(), [shipped.width, shipped.height])).toFixed(4), gated: 'no (WebP q82, as before)' });
    }
  }
  console.table(rows);
  if (fails.length) {
    for (const p of fails) console.error(`[asset] FAIL ${p}`);
    throw new Error(`${fails.length} lightmap tier(s) below SSIM ${SSIM_MIN}`);
  }
  console.log(`[asset] visual ok (lightmap tiers SSIM ≥ ${SSIM_MIN})`);
}

async function build(args) {
  const t0 = Date.now();
  const blender = await findBlender();
  const { pins, hdri } = await ensureSources();
  const hash = inputHash(args.quality, pins);
  const outDir = args.quality === 'final' ? path.join(ASSETS, 'out') : path.join(ASSETS, 'draft');
  const work = path.join(CACHE, `work-${args.quality}`);
  const logs = path.join(work, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  console.log(`[asset] Blender ${blender.version}, quality ${args.quality}, ${args.modules.length} module(s), hash ${hash.slice(0, 12)}`);

  await pool(args.modules, args.jobs, async (m) => {
    const t = Date.now();
    await run(blender.bin, blenderArgs(path.join(BLENDER_DIR, 'build.py'), ['--out', work, '--quality', args.quality, '--modules', m]), {
      logFile: path.join(logs, `${moduleSlug(m)}.log`),
    });
    console.log(`[asset] ${m} done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  });

  let character = null;
  const charScript = path.join(BLENDER_DIR, 'modules', 'character.py');
  if (!args.skipCharacter && fs.existsSync(charScript)) {
    try {
      const t = Date.now();
      await run(blender.bin, blenderArgs(charScript, ['--out', work, '--quality', args.quality]), { logFile: path.join(logs, 'character.log') });
      if (fs.existsSync(path.join(work, 'character.glb')) && fs.existsSync(path.join(work, 'character.json'))) {
        character = true;
        console.log(`[asset] character done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
      } else console.warn('[asset] WARN character.py ran but did not write character.glb/character.json; continuing without it');
    } catch (e) {
      console.warn(`[asset] WARN character build failed, continuing without it (${path.join(logs, 'character.log')})`);
    }
  } else if (!args.skipCharacter) console.warn('[asset] WARN assets/blender/modules/character.py not found; continuing without character');

  // Merge module fragments (a partial --modules build reuses earlier fragments from the same work dir).
  const modules = mergeFragments(work, ALL_MODULES, THEMES);

  const manifest = { version: 1, blender: blender.version, units: 'm', hash, hdri: 'hdri/office.hdr', modules };
  if (character) manifest.character = { file: 'character.glb', meta: 'character.json' };

  // Optimize into a staging dir, then publish to public/assets and assets/out|draft.
  const stage = path.join(work, 'stage');
  const pngStage = path.join(work, 'stage-png');
  for (const d of [stage, pngStage]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'hdri'), { recursive: true });
  fs.mkdirSync(pngStage, { recursive: true });
  const tools = await gltfTools();
  for (const f of moduleFiles(modules)) await optimizeGlb(tools, path.join(work, f), path.join(stage, f));
  // Lightmaps: the PNG stays in assets/out|draft as the source; public/assets gets the WebP tiers.
  for (const { base, lm } of lightmapEntries(manifest)) {
    const png = path.join(pngStage, lm.file);
    await optimizePng(tools, path.join(work, lm.file), png);
    lm.variants = await lightmapTiers(tools, path.join(work, lm.file), stage, base);
    lm.file = lm.variants.full;
  }
  if (character) {
    await optimizeGlb(tools, path.join(work, 'character.glb'), path.join(stage, 'character.glb'), { skinned: true });
    fs.copyFileSync(path.join(work, 'character.json'), path.join(stage, 'character.json'));
  }
  fs.copyFileSync(hdri, path.join(stage, 'hdri', 'office.hdr'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  publish(stage, pngStage, outDir);
  console.log(`[asset] published ${walk(stage).length} files to ${path.relative(ROOT, PUBLIC)} and ${path.relative(ROOT, outDir)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await verify(tools, PUBLIC);
}

/**
 * --repack: re-run the optimize step without Blender. Sources, best first: the raw exports of the last
 * final build (assets/cache/work-final), then the published files (WebP is re-encoded). The
 * manifest is the published one with its lightmap entries rewritten (contract §6, §7).
 */
async function repack() {
  const t0 = Date.now();
  const manifestFile = [PUBLIC, OUT].map((d) => path.join(d, 'manifest.json')).find((f) => fs.existsSync(f));
  if (!manifestFile) throw new Error('no manifest.json in public/assets or assets/out; run make assets first');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const pick = (...candidates) => {
    const f = candidates.find((c) => fs.existsSync(c));
    if (!f) throw new Error(`no source for ${path.basename(candidates[0])}`);
    return f;
  };
  // Snapshot every published source first: publishing replaces public/assets and assets/out.
  const snap = path.join(CACHE, 'repack-src');
  const stage = path.join(CACHE, 'repack-stage');
  const pngStage = path.join(CACHE, 'repack-png');
  for (const d of [snap, stage, pngStage]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of [snap, path.join(stage, 'hdri'), pngStage]) fs.mkdirSync(d, { recursive: true });
  const fromPublished = (f) => {
    const src = pick(path.join(PUBLIC, f), path.join(OUT, f));
    const dst = path.join(snap, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return dst;
  };
  const tools = await gltfTools();
  const glbs = moduleFiles(manifest.modules);
  const sources = new Map();
  for (const f of glbs) sources.set(f, fs.existsSync(path.join(RAW, f)) ? path.join(RAW, f) : fromPublished(f));
  const lmSources = new Map();
  for (const { base } of lightmapEntries(manifest)) {
    const png = `${base}.lightmap.png`;
    lmSources.set(base, fs.existsSync(path.join(RAW, png)) ? path.join(RAW, png) : fromPublished(png));
  }
  const charSrc = manifest.character ? (fs.existsSync(path.join(RAW, manifest.character.file)) ? path.join(RAW, manifest.character.file) : fromPublished(manifest.character.file)) : null;
  const charMeta = manifest.character ? fromPublished(manifest.character.meta) : null;
  const hdri = fromPublished(manifest.hdri);

  for (const f of glbs) {
    const t = Date.now();
    await optimizeGlb(tools, sources.get(f), path.join(stage, f));
    console.log(`[asset] ${f} from ${path.relative(ROOT, sources.get(f))} in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
  for (const { base, lm } of lightmapEntries(manifest)) {
    const t = Date.now();
    const png = path.join(pngStage, `${base}.lightmap.png`);
    await optimizePng(tools, lmSources.get(base), png);
    lm.variants = await lightmapTiers(tools, lmSources.get(base), stage, base);
    lm.file = lm.variants.full;
    console.log(`[asset] ${base} lightmap tiers in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
  if (charSrc) {
    await optimizeGlb(tools, charSrc, path.join(stage, manifest.character.file), { skinned: true });
    fs.copyFileSync(charMeta, path.join(stage, manifest.character.meta));
  }
  fs.copyFileSync(hdri, path.join(stage, manifest.hdri));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  publish(stage, pngStage, OUT);
  console.log(`[asset] repacked ${walk(stage).length} files into ${path.relative(ROOT, PUBLIC)} and ${path.relative(ROOT, OUT)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await verify(tools, PUBLIC);
}

/**
 * --plan-only (make assets-plan): run each module builder without objects, bake or export, and merge the
 * floor plans (contract §11) into the published manifest.json in public/assets and assets/out. Nothing
 * else in the manifest changes; glbs and lightmaps are never touched.
 */
async function planOnly(args) {
  const t0 = Date.now();
  const targets = [PUBLIC, OUT].map((d) => path.join(d, 'manifest.json')).filter((f) => fs.existsSync(f));
  if (!targets.length) throw new Error('no manifest.json in public/assets or assets/out; run make assets first');
  const blender = await findBlender();
  await ensureSources();
  const work = path.join(CACHE, 'work-plan');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'logs'), { recursive: true });
  await pool(args.modules, args.jobs, (m) =>
    run(blender.bin, blenderArgs(path.join(BLENDER_DIR, 'build.py'), ['--out', work, '--plan-only', '--modules', m]), {
      logFile: path.join(work, 'logs', `${moduleSlug(m)}.log`),
    }),
  );
  const plans = {};
  const wing = [];
  for (const m of args.modules) {
    const { plan } = JSON.parse(fs.readFileSync(path.join(work, `${moduleSlug(m)}.plan.json`), 'utf8'));
    if (m.startsWith('wing:')) wing.push({ theme: m.slice(5), plan });
    else plans[m] = plan;
  }
  if (wing.length) {
    if (wing.length < THEMES.length) console.warn(`[asset] WARN the wing plan comes from ${wing.length}/${THEMES.length} themes`);
    plans.wing = mergeWingPlans(wing);
  }
  for (const [id, plan] of Object.entries(plans)) {
    const kinds = {};
    for (const f of plan.furniture) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    const openings = plan.walls.reduce((n, w) => n + (w.openings?.length ?? 0), 0);
    console.log(`[asset] ${id}: ${plan.rooms.length} rooms, ${plan.walls.length} walls (${openings} openings), ${plan.furniture.length} furniture ${JSON.stringify(kinds)}`);
  }
  const { checkPlans, checkPlanWallSides } = await import('./validate.ts');
  for (const file of targets) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, plan] of Object.entries(plans)) {
      if (!manifest.modules[id]) throw new Error(`${path.relative(ROOT, file)} has no module ${id}`);
      manifest.modules[id].plan = plan;
    }
    const problems = Object.keys(plans).length === 5 ? [...checkPlans(manifest), ...checkPlanWallSides(manifest)] : [];
    if (problems.length) {
      for (const p of problems) console.error(`[asset] FAIL ${p}`);
      throw new Error(`${problems.length} floor-plan problem(s); ${path.relative(ROOT, file)} not written`);
    }
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`[asset] plans merged into ${path.relative(ROOT, file)}`);
  }
  console.log(`[asset] plan-only done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

async function test() {
  const blender = await findBlender();
  await ensureSources();
  const work = path.join(CACHE, 'work-test');
  fs.mkdirSync(work, { recursive: true });
  await run(blender.bin, blenderArgs(path.join(BLENDER_DIR, 'tests', 'test_modules.py'), []), { logFile: path.join(work, 'test_modules.log') });
  const charTest = path.join(BLENDER_DIR, 'tests', 'test_character.py');
  if (fs.existsSync(charTest)) await run(blender.bin, blenderArgs(charTest, []), { logFile: path.join(work, 'test_character.log') });
  else console.warn('[asset] WARN tests/test_character.py not found; skipped');
  console.log('[asset] tests ok');
}

async function previews(args) {
  const blender = await findBlender();
  await ensureSources();
  const out = path.join(ASSETS, 'previews');
  const logs = path.join(CACHE, 'work-previews');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  await pool(args.modules, args.jobs, async (m) => {
    await run(blender.bin, blenderArgs(path.join(BLENDER_DIR, 'build.py'), ['--previews', out, '--quality', args.quality, '--modules', m]), {
      logFile: path.join(logs, `${moduleSlug(m)}.log`),
    });
  });
  console.log(`[asset] previews in ${path.relative(ROOT, out)}`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.mode === 'build') await build(args);
  else if (args.mode === 'test') await test();
  else if (args.mode === 'previews') await previews(args);
  else if (args.mode === 'pin') await ensureSources({ pin: true });
  else if (args.mode === 'repack') await repack();
  else if (args.mode === 'plan') await planOnly(args);
  else if (args.mode === 'verify') {
    await verify(await gltfTools(), PUBLIC);
    if (args.visual) await visual(await gltfTools());
  }
} catch (e) {
  console.error(`[asset] ERROR ${e.message}`);
  process.exit(1);
}
