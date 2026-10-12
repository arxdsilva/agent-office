#!/usr/bin/env node
// Runs the dependency-cruiser rules in .dependency-cruiser.cjs (hexagonal dependency rule).
// Uses the programmatic API so it also runs on odd-numbered Node releases the CLI refuses.
import { cruise } from 'dependency-cruiser'
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'

const options = await extractDepcruiseOptions('./.dependency-cruiser.cjs')
const result = await cruise(
  ['packages', 'hooks', 'scripts'],
  { ...options, validate: true, outputType: 'err' },
  undefined,
  { tsConfig: extractTSConfig('tsconfig.base.json') },
)
process.stdout.write(typeof result.output === 'string' ? result.output : JSON.stringify(result.output))
process.exit(result.exitCode)
