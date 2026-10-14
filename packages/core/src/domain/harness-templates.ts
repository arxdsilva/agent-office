// Harness templates (docs/harness.md §2a): versioned, editable drafts. Five flows for any kind of
// work, five engineering standards and an empty one. Pure data; ids inside are placeholders that
// `createHarness` replaces (gate checks follow their gate).
import type {
  ActionRule,
  HarnessDraft,
  HarnessTemplateView,
  RuleDraft,
  StepDraft,
} from '@agent-office/shared'

export interface HarnessTemplate extends HarnessTemplateView {
  /** Template version: bump when the draft changes (existing harnesses are never rewritten). */
  version: number
  draft: HarnessDraft
}

const rule = (
  name: string,
  text: string,
  category: RuleDraft['category'],
  o: Partial<RuleDraft> = {},
): RuleDraft => ({ name, text, category, enforcement: 'instruction', ...o })

const policy = (
  name: string,
  text: string,
  category: RuleDraft['category'],
  p: ActionRule,
): RuleDraft => ({ name, text, category, enforcement: 'runtime-policy', policy: p })

const report = { kind: 'report' as const }
const approval = (prompt: string) => ({ kind: 'approval' as const, prompt })
const artifact = (path: string) => ({ kind: 'artifact' as const, path, mustExist: true })

const NO_PUBLISH: ActionRule = { effect: 'deny', tools: ['class:write'], paths: ['published/**'] }
const NO_SEND: ActionRule = { effect: 'deny', commands: ['mail', 'sendmail', 'mutt'] }

const CHECK_GATE = 'gat_tmplcheck'

const contentPipeline: HarnessDraft = {
  name: 'Content pipeline',
  description: 'Research, outline, draft, review and publish a piece of writing.',
  rules: [
    rule('Tone', 'Write in a clear, friendly and direct voice; avoid jargon.', 'content'),
    rule('Cite sources', 'Cite a source for every factual claim, with a link.', 'content'),
    rule(
      'Original work',
      'Never copy text from sources; quote briefly and attribute.',
      'compliance',
    ),
  ],
  steps: [
    {
      name: 'Research',
      goal: 'Notes with the key facts and their sources exist.',
      exit: [report],
      policies: [NO_PUBLISH],
    },
    {
      name: 'Outline',
      goal: 'An outline with the main sections is ready for the user.',
      exit: [approval('Outline approved')],
      policies: [NO_PUBLISH],
    },
    {
      name: 'Draft',
      goal: 'A complete first draft is written under drafts/.',
      exit: [artifact('drafts/**')],
      policies: [NO_PUBLISH],
    },
    {
      name: 'Review',
      goal: 'The user has reviewed the draft and the requested changes are made.',
      exit: [approval('Draft approved for publishing')],
      policies: [NO_PUBLISH],
    },
    {
      name: 'Publish',
      goal: 'The final version is under published/.',
      exit: [artifact('published/**')],
    },
  ],
}

const researchBrief: HarnessDraft = {
  name: 'Research brief',
  description: 'Scope a question, gather sources, synthesise a brief and fact-check it.',
  rules: [
    rule(
      'Primary sources',
      'Prefer primary sources and recent data; say when a source is old.',
      'research',
    ),
    rule('Uncertainty', 'Say how confident you are and what is unknown.', 'research'),
    rule('Citations', 'Every claim in the brief links to its source.', 'research'),
  ],
  steps: [
    {
      name: 'Scope',
      goal: 'The question, audience and limits of the brief are agreed with the user.',
      exit: [approval('Scope approved')],
    },
    {
      name: 'Gather sources',
      goal: 'A list of relevant sources with notes exists.',
      exit: [report],
    },
    {
      name: 'Synthesise',
      goal: 'brief.md summarises the findings with citations.',
      exit: [artifact('brief.md')],
    },
    {
      name: 'Fact-check',
      goal: 'The user has checked the claims against the sources.',
      exit: [approval('Facts checked')],
    },
  ],
}

const supportReply: HarnessDraft = {
  name: 'Support reply',
  description: 'Understand a request, draft a reply, check it for compliance, then send it.',
  rules: [
    rule('Empathy', 'Acknowledge the problem before proposing a fix.', 'communication'),
    rule('Plain language', 'Use short sentences and no internal jargon.', 'communication'),
    rule(
      'No personal data',
      'Never include personal data of other customers or internal notes.',
      'compliance',
    ),
    rule(
      'No promises',
      'Do not promise refunds, dates or features without approval.',
      'compliance',
    ),
  ],
  steps: [
    {
      name: 'Understand',
      goal: 'The request, the customer goal and the facts needed are clear.',
      exit: [report],
      policies: [NO_SEND],
    },
    {
      name: 'Draft reply',
      goal: 'A reply draft is saved under replies/.',
      exit: [artifact('replies/**')],
      policies: [NO_SEND],
    },
    {
      name: 'Compliance check',
      goal: 'The user confirmed the reply is accurate and compliant.',
      exit: [approval('Reply approved')],
      policies: [NO_SEND],
    },
    { name: 'Send', goal: 'The approved reply is sent.', exit: [report] },
  ],
}

