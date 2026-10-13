// A hand-written shell tokenizer for harness command rules (docs/harness.md §3). Heuristic on
// purpose: it finds each simple command's argv[0] after wrappers, and reports anything it cannot
// read (substitutions, eval/source, unbalanced quotes, deep `sh -c` nesting) as opaque. Pure.

export interface ParsedCommand {
  argv: string[]
  /** Lowercased basename of argv[0], without `.exe`. */
  name: string
}

export interface ParsedCommands {
  commands: ParsedCommand[]
  /** True when the command cannot be read reliably: callers must ask, never allow silently. */
  opaque: boolean
}

const MAX_DEPTH = 3
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'nice', 'xargs'])
/** Wrapper options that take a value (`sudo -u root`). */
const WITH_VALUE: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E']),
}
const OPAQUE_CMDS = new Set(['eval', 'source', '.'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

export function commandName(word: string): string {
  const base = word.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

/** Splits into simple commands (argv lists); `opaque` on substitutions or broken quoting. */
function tokenize(src: string): { argvs: string[][]; opaque: boolean } {
  const argvs: string[][] = []
  let argv: string[] = []
  let word = ''
  let inWord = false
  let quote: '' | "'" | '"' = ''
  let opaque = false
  const endWord = () => {
    if (inWord) argv.push(word)
    word = ''
    inWord = false
  }
  const endCmd = () => {
    endWord()
    if (argv.length) argvs.push(argv)
    argv = []
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quote === "'") {
      if (c === "'") quote = ''
      else word += c
      continue
    }
    if (c === '\\') {
      const n = src[i + 1]
      if (n === undefined) continue
      // Outside quotes only shell metacharacters are escaped, so Windows paths keep their `\`.
      const special = quote === '"' ? '"\\$`\n' : ' \t\n\'"\\$`;|&()<>'
      if (!special.includes(n)) {
        word += c
        inWord = true
        continue
      }
      word += n
      inWord = true
      i++
      continue
    }
    if (c === '`' || (c === '$' && src[i + 1] === '(')) {
      opaque = true
      word += c
      inWord = true
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = ''
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') {
      endCmd()
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      continue
    }
    word += c
    inWord = true
  }
  if (quote) opaque = true
  endCmd()
  return { argvs, opaque }
}

/** Drops assignments and wrapper commands (with their options) in front of the real command. */
function unwrap(argv: string[]): string[] {
  let i = 0
  while (i < argv.length) {
    const w = argv[i]!
    if (ASSIGN.test(w)) {
      i++
      continue
    }
    const name = commandName(w)
    if (!WRAPPERS.has(name)) break
    i++
    while (i < argv.length) {
      const o = argv[i]!
      if (o === '--') {
        i++
        break
      }
      if (name === 'env' && ASSIGN.test(o)) {
        i++
        continue
      }
      if (!o.startsWith('-')) break
      i += WITH_VALUE[name]?.has(o) ? 2 : 1
    }
  }
  return argv.slice(i)
}

function parse(src: string, depth: number): ParsedCommands {
  if (depth > MAX_DEPTH) return { commands: [], opaque: true }
  const t = tokenize(src)
  let opaque = t.opaque
  const commands: ParsedCommand[] = []
  for (const raw of t.argvs) {
    const argv = unwrap(raw)
    if (!argv.length) continue
    const name = commandName(argv[0]!)
    if (OPAQUE_CMDS.has(name)) opaque = true
    const flag = argv[1]
    if (SHELLS.has(name) && flag && /^-[a-z]*c[a-z]*$/i.test(flag)) {
      const inner = parse(argv[2] ?? '', depth + 1)
      commands.push(...inner.commands)
      if (inner.opaque) opaque = true
      continue
    }
    commands.push({ argv, name })
  }
  return { commands, opaque }
}

export function parseCommands(command: string): ParsedCommands {
  return parse(command, 0)
}
