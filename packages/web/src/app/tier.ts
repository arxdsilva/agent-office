// Hardware tiering (low-spec plan §5.1): Auto's starting preset and ceiling from what WebGL and the
// browser report. Pure; an ordered rule table, first match wins; unknown hardware is a safe middle.
import type { HardwareInfo, Preset, Tier, TierReason } from './graphics-types.ts'
import { PRESET_ORDER } from './quality.ts'

const RULES: [RegExp, Preset, Preset, TierReason][] = [
  [/swiftshader|llvmpipe|software|basic render/i, 'minimal', 'low', 'software'],
  [/intel.*(uhd|hd graphics|iris(?!.*xe))|mali|adreno|powervr/i, 'low', 'medium', 'integrated'],
  [
    /apple m[12](?! (pro|max|ultra))|radeon\(tm\) graphics|iris.*xe/i,
    'medium',
    'high',
    'integrated',
  ],
  [
    /apple m\d+ (pro|max|ultra)|apple m[3-9]|nvidia|geforce|radeon rx|\barc\b/i,
    'high',
    'ultra',
    'capable',
  ],
]

export const UNKNOWN_TIER: Readonly<Tier> = { start: 'medium', ceiling: 'high', why: 'capable' }
const SOFTWARE: Readonly<Tier> = { start: 'minimal', ceiling: 'low', why: 'software' }

export function detectTier(h: HardwareInfo): Tier {
  if (!h.webgl2) return { ...SOFTWARE }
  const gpu = `${h.renderer} ${h.vendor}`
  const rule = RULES.find(([re]) => re.test(gpu))
  const tier: Tier = rule ? { start: rule[1], ceiling: rule[2], why: rule[3] } : { ...UNKNOWN_TIER }
  const weak = (h.memoryGB !== undefined && h.memoryGB <= 4) || h.cores <= 4
  if (weak && PRESET_ORDER.indexOf(tier.start) > PRESET_ORDER.indexOf('low'))
    return { ...tier, start: 'low', why: 'lowMemory' }
  return tier
}
