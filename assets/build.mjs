#!/usr/bin/env node
// Asset pipeline orchestrator (see docs/graphics-contract.md).
//
//   node assets/build.mjs --quality final|draft   headless Blender build → gltf-transform → public/assets
//   node assets/build.mjs --test                  Blender-side asset tests (+ the character's, when present)
//   node assets/build.mjs --previews              Eevee stills of every module → assets/previews/
//   node assets/build.mjs --verify                re-check the published assets (validator, budgets, anchors)
//   node assets/build.mjs --pin                   download Poly Haven sources and pin their sha256
//
// Options: --modules atrium,street,garden,cap,wing:terracotta,…  (default: all)   --jobs N (parallel Blender
// processes; default 3 for draft, 1 for final and previews)   --skip-character
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(ASSETS);
const BLENDER_DIR = path.join(ASSETS, 'blender');
const CACHE = path.join(ASSETS, 'cache');
const PUBLIC = path.join(ROOT, 'packages', 'web', 'public', 'assets');
const PINS_FILE = path.join(BLENDER_DIR, 'polyhaven.json');
const BLENDER_VERSION = '5.2';
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
  const a = { quality: 'final', modules: ALL_MODULES, jobs: 0, mode: 'build', skipCharacter: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--quality') a.quality = argv[++i];
    else if (k === '--modules') a.modules = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--jobs') a.jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (k === '--test') a.mode = 'test';
    else if (k === '--previews') a.mode = 'previews';
    else if (k === '--verify') a.mode = 'verify';
    else if (k === '--pin') a.mode = 'pin';
    else if (k === '--skip-character') a.skipCharacter = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!['final', 'draft'].includes(a.quality)) throw new Error(`--quality must be final|draft`);
  // GPU memory (unified, shared with any open Blender): final bakes and Cycles previews run one at a time.
  if (!a.jobs) a.jobs = a.quality === 'final' || a.mode === 'previews' ? 1 : 3;
  for (const m of a.modules) if (!ALL_MODULES.includes(m)) throw new Error(`unknown module ${m}`);
  return a;
}

// ------------------------------------------------------------------------------------------- blender
function childEnv() {
  // Never leak Electron's "run as node" switches into Blender (or anything else we spawn).
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ELECTRON_')) env[k] = v;
  return env;
}

function run(cmd, args, { logFile, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv(), cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = logFile ? fs.createWriteStream(logFile) : null;
    let tail = '';
    const onData = (buf) => {
      const s = buf.toString();
      log?.write(s);
      tail = (tail + s).slice(-6000);
      if (!quiet) {
        for (const line of s.split('\n')) if (line.startsWith('[asset]') || line.startsWith('[test]')) console.log(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      log?.end();
      if (code === 0) resolve(tail);
      else reject(Object.assign(new Error(`${path.basename(cmd)} exited with ${code}\n${tail}`), { tail }));
    });
  });
}

async function findBlender() {
  const bin = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(bin)) throw new Error(`Blender not found at ${bin} (set $BLENDER)`);
  const out = await run(bin, ['--version'], { quiet: true });
  const m = out.match(/Blender (\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`cannot parse Blender version from: ${out.slice(0, 200)}`);
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  if (`${m[1]}.${m[2]}` !== BLENDER_VERSION) throw new Error(`Blender ${BLENDER_VERSION}.x required, found ${version}`);
  return { bin, version };
}

function blenderArgs(script, scriptArgs) {
  return ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...scriptArgs];
}

