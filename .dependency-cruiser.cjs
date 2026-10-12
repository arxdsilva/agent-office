// Enforces the hexagonal dependency rule. See .claude/rules/ARCHITECTURE.md.
// pnpm resolves to node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>/…, which always contains node_modules/<pkg>/.
const pkg = (name) => `node_modules/${name}/`
const ZOD = pkg('zod')

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'shared-is-leaf',
      comment: 'shared holds contracts only: it may import zod and itself.',
      severity: 'error',
      from: { path: '^packages/shared/src' },
      to: { pathNot: [`^packages/shared/src`, ZOD] },
    },
    {
      name: 'core-is-pure',
      comment:
        'core (domain, use cases, ports) may import only core, shared and zod — no Node, Electron, Fastify, three.',
      severity: 'error',
      from: { path: '^packages/core/(src|test)' },
      to: { pathNot: ['^packages/(core|shared)/', ZOD, pkg('vitest'), pkg('@vitest')] },
    },
    {
      name: 'core-no-node-builtins',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'agent-sdk-in-adapters-only',
      comment:
        'Only adapters/src/agents may import the Claude Agent SDK (the AgentRunner adapter).',
      severity: 'error',
      from: { pathNot: '^packages/adapters/src/agents/' },
      to: { path: pkg('@anthropic-ai/claude-agent-sdk') },
    },
    {
      name: 'acp-sdk-in-providers-only',
      comment: 'Only adapters/src/providers may import the ACP SDK (types for the ACP runner).',
      severity: 'error',
      from: { pathNot: '^packages/adapters/(src|test)/providers/' },
      to: { path: pkg('@agentclientprotocol/sdk') },
    },
    {
      name: 'providers-isolated',
      comment:
        'A provider folder may import providers/common and itself, never another provider (docs/provider-integrations.md).',
      severity: 'error',
      from: { path: '^packages/adapters/src/providers/([^/]+)/' },
      to: {
        path: '^packages/adapters/src/providers/([^/]+)/',
        pathNot: [
          '^packages/adapters/src/providers/common/',
          '^packages/adapters/src/providers/$1/',
        ],
      },
    },
    {
      name: 'providers-common-is-generic',
      comment:
        'Shared provider infrastructure (process, JSON-RPC, ACP, hooks) imports no provider.',
      severity: 'error',
      from: { path: '^packages/adapters/src/providers/common/' },
      to: {
        path: '^packages/adapters/src/providers/',
        pathNot: '^packages/adapters/src/providers/common/',
      },
    },
    {
      name: 'adapters-no-electron',
      comment: 'Node adapters must not know about Electron, the desktop shell or the renderer.',
      severity: 'error',
      from: { path: '^packages/adapters/' },
      to: { path: ['^packages/(desktop|web)/', pkg('electron'), pkg('electron-updater')] },
    },
    {
      name: 'renderer-isolated',
      comment:
        'The renderer talks to the app only through the preload bridge (shared IPC contract).',
      severity: 'error',
      from: { path: '^packages/web/src' },
      to: {
        pathNot: ['^packages/(web|shared)/', ZOD, pkg('three'), pkg('vitest'), pkg('@vitest')],
      },
    },
    {
      name: 'renderer-no-node-builtins',
      severity: 'error',
      from: { path: '^packages/web/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'preload-minimal',
      comment: 'The preload exposes a typed bridge; it may import only electron and shared.',
      severity: 'error',
      from: { path: '^packages/desktop/src/preload' },
      to: { pathNot: ['^packages/(shared|desktop/src/preload)/', ZOD, pkg('electron')] },
    },
    {
      name: 'composition-root-only',
      comment:
        'Only the composition root (composition.ts + the Electron entry index.ts) may know concrete adapters; everything else depends on ports.',
      severity: 'error',
      from: {
        path: '^packages/desktop/src/main/',
        pathNot: ['(composition|index)\\.ts$', '\\.test\\.ts$'],
      },
      to: { path: ['^packages/adapters/', '^packages/desktop/src/main/adapters/'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['/dist/', '/out/', '/coverage/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
