#!/usr/bin/env node

import 'hard-rejection/register.js'

import Bottleneck from 'bottleneck'
import chalk from 'chalk'
import depcheck from 'depcheck'
import { execa } from 'execa'
import fs from 'fs-extra'
import { globby } from 'globby'
import micromatch from 'micromatch'
import minimist from 'minimist'
import os from 'node:os'
import path from 'node:path'
import pMap from 'p-map'
import { readPackage } from 'read-pkg'

const DEFAULT_CONFIG = {
  ignoreMissing: {},
  ignoreUnused: {},
  ignorePatterns: [],
  concurrency: os.cpus().length,
  verbose: false,
  fix: false
}

const limiter = new Bottleneck({ maxConcurrent: 1 })

const filter = (depNames, pkgName, ignores) => {
  const patterns = [...(ignores['*'] ?? []), ...(ignores[pkgName] ?? [])]
  if (patterns.length === 0) {
    return depNames
  }
  return micromatch.not(depNames, patterns)
}

const print = (
  pkgNameFixed,
  style,
  label,
  depNames = null,
  isError = false
) => {
  ;(isError ? console.error : console.info)(
    style('■') +
      ' ' +
      pkgNameFixed +
      ' ' +
      style(label) +
      (depNames != null ? ' ' + depNames.join(' ') : '')
  )
}

const installMissing = async (pkgName, allMissing, pkgNames, pkgNameFixed) => {
  const localMissing = allMissing.filter((name) => pkgNames.includes(name))
  if (localMissing.length === 0) {
    return
  }
  print(
    pkgNameFixed,
    chalk.red,
    'Missing:',
    allMissing.map((name) =>
      localMissing.includes(name) ? chalk.dim(name) : name
    ),
    true
  )
  print(pkgNameFixed, chalk.cyan, 'Adding:', localMissing)
  await execa(
    'yarn',
    [
      'workspace',
      pkgName,
      'add',
      ...localMissing.map((name) => name + '@workspace:*')
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
}

const checkAndReport = async (
  pkgDir,
  pkgName,
  config,
  pkgNames,
  pkgColWidth
) => {
  const pkgNameFixed = pkgName.padEnd(pkgColWidth)
  const { dependencies, devDependencies, missing } = await depcheck(pkgDir, {
    ignorePatterns: config.ignorePatterns
  })
  const missingNames = filter(
    Object.keys(missing),
    pkgName,
    config.ignoreMissing
  )
  if (config.fix) {
    await limiter.schedule(
      async () =>
        await installMissing(pkgName, missingNames, pkgNames, pkgNameFixed)
    )
  } else if (missingNames.length > 0) {
    print(pkgNameFixed, chalk.red, 'Missing:', missingNames, true)
  }
  const unusedNames = filter(
    [...dependencies, ...devDependencies],
    pkgName,
    config.ignoreUnused
  )
  if (unusedNames.length > 0) {
    print(pkgNameFixed, chalk.yellow, 'Unused:', unusedNames, true)
  }
  const failureCount = missingNames.length + unusedNames.length
  if (config.verbose && failureCount === 0) {
    print(pkgNameFixed, chalk.green, 'OK')
  }
  return failureCount
}

const buildConfig = async () => {
  let rcConfig = null
  try {
    rcConfig = await fs.readJson('.polydepcheckrc.json')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  const config = { ...DEFAULT_CONFIG, ...rcConfig }
  const argv = minimist(process.argv.slice(2))
  // TODO Support other options
  if (typeof argv.verbose === 'boolean') {
    config.verbose = argv.verbose
  }
  if (typeof argv.fix === 'boolean') {
    config.fix = argv.fix
  }
  return config
}

const main = async () => {
  const config = await buildConfig()
  const { workspaces } = await readPackage()
  const pkgDirs = await globby(workspaces, {
    onlyDirectories: true,
    absolute: true
  })
  const pkgNames = await pMap(
    pkgDirs,
    async (pkgDir) => (await readPackage({ cwd: pkgDir })).name,
    { concurrency: config.concurrency }
  )
  const pkgColWidth = pkgNames.reduce(
    (max, pkgName) => Math.max(max, pkgName.length),
    0
  )
  const results = await pMap(
    pkgDirs,
    async (pkgDir, index) =>
      await checkAndReport(
        pkgDir,
        pkgNames[index],
        config,
        pkgNames,
        pkgColWidth
      ),
    { concurrency: config.concurrency }
  )
  if (results.some(Boolean)) {
    process.exit(1)
  }
}

main()
