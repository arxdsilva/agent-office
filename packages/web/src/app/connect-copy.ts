// Every user-facing string of the Connect panel, empty state and related hints (plan §2).
// One source so view models, tests and docs agree. Functions take only safe, already-public values.

import type { ProviderId, ProviderState, SessionCap } from '@agent-office/shared'

const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const COPY = {
  empty: {
    title: 'Your office is empty',
    lead: 'Agents move in as soon as they report activity. Pick a way in:',
    listening: '◌ Listening for agents…',
    dismiss: 'Hide',
    claude: {
      title: '▶ Claude Code',
      body: 'Run `claude` in a project; it shows up here in seconds.',
      button: 'Set up →',
    },
    http: {
      title: '</> Any framework',
      body: 'LangGraph, OpenAI Agents, CrewAI or any script: post events over local HTTP.',
      button: 'Show me how →',
    },
    demo: {
      title: '✦ Demo office',
      body: '9 sample agents across 3 providers.',
      button: 'Try the demo',
      starting: 'Starting demo…',
      failed: "Demo didn't start: check the logs.",
    },
    providers: {
      title: 'More AI providers',
      body: 'Codex, Cursor, Gemini CLI, Copilot CLI',
      button: 'Set up',
      ready: (n: number) => `● ${n} ready`,
      none: '○ None set up',
    },
  },
  panel: {
    title: 'Connect agents',
    subtitle: 'Agents talk to agent-office over local channels only; nothing leaves this machine.',
    tabs: {
      claude: 'Claude Code',
      providers: 'Providers',
      http: 'Any framework',
      demo: 'Demo',
      connected: 'Connected',
    },
  },
  claude: {
    sessions: (n: number) => `● ${s(n, 'active session')}`,
    noSessions: '○ No sessions yet',
    off: 'Off',
    offOverride: 'Off (AGENT_OFFICE_CLAUDE=0)',
    onOverrideNote: 'Controlled by AGENT_OFFICE_CLAUDE=1 for this run',
    offOverrideNote: 'Controlled by AGENT_OFFICE_CLAUDE=0 for this run',
    folderMissingPill: '⚠ Projects folder not found',
    step1: 'Show my sessions',
    step1Help: 'Sessions active in the last 10 minutes appear automatically.',
    folderFound: (dir: string) => `✓ Found ${dir}`,
    folderMissing: (dir: string) => `⚠ ${dir} not found: install Claude Code and run claude once`,
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    step2: 'Let me message agents (optional)',
    step2Help:
      'Adds a hook to ~/.claude/settings.json (a backup is kept). Messages arrive when the agent finishes its turn, or when you next prompt it.',
    hook: {
      installed: { label: 'Installed ✓', button: 'Uninstall' },
      outdated: { label: 'Needs repair (app moved, updated or port changed)', button: 'Repair' },
      missing: { label: 'Not installed', button: 'Install' },
    },
    verified: (ago: string) => `✓ Verified: a session read its inbox ${ago}`,
    notVerified: '○ Not verified yet: prompt a session once after installing',
    idle: 'Sessions found but idle. Prompt `claude` and it will walk in.',
  },
  providers: {
    heading: 'AI providers',
    checkAll: 'Check all',
    check: 'Check again',
    docs: 'Docs',
    start: 'Start agent',
    enable: 'Enabled',
    sessions: (n: number) => s(n, 'active session'),
    version: (v?: string, tested?: string) =>
      v ? (tested ? `v${v} · tested ${tested}` : `v${v}`) : undefined,
    integration: (managed?: string, observed?: string) =>
      managed || observed
        ? [managed && `Managed: ${managed}`, observed && `Observed: ${observed}`]
            .filter(Boolean)
            .join(' · ')
        : 'No integration available',
    managedVia: { 'agent-sdk': 'Agent SDK', 'app-server': 'app-server', acp: 'ACP' } as Record<
      string,
      string
    >,
    observeVia: { transcripts: 'transcripts', hooks: 'hooks' } as Record<string, string>,
    states: {
      connected: ['● Connected', 'ok'],
      'managed-available': ['● Ready', 'ok'],
      'observe-only': ['● Observing', 'ok'],
      installed: ['◌ Installed', 'pending'],
      'needs-auth': ['○ Needs login', 'warn'],
      'needs-setup': ['⚠ Needs setup', 'warn'],
      'unsupported-version': ['⚠ Update the CLI', 'warn'],
      disconnected: ['⚠ Disconnected', 'warn'],
      error: ['✗ Error', 'error'],
      'not-installed': ['○ Not installed', 'off'],
      disabled: ['○ Off', 'off'],
    } as Record<ProviderState, [string, 'ok' | 'warn' | 'off' | 'error' | 'pending']>,
    caps: {
      observe: 'Observe',
      launch: 'Start',
      'send-message': 'Send',
      interrupt: 'Interrupt',
      stop: 'Stop',
      'approve-tools': 'Approve tools',
      'select-model': 'Models',
      'change-mode': 'Modes',
      'attach-context': 'Attach',
      chrome: 'Chrome',
      resume: 'Resume',
    } as Record<SessionCap, string>,
    hooks: {
      installed: { text: 'Installed ✓', button: 'Remove hooks' },
      outdated: { text: 'Needs repair', button: 'Repair hooks' },
      missing: { text: 'Not installed', button: 'Install hooks' },
    },
    login: {
      'claude-code': 'Run `claude` in a terminal and use /login, then Check again',
      codex: 'Run `codex login` in a terminal, then Check again',
      cursor: 'Run `agent login` in a terminal, then Check again',
      gemini: 'Run `gemini` once and sign in, then Check again',
      copilot: 'Run `copilot` and use /login, then Check again',
      chatgpt: 'Not available',
    } as Record<ProviderId, string>,
    hint: {
      'install-cli': (l: string) => `Install the ${l} CLI, then Check again`,
      'update-cli': (l: string) => `Update the ${l} CLI, then Check again`,
      'hooks-invalid-config': 'The hooks config file is not valid JSON: fix it, then Check again',
      'hooks-outdated': 'Hooks need repair (app moved, updated or port changed)',
      'hooks-need-enable': 'Enable hooks in the CLI settings, then Check again',
      'probe-timeout': 'The CLI did not answer in time: Check again',
      'probe-failed': "Couldn't check the CLI: Check again",
      'opt-in-tunnel': 'Opt-in: needs a public HTTPS endpoint or the OpenAI MCP tunnel',
      'no-observation-surface': "Sessions started elsewhere can't be observed: start them here",
    },
  },
  http: {
    listening: (host: string, port: number) => `● Listening on ${host}:${port}`,
    busy: (port: number) => `✗ Port ${port} busy`,
    starting: '◌ Starting…',
    endpoint: 'Endpoint',
    auth: (tokenFile: string) => `Bearer token stored in ${tokenFile} (mode 600, never shown)`,
    fields: 'agentId (required) · provider · topic · status · tool · text …',
    busyHelp: (port: number) => `Another app uses port ${port}. Pick another:`,
    apply: 'Apply',
    copy: 'Copy',
    copied: 'Copied ✓',
    langs: { curl: 'curl', python: 'Python', js: 'JavaScript' },
    powershell: 'On PowerShell, use the Python snippet.',
    test: 'Send a test agent',
    waiting: '◌ Waiting for the first event…',
    received: (provider: string, ago: string) => `✓ Received from ${provider} · ${ago}`,
    testOk: '✓ Test agent received',
    testFailed: (error: string) => `✗ Test failed: ${error}`,
    next: 'Next: let it receive messages (inbox API) · declare its tools (capabilities API) → README',
    readmeUrl: 'https://github.com/arxdsilva/agent-office#http-api', // ⚠️ verify: final repo URL
  },
  demo: {
    off: '○ Off',
    on: (n: number) => `● On (${s(n, 'agent')})`,
    onOverride: '● On (AGENT_OFFICE_MOCK=1)',
    overrideNote: 'Controlled by AGENT_OFFICE_MOCK for this run',
    body: 'Fill the office with 9 sample agents across claude-code, langgraph and openai-agents: meetings, booths, library visits, links and chat replies. They are fake: nothing is read from your machine.',
    toggle: 'Show demo agents',
    help: 'Turn it off to clear them.',
  },
  connected: {
    count: (n: number) => s(n, 'provider'),
    agents: (n: number) => s(n, 'agent'),
    none: 'Nothing connected yet.',
    via: { 'claude-code': 'transcripts', http: 'HTTP', mock: 'demo', test: 'test' } as Record<
      string,
      string
    >,
    viaText: (how: string) => `via ${how}`,
    hookOk: ' + hook ✓',
    lastSeen: (ago: string) => `last seen ${ago}`,
    goTo: 'Go to wing →',
  },
  hud: {
    noAgents: 'No agents right now ·',
    connect: 'Connect…',
    connectBtn: '🔌 Connect',
    connectAria: 'Connect agents',
    connectAriaEmpty: 'Connect agents (nothing connected)',
  },
  banner: { fix: 'Fix in Connect' },
  toast: {
    connected: (provider: string) => `${provider} connected`,
    hookHint: ' · install the hook to chat →',
  },
  hint: {
    notReading: "This agent isn't reading its inbox, so messages will wait.",
    howTo: 'How to connect it →',
  },
  settings: { more: 'More ways to connect agents…' },
} as const

/** Official docs per provider (docs/provider-integrations.md §5). */
export const PROVIDER_DOCS: Record<ProviderId, string> = {
  'claude-code': COPY.claude.docsUrl,
  codex: 'https://learn.chatgpt.com/docs/app-server',
  cursor: 'https://cursor.com/docs/cli/acp',
  gemini: 'https://geminicli.com/docs/cli/acp-mode/',
  copilot: 'https://docs.github.com/en/copilot',
  chatgpt: 'https://developers.openai.com/apps-sdk/deploy/connect-chatgpt',
}
