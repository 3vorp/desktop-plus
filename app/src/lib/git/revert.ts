import { git, IGitStringExecutionOptions } from './core'

import { Repository } from '../../models/repository'
import { Commit } from '../../models/commit'
import { IRevertProgress } from '../../models/progress'

import { executionOptionsWithProgress } from '../progress/from-process'
import { RevertProgressParser } from '../progress/revert'
import {
  envForRemoteOperation,
  getFallbackUrlForProxyResolve,
} from './environment'
import { IRemote } from '../../models/remote'

/**
 * Creates a new commit that reverts the changes of a previous commit
 *
 * @param repository  - The repository to update
 *
 * @param commit         - The SHA of the commit to be reverted
 */
export async function revertCommit(
  repository: Repository,
  commit: Commit,
  currentRemote: IRemote | null,
  progressCallback?: (progress: IRevertProgress) => void
) {
  const args = ['revert']
  if (commit.parentSHAs.length > 1) {
    args.push('-m', '1')
  }

  args.push(commit.sha)

  let opts: IGitStringExecutionOptions = {}
  if (progressCallback) {
    const env = await envForRemoteOperation(
      getFallbackUrlForProxyResolve(repository, currentRemote)
    )
    opts = await executionOptionsWithProgress(
      { env, trackLFSProgress: true },
      new RevertProgressParser(),
      progress => {
        const description =
          progress.kind === 'progress' ? progress.details.text : progress.text
        const title = progress.kind === 'progress' ? progress.details.title : ''
        const value = progress.percent

        progressCallback({ kind: 'revert', description, value, title })
      }
    )
  }

  await git(args, repository.path, 'revert', opts)
}

/**
 * Creates a new revert commit for each of the given commits, one at a time
 * and in the order given.
 */
export async function revertCommits(
  repository: Repository,
  commits: ReadonlyArray<Commit>,
  currentRemote: IRemote | null,
  progressCallback?: (progress: IRevertProgress) => void
) {
  for (const [index, commit] of commits.entries()) {
    try {
      await revertCommit(repository, commit, currentRemote, progressCallback)
    } catch (e) {
      const notReverted = commits.slice(index + 1)
      if (notReverted.length === 0 || !(e instanceof Error)) {
        throw e
      }

      const notRevertedList = notReverted
        .map(c => `${c.shortSha} ${c.summary}`)
        .join('\n')
      throw new Error(
        `${e.message}\n\nThe following commits were not reverted:\n${notRevertedList}`
      )
    }
  }
}
