// The handoff dialog: compose (objective + provider) then review (bundle items with checkboxes).
import type { ProviderStatus } from '@agent-office/shared'
import type { WorkspaceState } from './state.ts'
import type { HandoffItemVM, HandoffVM } from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const H = WS_COPY.handoff

/** Providers that can start a managed session. */
export const handoffProviders = (providers: ProviderStatus[]): { id: string; label: string }[] =>
  providers
    .filter((p) => p.enabled && p.managedCaps.length > 0)
    .map((p) => ({ id: p.id, label: p.label }))

export function handoffVM(s: WorkspaceState): HandoffVM {
  const h = s.handoff
  const src = s.sessions.find((x) => x.id === h.sessionId)
  const hv = h.handoff
  const providerOptions = handoffProviders(s.providers)
  const items: HandoffItemVM[] = (hv?.bundle.items ?? []).map((it) => ({
    id: it.ref.id,
    title: it.title,
    excerpt: it.excerpt,
    reasons: it.reasons,
    included: it.included,
    toggleable: it.ref.kind === 'memory',
    excludedReason: it.excludedReason,
  }))
  const objective = hv?.objective ?? h.objective
  const provider = hv?.toProvider ?? h.provider
  let launchHint: string | undefined
  if (!hv) launchHint = H.needObjective
  else if (hv.state !== 'draft') launchHint = H.notDraft
  const previewOk = objective.trim().length > 0 && provider !== ''
  return {
    open: h.open,
    stage: hv ? 'review' : 'compose',
    heading: H.heading,
    fromLabel: hv
      ? H.from(hv.from.title, hv.from.provider)
      : src
        ? H.from(src.title, String(src.provider))
        : '',
    objective,
    provider,
    providerOptions,
    preview: {
      id: 'preview',
      label: H.preview,
      enabled: previewOk && h.sessionId !== null,
      hint: !objective.trim() ? H.needObjective : !provider ? H.needProvider : undefined,
    },
    items,
    itemsEmpty: H.itemsEmpty,
    note: hv?.note ?? '',
    tokens: {
      used: hv?.bundle.estimatedTokens ?? 0,
      usedChars: hv?.bundle.usedChars ?? 0,
      budgetChars: hv?.bundle.budgetChars ?? 0,
      label: H.tokens(hv?.bundle.estimatedTokens ?? 0),
    },
    launch: {
      id: 'launch',
      label: H.launch,
      enabled: !!hv && hv.state === 'draft',
      hint: launchHint,
    },
    error: s.error,
  }
}
