#!/usr/bin/env node
// Release gate: the pushed tag vX.Y.Z must equal the package version (the tag
// is the version source of truth, mirroring the dsh-web-ui release pipeline).
import { readFileSync } from 'node:fs'

const tagVersion = process.argv[2]
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (tagVersion !== manifest.version) {
  console.error(`tag v${tagVersion} does not match package.json version ${manifest.version}`)
  process.exit(1)
}
console.log(`release version ${manifest.version} verified`)
