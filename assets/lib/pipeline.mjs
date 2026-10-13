// Shared asset-pipeline helpers (docs/graphics-contract.md §6, §6b, §13), used by assets/build.mjs for both
// asset sets: Classic (public/assets) and Horizon (public/horizon, contract §14).
//
// Everything here is moved verbatim from assets/build.mjs; the only additions are parameters with the old
// values as defaults (the Blender version, the pins file, the cache dir), so the classic build behaves
// exactly as before.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSETS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT = path.dirname(ASSETS);
export const BLENDER_DIR = path.join(ASSETS, 'blender');
export const CACHE = path.join(ASSETS, 'cache');
export const PINS_FILE = path.join(BLENDER_DIR, 'polyhaven.json');
export const BLENDER_VERSION = '5.2';

// ------------------------------------------------------------------------------------------- blender
export function childEnv() {
  // Never leak Electron's "run as node" switches into Blender (or anything else we spawn).
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ELECTRON_')) env[k] = v;
  return env;
}

export function run(cmd, args, { logFile, quiet = false } = {}) {
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

export async function findBlender(required = BLENDER_VERSION) {
  const bin = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(bin)) throw new Error(`Blender not found at ${bin} (set $BLENDER)`);
  const out = await run(bin, ['--version'], { quiet: true });
  const m = out.match(/Blender (\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`cannot parse Blender version from: ${out.slice(0, 200)}`);
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  if (`${m[1]}.${m[2]}` !== required) throw new Error(`Blender ${required}.x required, found ${version}`);
  return { bin, version };
}

/** Arguments of a headless, factory-settings Blender run of `script` (the spawn helper). */
export function blenderArgs(script, scriptArgs) {
  return ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...scriptArgs];
}

