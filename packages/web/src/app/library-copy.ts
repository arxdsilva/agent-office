// Every user-facing string of the Library browser, view menus, tooltips and walk help (low-spec plan §B5).
export const LIB_COPY = {
  button: '📚 Library',
  title: (p: string) => `Library · ${p}`,
  close: 'Close',
  search: 'Search skills, rules, memory…',
  tabs: { skills: 'Skills', rules: 'Rules', memory: 'Memory', adapters: 'Adapters' },
  sort: { recent: 'Recent', az: 'A–Z', shelf: 'Shelf order' },
  scope: { project: 'project', user: 'user', plugin: 'plugin' },
  inUse: '● in use',
  used: (n: number, ago: string) => `used ${n}× · ${ago}`,
  never: 'not used yet',
  by: (names: string) => `by ${names}`,
  canSee: 'Can see',
  overflow: (n: number) => `Not on a shelf (${n})`,
  notOnShelf: 'Not on a shelf (overflow)',
  empty: {
    skills:
      'No skills yet. Claude Code shows yours automatically; other frameworks can declare them (Connect → Any framework).',
    rules:
      'No rules yet. CLAUDE.md, AGENTS.md and .claude/rules/*.md appear while a session runs in that project.',
    memory: 'No memory entries yet.',
    adapters: 'No adapters yet.',
    search: (q: string) => `Nothing matches “${q}”.`,
  },
  emptyBoard: 'No skills or rules yet',
  tooltip: (icon: string, label: string, kind: string) =>
    `${icon} ${label} · ${kind} · click to open`,
  views: {
    library: 'Library',
    rulesWall: 'Rules wall',
    adapters: 'Adapters',
    adaptersDoor: 'Adapters (door side)',
  },
  walkHelp: 'WASD move · Shift sprint · E talk / inspect · Esc exit',
} as const
