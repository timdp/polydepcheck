import chalk from 'chalk'
import depcheck from 'depcheck'
import micromatch from 'micromatch'
import { readPackage } from 'read-pkg'

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

export default async ({ pkgDir, pkgName, config, pkgColWidth }) => {
  const pkgNameFixed = pkgName.padEnd(pkgColWidth)
  const { dependencies, devDependencies, missing } = await depcheck(pkgDir, {
    ignorePatterns: config.ignorePatterns
  })
  const missingNames = filter(
    Object.keys(missing),
    pkgName,
    config.ignoreMissing
  )
  if (missingNames.length > 0) {
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
