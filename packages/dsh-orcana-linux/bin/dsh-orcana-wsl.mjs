#!/usr/bin/env node

import { launchWslBridge } from '../lib/wsl-bridge.js'

try {
  process.exitCode = await launchWslBridge(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
