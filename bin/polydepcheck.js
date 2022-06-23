#!/usr/bin/env node

import 'hard-rejection/register.js'

import fs from 'fs-extra'
import { globby } from 'globby'
import minimist from 'minimist'
import os from 'node:os'
import path from 'node:path'
import pMap from 'p-map'
import { Piscina } from 'piscina'
import { readPackage } from 'read-pkg'

const DEFAULT_CONFIG = {
  ignoreMissing: {},
  ignoreUnused: {},
  ignorePatterns: [],
  concurrency: os.cpus().length,
  verbose: false
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
  return config
}

const main = async () => {
  const config = await buildConfig()
  const { workspaces } = await readPackage()
  const pkgDirs = await globby(workspaces, {
    onlyDirectories: true,
    absolute: true
  })
  const pool = new Piscina({
    filename: new URL('../lib/worker.js', import.meta.url).href,
    minThreads: config.concurrency,
    maxThreads: config.concurrency
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
      await pool.run({ pkgDir, pkgName: pkgNames[index], config, pkgColWidth }),
    { concurrency: config.concurrency }
  )
  if (results.some(Boolean)) {
    process.exit(1)
  }
}

main()
