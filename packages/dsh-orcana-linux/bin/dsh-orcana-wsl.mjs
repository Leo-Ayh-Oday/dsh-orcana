#!/usr/bin/env node

import { launchDshOrcana } from '../lib/wsl-launcher.js'

try {
  process.exitCode = await launchDshOrcana(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
