import { describe, expect, it } from 'vitest'
import { commandName, parseCommands } from './shell-words.ts'

const names = (s: string) => parseCommands(s).commands.map((c) => c.name)

describe('parseCommands', () => {
  it.each([
    ['ls -la', ['ls']],
    ['git status && rm -rf build', ['git', 'rm']],
    ['a; b || c | d', ['a', 'b', 'c', 'd']],
    ['a\nb', ['a', 'b']],
    ['sleep 1 & rm x', ['sleep', 'rm']],
    ['FOO=1 sudo rm -rf x', ['rm']],
    ['sudo -u root rm x', ['rm']],
    ['env -i A=b nohup time -p rm x', ['rm']],
    ['command rm x', ['rm']],
    ['/usr/bin/rm x', ['rm']],
    ['C:\\tools\\RM.EXE x', ['rm']],
    ['bash -c "rm x; ls"', ['rm', 'ls']],
    ["sh -c 'git push'", ['git']],
    ['zsh -lc "curl x"', ['curl']],
    ['(cd x && rm y)', ['cd', 'rm']],
    ['echo "a;b" \'c|d\'', ['echo']],
    ['echo a\\;b', ['echo']],
    ['xargs -0 rm', ['rm']],
    ['', []],
  ])('%s → %j', (cmd, want) => {
    expect(names(cmd)).toEqual(want)
    expect(parseCommands(cmd).opaque).toBe(false)
  })

  it.each([
    'echo $(rm x)',
    'echo `rm x`',
    'eval "rm x"',
    'source ./x.sh',
    '. ./x.sh',
    'echo "unbalanced',
    "echo 'unbalanced",
    'bash -c "echo $(rm x)"',
    'echo "$(rm x)"',
  ])('%s is opaque', (cmd) => {
    expect(parseCommands(cmd).opaque).toBe(true)
  })

  it('keeps single-quoted $( literal and nests sh -c at most 3 deep', () => {
    expect(parseCommands("echo '$(x)'").opaque).toBe(false)
    expect(parseCommands('sh -c "sh -c \\"sh -c \\\\\\"sh -c x\\\\\\"\\""').opaque).toBe(true)
  })

  it('argv keeps quoted words whole', () => {
    expect(parseCommands('git commit -m "a b"').commands[0]!.argv).toEqual([
      'git',
      'commit',
      '-m',
      'a b',
    ])
  })

  it('commandName lowercases the basename and drops .exe', () => {
    expect(commandName('/bin/Git.exe')).toBe('git')
    expect(commandName('')).toBe('')
  })
})
