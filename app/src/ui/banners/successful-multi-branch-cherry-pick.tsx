import * as React from 'react'
import { SuccessBanner } from './success-banner'

interface ISuccessfulMultiBranchCherryPickBannerProps {
  readonly targetBranchNames: ReadonlyArray<string>
  readonly countCherryPicked: number
  readonly onDismissed: () => void
}

/** Success banner shown after cherry-picking to multiple branches at once. */
export class SuccessfulMultiBranchCherryPick extends React.Component<
  ISuccessfulMultiBranchCherryPickBannerProps,
  {}
> {
  public render() {
    const { countCherryPicked, onDismissed, targetBranchNames } = this.props

    const pluralized = countCherryPicked === 1 ? 'commit' : 'commits'

    return (
      <SuccessBanner timeout={15000} onDismissed={onDismissed}>
        <span>
          Successfully copied {countCherryPicked} {pluralized} to{' '}
          {targetBranchNames.length} branches:{' '}
          {targetBranchNames.map((name, i) => (
            <React.Fragment key={name}>
              {i > 0 && ', '}
              <strong>{name}</strong>
            </React.Fragment>
          ))}
          .
        </span>
      </SuccessBanner>
    )
  }
}
