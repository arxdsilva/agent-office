// Agent questions (docs/harness.md §8): pure helpers shared by the sources, the core and the renderer.
// A question is the one bounded exception to the 80-char snippet rule; everything else about a
// tool input stays unread.
import { QuestionSchema, type Question } from './protocol.ts'

const MAX_SENTENCE = 160

/** Builds a `Question` from an `AskUserQuestion` tool input; undefined when it is not one. */
export function questionFromToolInput(input: unknown): Question | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw) || !raw.length) return undefined
  const prompts = raw.slice(0, 4).map((q) => {
    const o = (q ?? {}) as Record<string, unknown>
    const options = Array.isArray(o.options)
      ? o.options.slice(0, 4).map((x) => {
          const op = (x ?? {}) as Record<string, unknown>
          return {
            label: str(op.label, 80),
            description: str(op.description, 200),
          }
        })
      : []
    return {
      question: str(o.question, 300),
      header: str(o.header, 40),
      options: options.filter((x) => x.label),
      multiSelect: o.multiSelect === true,
    }
  })
  const parsed = QuestionSchema.safeParse({ prompts: prompts.filter((p) => p.question) })
  return parsed.success ? parsed.data : undefined
}

/** The last sentence of a reply that ends in a question mark (≤ 160 chars), ignoring code and links. */
export function questionInReply(text: string): string | undefined {
  const body = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i]!
    if (s.endsWith('?')) return s.length > MAX_SENTENCE ? `${s.slice(0, MAX_SENTENCE - 1)}…` : s
  }
  return undefined
}

/** `updatedInput` for the SDK: the original input plus `answers` (question → chosen text). */
export function answersToInput(
  input: Record<string, unknown>,
  answers: Record<string, string>,
): Record<string, unknown> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(answers)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue
    clean[k.slice(0, 300)] = v.slice(0, 500)
  }
  return { ...input, answers: clean }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : ''
}