async function pool(items, jobs, fn) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------------------- poly haven
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sourceList(pins) {
  const list = [];
  for (const [id, t] of Object.entries(pins.textures)) {
    for (const map of t.maps) {
      const file = `${id}_${map}_${t.res}.jpg`;
      list.push({ file: `textures/${file}`, url: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${t.res}/${id}/${file}` });
    }
  }
  const h = pins.hdri;
  const hf = `${h.id}_${h.res}.hdr`;
  list.push({ file: `hdri/${hf}`, url: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${h.res}/${hf}` });
  return list;
}

async function ensureSources({ pin = false } = {}) {
  const pins = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
  const list = sourceList(pins);
  let changed = false;
  for (const { file, url } of list) {
    const dest = path.join(CACHE, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      console.log(`[asset] download ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
    const sum = sha256(fs.readFileSync(dest));
    const pinned = pins.sha256[file];
    if (!pinned || pin) {
      if (!pin) throw new Error(`no sha256 pin for ${file}; run node assets/build.mjs --pin`);
      if (pinned !== sum) changed = true;
      pins.sha256[file] = sum;
    } else if (pinned !== sum) {
      throw new Error(`sha256 mismatch for ${file} (cached ${sum}, pinned ${pinned}); delete assets/cache/${file}`);
    }
  }
  if (pin && changed) {
    pins.sha256 = Object.fromEntries(Object.entries(pins.sha256).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2) + '\n');
    console.log(`[asset] pinned ${list.length} files in ${path.relative(ROOT, PINS_FILE)}`);
  }
  return { pins, hdri: path.join(CACHE, list[list.length - 1].file) };
}

// ---------------------------------------------------------------------------------------------- hash
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function inputHash(quality, pins) {
  const h = createHash('sha256');
  h.update(`quality=${quality}\n`);
  for (const f of walk(BLENDER_DIR).sort()) {
    h.update(`${path.relative(ASSETS, f).split(path.sep).join('/')}\0${sha256(fs.readFileSync(f))}\n`);
  }
  for (const [file, sum] of Object.entries(pins.sha256).sort(([a], [b]) => a.localeCompare(b))) h.update(`${file}\0${sum}\n`);
  h.update(`build.mjs\0${sha256(fs.readFileSync(fileURLToPath(import.meta.url)))}\n`);
  return h.digest('hex');
}

// ------------------------------------------------------------------------------------------ optimize
async function gltfTools() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const fns = await import('@gltf-transform/functions');
  const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
  const sharp = (await import('sharp')).default;
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  return { io, fns, sharp, MeshoptEncoder };
}

async function optimizeGlb(tools, src, dest, { skinned = false } = {}) {
  const { io, fns, sharp, MeshoptEncoder } = tools;
  const doc = await io.read(src);
  const steps = [
    fns.dedup(),
    // keepAttributes: TEXCOORD_1 (lightmap UVs) is not referenced by any material but the runtime needs it.
    fns.prune({ keepAttributes: true, keepExtras: true, keepLeaves: skinned }),
    fns.weld(),
    fns.textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 82, resize: [1024, 1024], slots: /^baseColor/ }),
    fns.textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 82, resize: [512, 512], slots: /^(normal|metallicRoughness|occlusion|emissive)/ }),
  ];
  // No instance(): static geometry is joined and lightmapped (unique UV1), and runtime-driven nodes must
  // keep their own extras, so there is nothing that may be merged into EXT_mesh_gpu_instancing.
  if (skinned) steps.push(fns.meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  else steps.push(fns.meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 16, quantizeTexcoord: 16, quantizeNormal: 10 }));
  await doc.transform(...steps);
  await io.write(dest, doc);
}

async function optimizePng(tools, src, dest) {
  const buf = await tools.sharp(src).png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toBuffer();
  fs.writeFileSync(dest, buf);
}

// -------------------------------------------------------------------------------------------- verify
async function inspectGlb(tools, file) {
  const doc = await tools.io.read(file);
  let tris = 0;
  let draws = 0;
  const roles = {};
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const role = node.getExtras()?.role ?? 'none';
    roles[role] = (roles[role] ?? 0) + 1;
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : prim.getAttribute('POSITION').getCount();
      if (role !== 'collider') {
        tris += count / 3;
        draws += 1;
      }
    }
  }
  return { tris: Math.round(tris), draws, roles };
}

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
    const info = await inspectGlb(tools, p);
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
  console.log(`[asset] total ${(total / 1e6).toFixed(2)} MB`);
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

// ---------------------------------------------------------------------------------------------- main
function moduleSlug(m) {
  return m.replace(':', '-');
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
  const modules = {};
  const wingThemes = {};
  let wingShared = null;
  for (const m of ALL_MODULES) {
    const frag = path.join(work, `${moduleSlug(m)}.json`);
    if (!fs.existsSync(frag)) continue;
    const f = JSON.parse(fs.readFileSync(frag, 'utf8'));
    if (m.startsWith('wing:')) {
      const theme = m.slice(5);
      wingThemes[theme] = f.theme;
      if (!wingShared) wingShared = f.module;
      else if (JSON.stringify(wingShared.anchors) !== JSON.stringify(f.module.anchors) || JSON.stringify(wingShared.nav) !== JSON.stringify(f.module.nav))
        throw new Error(`wing:${theme} anchors/nav differ from the other themes`);
    } else modules[m] = f.module;
  }
  if (wingShared) {
    const themes = {};
    for (const t of THEMES) if (wingThemes[t]) themes[t] = wingThemes[t];
    modules.wing = { themes, ...wingShared };
  }

  const manifest = { version: 1, blender: blender.version, units: 'm', hash, hdri: 'hdri/office.hdr', modules };
  if (character) manifest.character = { file: 'character.glb', meta: 'character.json' };

  // Optimize into a staging dir, then publish to public/assets and assets/out|draft.
  const stage = path.join(work, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'hdri'), { recursive: true });
  const tools = await gltfTools();
  const files = [];
  for (const [id, m] of Object.entries(modules)) {
    if (id === 'wing') for (const t of Object.values(m.themes)) files.push(t.file, t.lightmap.file);
    else files.push(m.file, m.lightmap.file);
  }
  for (const f of files) {
    const src = path.join(work, f);
    if (f.endsWith('.glb')) await optimizeGlb(tools, src, path.join(stage, f));
    else await optimizePng(tools, src, path.join(stage, f));
  }
  if (character) {
    await optimizeGlb(tools, path.join(work, 'character.glb'), path.join(stage, 'character.glb'), { skinned: true });
    fs.copyFileSync(path.join(work, 'character.json'), path.join(stage, 'character.json'));
  }
  fs.copyFileSync(hdri, path.join(stage, 'hdri', 'office.hdr'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  for (const dest of [PUBLIC, outDir]) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(stage, dest, { recursive: true });
  }
  console.log(`[asset] published ${files.length + 2} files to ${path.relative(ROOT, PUBLIC)} and ${path.relative(ROOT, outDir)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await verify(tools, PUBLIC);
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
  else if (args.mode === 'verify') await verify(await gltfTools(), PUBLIC);
} catch (e) {
  console.error(`[asset] ERROR ${e.message}`);
  process.exit(1);
}
