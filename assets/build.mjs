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
const OUT = path.join(ASSETS, 'out');
/** Raw Blender exports of the last final build (full-quality JPEG textures, 8-bit PNG lightmaps). */
const RAW = path.join(CACHE, 'work-final');
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
    else if (k === '--visual') a.visual = true;
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
  const { NodeIO, Logger } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const fns = await import('@gltf-transform/functions');
  const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
  const sharp = (await import('sharp')).default;
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.ERROR))
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
  await hashTextures(tools, doc);
  await io.write(dest, doc);
}

async function optimizePng(tools, src, dest) {
  // Lossless: sharp's png `effort` (like quality/colours) switches to a 256-colour palette, which bands lightmaps.
  const buf = await tools.sharp(src).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  fs.writeFileSync(dest, buf);
}

// ------------------------------------------------------------------------- textures and lightmaps (§6, §6b)
// No KTX2: three's Basis transcoder needs eval (`new Function`), which the app's CSP forbids (§6b).

async function rgbaOf(sharp, input, size) {
  let img = sharp(Buffer.isBuffer(input) || typeof input === 'string' ? input : Buffer.from(input));
  if (size) img = img.resize(size[0], size[1], { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Contract §6b: extras.hash = sha1 over the decoded RGBA of the shipped image, first 12 hex chars. */
async function hashTextures(tools, doc) {
  for (const t of doc.getRoot().listTextures()) {
    const { data } = await rgbaOf(tools.sharp, t.getImage());
    t.setExtras({ ...t.getExtras(), hash: createHash('sha1').update(data).digest('hex').slice(0, 12) });
  }
}

/** Contract §6: full, ½ and ¼ tiers of a lightmap PNG as WebP (sharp lanczos3 downscales). */
async function lightmapTiers(tools, srcPng, destDir, base) {
  const meta = await tools.sharp(srcPng).metadata();
  const variants = {};
  for (const [tier, div] of [['full', 1], ['half', 2], ['quarter', 4]]) {
    let img = tools.sharp(srcPng);
    if (div > 1) img = img.resize(Math.max(1, Math.floor(meta.width / div)), Math.max(1, Math.floor(meta.height / div)), { fit: 'fill', kernel: 'lanczos3' });
    const file = `${base}.lightmap.${tier}.webp`;
    // WebP q95 from the 24-bit bake: SSIM ≥ 0.97 against it (AV-visual); lossless would break the 55 MB budget.
    fs.writeFileSync(path.join(destDir, file), await img.webp({ quality: 95, effort: 6 }).toBuffer());
    variants[tier] = file;
  }
  return variants;
}

/** Every lightmap entry of a manifest, with the glb base name it belongs to (atrium, wing-terracotta, …). */
function lightmapEntries(manifest) {
  const out = [];
  for (const [id, m] of Object.entries(manifest.modules)) {
    if (id === 'wing') for (const t of Object.values(m.themes)) out.push({ base: t.file.replace(/\.glb$/, ''), lm: t.lightmap });
    else if (m.lightmap) out.push({ base: m.file.replace(/\.glb$/, ''), lm: m.lightmap });
  }
  return out;
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
  const pngStage = path.join(work, 'stage-png');
  for (const d of [stage, pngStage]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'hdri'), { recursive: true });
  fs.mkdirSync(pngStage, { recursive: true });
  const tools = await gltfTools();
  const files = [];
  for (const [id, m] of Object.entries(modules)) {
    if (id === 'wing') for (const t of Object.values(m.themes)) files.push(t.file);
    else files.push(m.file);
  }
  for (const f of files) await optimizeGlb(tools, path.join(work, f), path.join(stage, f));
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
  const glbs = [];
  for (const [id, m] of Object.entries(manifest.modules)) {
    if (id === 'wing') for (const t of Object.values(m.themes)) glbs.push(t.file);
    else glbs.push(m.file);
  }
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
  else if (args.mode === 'verify') {
    await verify(await gltfTools(), PUBLIC);
    if (args.visual) await visual(await gltfTools());
  }
} catch (e) {
  console.error(`[asset] ERROR ${e.message}`);
  process.exit(1);
}