const releaseChecklist: HarnessDraft = {
  name: 'Release checklist',
  description: 'Tests, changelog, version bump and tag, in that order.',
  gates: [{ id: CHECK_GATE, name: 'make check', argv: ['make', 'check'] }],
  rules: [
    rule('Green build', 'Never release with failing tests or checks.', 'testing'),
    rule('Semantic versions', 'Bump the version following semantic versioning.', 'workflow'),
    rule('No early push', 'Do not push tags or release branches before the Tag step.', 'workflow'),
  ],
  steps: [
    {
      name: 'Tests',
      goal: 'The full check passes on the release commit.',
      exit: [{ kind: 'gate', gateId: CHECK_GATE }],
    },
    {
      name: 'Changelog',
      goal: 'CHANGELOG.md lists the changes in this release.',
      exit: [artifact('CHANGELOG.md')],
    },
    {
      name: 'Version bump',
      goal: 'The version number is updated everywhere it appears.',
      exit: [approval('Version approved')],
    },
    { name: 'Tag', goal: 'The release is tagged and pushed.', exit: [report] },
  ],
}

const incidentWriteup: HarnessDraft = {
  name: 'Incident write-up',
  description: 'A blameless incident review: timeline, root cause and actions.',
  rules: [
    rule('Blameless', 'Describe systems and decisions, never blame people.', 'process'),
    rule('Times in UTC', 'Write every time in the timeline in UTC.', 'process'),
  ],
  steps: [
    {
      name: 'Timeline',
      goal: 'incidents/ holds a timeline of what happened.',
      exit: [artifact('incidents/**')],
    },
    {
      name: 'Root cause',
      goal: 'The root cause is identified and agreed with the user.',
      exit: [approval('Root cause agreed')],
    },
    { name: 'Actions', goal: 'Follow-up actions with owners are listed.', exit: [report] },
  ],
}

const goBackend: HarnessDraft = {
  name: 'Go backend',
  description: 'Idiomatic Go services with tests and vetting.',
  gates: [
    { name: 'go vet', argv: ['go', 'vet', './...'] },
    { name: 'go test', argv: ['go', 'test', './...'] },
  ],
  rules: [
    rule('Errors', 'Wrap errors with context; never ignore a returned error.', 'coding'),
    rule('Context', 'Pass context.Context as the first parameter of I/O functions.', 'coding'),
    rule('Tests', 'Write table-driven tests for new behaviour.', 'testing'),
    rule(
      'Packages',
      'Keep packages small; no import cycles; internal/ for private code.',
      'architecture',
    ),
  ],
}

const typescript: HarnessDraft = {
  name: 'TypeScript',
  description: 'Strict TypeScript with type checks.',
  gates: [{ name: 'tsc', argv: ['npx', 'tsc', '--noEmit'] }],
  rules: [
    rule('Strict types', 'Never use any; prefer unknown and narrow it.', 'coding'),
    rule('Validation', 'Validate external input at the boundary (e.g. with zod).', 'security'),
    rule('Tests', 'Add a unit test for every behaviour change.', 'testing'),
  ],
}

const tdd: HarnessDraft = {
  name: 'Test-driven development',
  description: 'Red, green, refactor for every behaviour change.',
  gates: [{ name: 'make test', argv: ['make', 'test'] }],
  rules: [
    rule('Red first', 'Write a failing test first and run it before writing code.', 'testing'),
    rule(
      'Minimal code',
      'Write the minimum code that makes the test pass, then refactor.',
      'testing',
    ),
    rule('Bug fixes', 'Every bug fix starts with a test that reproduces it.', 'testing'),
    rule('Done', 'A change is done only when the whole suite passes.', 'completion'),
  ],
}

const securityPrivacy: HarnessDraft = {
  name: 'Security and privacy',
  description: 'Keep secrets out of code and logs; ask before touching sensitive files.',
  rules: [
    rule('No secrets', 'Never commit or print secrets, tokens or keys.', 'security'),
    rule('Least data', 'Log identifiers and counts, never personal data.', 'security'),
    policy('Env files', 'Ask before reading or writing env files.', 'security', {
      effect: 'ask',
      paths: ['.env', '.env.*'],
    }),
    policy('No destructive deletes', 'Never delete files recursively with rm.', 'security', {
      effect: 'deny',
      commands: ['rm'],
    }),
  ],
}

const docsReview: HarnessDraft = {
  name: 'Docs review',
  description: 'Keep documentation accurate as the code changes.',
  rules: [
    rule('Docs follow code', 'Update the docs in the same change as the behaviour.', 'workflow'),
    rule('Examples run', 'Every code example in the docs must work as written.', 'content'),
    rule('Plain words', 'Prefer short sentences and plain words.', 'content'),
  ],
}

function view(id: string, draft: HarnessDraft, version = 1): HarnessTemplate {
  return {
    id,
    name: draft.name,
    description: draft.description ?? '',
    ruleCount: draft.rules?.length ?? 0,
    gateCount: draft.gates?.length ?? 0,
    version,
    draft,
  }
}

export const HARNESS_TEMPLATES: readonly HarnessTemplate[] = [
  view('content-pipeline', contentPipeline),
  view('research-brief', researchBrief),
  view('support-reply', supportReply),
  view('release-checklist', releaseChecklist),
  view('incident-writeup', incidentWriteup),
  view('go-backend', goBackend),
  view('typescript', typescript),
  view('tdd', tdd),
  view('security-privacy', securityPrivacy),
  view('docs-review', docsReview),
  {
    ...view('custom', { name: 'Custom harness' }),
    name: 'Custom',
    description: 'Start from an empty harness and add your own rules, gates and steps.',
  },
]

/** Step count of a template (the editor's flow preview). */
export function templateSteps(t: HarnessTemplate): StepDraft[] {
  return t.draft.steps ?? []
}
