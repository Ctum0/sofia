import buildTime from '~build/time'

import { isStageWeb } from '@proj-airi/stage-shared'
import { abbreviatedSha, branch } from '~build/git'

import packageJSON from '../../package.json'

/**
 * `unplugin-info` hands back `null` (and browsers print it as `(null)`) when the
 * build ran without git metadata. Normalise every field to a plain string so the
 * About dialog can hide a row instead of rendering a placeholder.
 */
function cleanBuildField(value: unknown): string {
  if (typeof value !== 'string')
    return ''

  const trimmed = value.trim()
  return trimmed === 'null' || trimmed === 'undefined' ? '' : trimmed
}

export function useBuildInfo() {
  const version = cleanBuildField(packageJSON.version) || 'dev'
  const sha = cleanBuildField(abbreviatedSha)

  return {
    version: isStageWeb() && sha ? `${version} (${sha})` : version,
    commit: sha,
    branch: cleanBuildField(branch),
    builtOn: buildTime.toISOString(),
  }
}
