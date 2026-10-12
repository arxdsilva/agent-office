// Every user-facing string of the Connect panel, empty state and related hints (plan §2).
// One source so view models, tests and docs agree. Functions take only safe, already-public values.

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
  },
  panel: {
    title: 'Connect agents',
    subtitle: 'Agents talk to agent-office over local channels only; nothing leaves this machine.',
    tabs: { claude: 'Claude Code', http: 'Any framework', demo: 'Demo', connected: 'Connected' },
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