export async function pool(items, jobs, fn) {
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
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sourceList(pins) {
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

/** Download (once) and sha256-verify every pinned Poly Haven source; `pin` (re)writes the pins. */
export async function ensureSources({ pin = false, pinsFile = PINS_FILE, cache = CACHE } = {}) {
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  const list = sourceList(pins);
  let changed = false;
  for (const { file, url } of list) {
    const dest = path.join(cache, file);
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
    fs.writeFileSync(pinsFile, JSON.stringify(pins, null, 2) + '\n');
    console.log(`[asset] pinned ${list.length} files in ${path.relative(ROOT, pinsFile)}`);
  }
  return { pins, hdri: path.join(cache, list[list.length - 1].file) };
}

// ---------------------------------------------------------------------------------------------- files
/** Every file under `dir` (recursive), skipping __pycache__ and dot entries. */
export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ optimize
export async function gltfTools() {
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

export async function optimizeGlb(tools, src, dest, { skinned = false } = {}) {
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
  assertWallIds(doc, src);
  await hashTextures(tools, doc);
  await io.write(dest, doc);
}

/**
 * Contract §13: `_WALLID` must come out exact. meshopt 'high' quantizes only POSITION/TEXCOORD/JOINTS/
 * WEIGHTS/COLOR and encodes the rest without a lossy filter, and weld/dedup compare it like any attribute,
 * so it stays a FLOAT of integers. This guard fails the build if a future step changes that.
 */
export function assertWallIds(doc, src) {
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('_WALLID');
      if (!a) continue;
      const arr = a.getArray();
      if (a.getNormalized() || !(arr instanceof Float32Array))
        throw new Error(`${path.basename(src)}: _WALLID on ${mesh.getName()} was quantized`);
      for (const v of arr)
        if (v !== Math.round(v) || v < 0) throw new Error(`${path.basename(src)}: _WALLID on ${mesh.getName()} is not an integer (${v})`);
    }
}

export async function optimizePng(tools, src, dest) {
  // Lossless: sharp's png `effort` (like quality/colours) switches to a 256-colour palette, which bands lightmaps.
  const buf = await tools.sharp(src).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  fs.writeFileSync(dest, buf);
}

// ------------------------------------------------------------------------- textures and lightmaps (§6, §6b)
// No KTX2: three's Basis transcoder needs eval (`new Function`), which the app's CSP forbids (§6b).

export async function rgbaOf(sharp, input, size) {
  let img = sharp(Buffer.isBuffer(input) || typeof input === 'string' ? input : Buffer.from(input));
  if (size) img = img.resize(size[0], size[1], { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Contract §6b: extras.hash = sha1 over the decoded RGBA of the shipped image, first 12 hex chars. */
export async function hashTextures(tools, doc) {
  for (const t of doc.getRoot().listTextures()) {
    const { data } = await rgbaOf(tools.sharp, t.getImage());
    t.setExtras({ ...t.getExtras(), hash: createHash('sha1').update(data).digest('hex').slice(0, 12) });
  }
}

/** Contract §6: full, ½ and ¼ tiers of a lightmap PNG as WebP (sharp lanczos3 downscales). */
export async function lightmapTiers(tools, srcPng, destDir, base) {
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
export function lightmapEntries(manifest) {
  const out = [];
  for (const [id, m] of Object.entries(manifest.modules)) {
    if (id === 'wing') for (const t of Object.values(m.themes)) out.push({ base: t.file.replace(/\.glb$/, ''), lm: t.lightmap });
    else if (m.lightmap) out.push({ base: m.file.replace(/\.glb$/, ''), lm: m.lightmap });
  }
  return out;
}

// -------------------------------------------------------------------------------------------- stats
/** Rendered triangles, draw calls (colliders excluded) and node roles of a glb (the build's quick stats). */
export async function glbStats(tools, file) {
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

// --------------------------------------------------------------------------------- manifest merging
export function moduleSlug(m) {
  return m.replace(':', '-');
}

/**
 * Contract §11: one floor plan is shared by every wing theme. Rooms and walls must match across themes;
 * furniture is the multiset intersection, so theme-only decor (an arcade cabinet, extra plants) is left out
 * and the shared plan lists only what every wing really has.
 */
export function mergeWingPlans(plans) {
  const [first, ...rest] = plans;
  for (const { theme, plan } of rest)
    for (const k of ['rooms', 'walls'])
      if (JSON.stringify(plan[k]) !== JSON.stringify(first.plan[k])) throw new Error(`wing:${theme} plan.${k} differ from wing:${first.theme}`);
  const counts = (plan) => {
    const c = new Map();
    for (const f of plan.furniture) c.set(JSON.stringify(f), (c.get(JSON.stringify(f)) ?? 0) + 1);
    return c;
  };
  const others = rest.map(({ plan }) => counts(plan));
  const used = new Map();
  const furniture = first.plan.furniture.filter((f) => {
    const key = JSON.stringify(f);
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    return others.every((c) => (c.get(key) ?? 0) >= n);
  });
  return { rooms: first.plan.rooms, walls: first.plan.walls, furniture };
}

/**
 * Merge the per-module manifest fragments (`<slug>.json`) of a work dir into `modules`. A partial
 * --modules build reuses earlier fragments from the same work dir. `wing:<theme>` specs fold into one
 * `wing` module with `themes` (in `themeOrder`) and the shared plan; every other spec is its own module.
 */
export function mergeFragments(work, specs, themeOrder = []) {
  const modules = {};
  const wingThemes = {};
  const wingPlans = [];
  let wingShared = null;
  for (const m of specs) {
    const frag = path.join(work, `${moduleSlug(m)}.json`);
    if (!fs.existsSync(frag)) continue;
    const f = JSON.parse(fs.readFileSync(frag, 'utf8'));
    if (m.startsWith('wing:')) {
      const theme = m.slice(5);
      wingThemes[theme] = f.theme;
      if (f.module.plan) wingPlans.push({ theme, plan: f.module.plan });
      if (!wingShared) wingShared = f.module;
      else if (JSON.stringify(wingShared.anchors) !== JSON.stringify(f.module.anchors) || JSON.stringify(wingShared.nav) !== JSON.stringify(f.module.nav))
        throw new Error(`wing:${theme} anchors/nav differ from the other themes`);
    } else modules[m] = f.module;
  }
  if (wingShared) {
    const themes = {};
    for (const t of themeOrder) if (wingThemes[t]) themes[t] = wingThemes[t];
    modules.wing = { themes, ...wingShared };
    if (wingPlans.length) modules.wing.plan = mergeWingPlans(wingPlans);
  }
  return modules;
}

/** The glb file of every module of a manifest (wing themes expanded), in manifest order. */
export function moduleFiles(modules) {
  const files = [];
  for (const [id, m] of Object.entries(modules)) {
    if (id === 'wing') for (const t of Object.values(m.themes)) files.push(t.file);
    else files.push(m.file);
  }
  return files;
}
