#!/usr/bin/env node

import 'hard-rejection/register.js'

import Bottleneck from 'bottleneck'
import chalk from 'chalk'
import depcheck from 'depcheck'
import { execa } from 'execa'
import fs from 'fs-extra'
import { globby } from 'globby'
import micromatch from 'micromatch'
import mri from 'mri'
import os from 'node:os'
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

const print = (
  pkgNameFixedWidth,
  style,
  label,
  depNames = null,
  isError = false
) => {
  ;(isError ? console.error : console.info)(
    style('■') +
      ' ' +
      pkgNameFixedWidth +
      ' ' +
      style(label) +
      (depNames != null ? ' ' + depNames.join(' ') : '')
  )
}

const applyFix = async (
  dependentPkgName,
  dependentPkgNameFixedWidth,
  problematicDepNames,
  workspacePkgNames,
  fixCommand,
  shouldAddVersion,
  style,
  labelProblematic,
  labelOperation
) => {
  const workspaceProblematicPkgs = problematicDepNames.filter((name) =>
    workspacePkgNames.includes(name)
  )
  print(
    dependentPkgNameFixedWidth,
    style,
    labelProblematic,
    problematicDepNames.map((name) =>
      workspaceProblematicPkgs.includes(name) ? chalk.dim(name) : name
    ),
    true
  )
  if (workspaceProblematicPkgs.length === 0) {
    return
  }
  print(
    dependentPkgNameFixedWidth,
    chalk.cyan,
    labelOperation,
    workspaceProblematicPkgs
  )
  await execa(
    'yarn',
    [
      'workspace',
      dependentPkgName,
      fixCommand,
      ...(shouldAddVersion
        ? workspaceProblematicPkgs.map((name) => name + '@workspace:*')
        : workspaceProblematicPkgs)
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
}

const reportAndMaybeFix = async (
  dependentPkgName,
  dependentPkgNameFixedWidth,
  problematicDepNames,
  workspacePkgNames,
  shouldFix,
  fixCommand,
  shouldAddVersion,
  style,
  labelProblematic,
  labelOperation
) => {
  if (problematicDepNames.length === 0) {
    return
  }
  if (shouldFix) {
    await limiter.schedule(
      async () =>
        await applyFix(
          dependentPkgName,
          dependentPkgNameFixedWidth,
          problematicDepNames,
          workspacePkgNames,
          fixCommand,
          shouldAddVersion,
          style,
          labelProblematic,
          labelOperation
        )
    )
  } else {
    print(
      dependentPkgNameFixedWidth,
      style,
      labelProblematic,
      problematicDepNames,
      true
    )
  }
}

const applyIgnoreList = (depNames, pkgName, ignores) => {
  const patterns = [...(ignores['*'] ?? []), ...(ignores[pkgName] ?? [])]
  if (patterns.length === 0) {
    return depNames
  }
  return micromatch.not(depNames, patterns)
}

const checkAndReport = async (
  dependentPkgDir,
  dependentPkgName,
  config,
  workspacePkgNames,
  pkgColWidth
) => {
  const pkgNameFixedWidth = dependentPkgName.padEnd(pkgColWidth)

  const { dependencies, devDependencies, missing } = await depcheck(
    dependentPkgDir,
    {
      ignorePatterns: config.ignorePatterns
    }
  )

  const missingPkgNames = applyIgnoreList(
    Object.keys(missing),
    dependentPkgName,
    config.ignoreMissing
  )
  await reportAndMaybeFix(
    dependentPkgName,
    pkgNameFixedWidth,
    missingPkgNames,
    workspacePkgNames,
    config.fix,
    'add',
    true,
    chalk.red,
    'Missing:',
    'Adding:'
  )

  const unusedPkgNames = applyIgnoreList(
    [...dependencies, ...devDependencies],
    dependentPkgName,
    config.ignoreUnused
  )
  await reportAndMaybeFix(
    dependentPkgName,
    pkgNameFixedWidth,
    unusedPkgNames,
    workspacePkgNames,
    config.fix,
    'remove',
    false,
    chalk.yellow,
    'Unused:',
    'Removing:'
  )

  const failureCount = missingPkgNames.length + unusedPkgNames.length
  if (config.verbose && failureCount === 0) {
    print(pkgNameFixedWidth, chalk.green, 'OK')
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
  const argv = mri(process.argv.slice(2))
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
  const workspacePkgNames = await pMap(
    pkgDirs,
    async (pkgDir) => (await readPackage({ cwd: pkgDir })).name,
    { concurrency: config.concurrency }
  )
  const pkgColWidth = workspacePkgNames.reduce(
    (max, pkgName) => Math.max(max, pkgName.length),
    0
  )
  const results = await pMap(
    pkgDirs,
    async (pkgDir, index) =>
      await checkAndReport(
        pkgDir,
        workspacePkgNames[index],
        config,
        workspacePkgNames,
        pkgColWidth
      ),
    { concurrency: config.concurrency }
  )
  if (results.some(Boolean)) {
    process.exit(1)
  }
}

main()
