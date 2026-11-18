import * as React from 'react'
import classNames from 'classnames'
import { Commit } from '../../models/commit'
import { Branch } from '../../models/branch'
import { Emoji } from '../../lib/emoji'
import { formatDate } from '../../lib/format-date'
import { TooltippedContent } from '../lib/tooltipped-content'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { commitGraph_RowHeight, ICommitGraphRow } from './commit-graph-model'
import { Tokenizer, TokenType } from '../../lib/text-token-parser'
import { ConventionalCommitBadge } from '../lib/conventional-commit-badge'
import { parseConventionalCommit } from '../../lib/conventional-commits'
import { assertNever } from '../../lib/fatal-error'
import { getAvatarUsersForCommit } from '../../models/avatar'
import { AvatarStack } from '../lib/avatar-stack'
import { Account } from '../../models/account'
import { GitHubRepository } from '../../models/github-repository'
import { RelativeTime } from '../relative-time'
import { CommitAttribution } from '../lib/commit-attribution'

interface ICommitGraphCommitListItemProps {
  readonly commit: Commit
  readonly commitGraphRow: ICommitGraphRow
  readonly branches: ReadonlyArray<Branch>
  readonly branchColors: Map<string, string>
  readonly emoji: Map<string, Emoji>
  readonly showUnpushedIndicator: boolean
  readonly unpushedIndicatorTitle?: string
  readonly preferAbsoluteDates: boolean
  readonly showConventionalCommitBadges: boolean
  readonly currentBranch: Branch | null
  readonly currentTipSha: string | null
  readonly gitHubRepository: GitHubRepository | null
  readonly accounts: ReadonlyArray<Account>
}

// Graph spacing follows the visible lanes in each row, which keeps commit text
// close to the lane it belongs to while preserving fixed-height virtualization.
const commitGraph_LaneGap = 18
const commitGraph_LeadingPadding = 8
const commitGraph_MessageGap = 16
const commitGraph_DotRadius = 5

interface ICommitGraphSummaryProps {
  readonly className: string
  readonly emoji: Map<string, Emoji>
  readonly text: string
  readonly showConventionalCommitBadges: boolean
}

class CommitGraphSummary extends React.PureComponent<ICommitGraphSummaryProps> {
  public render() {
    const { className, emoji, text, showConventionalCommitBadges } = this.props
    const parsed = showConventionalCommitBadges
      ? parseConventionalCommit(text)
      : null

    return (
      <TooltippedContent
        tagName="span"
        className={className}
        tooltip={text}
        onlyWhenOverflowed={true}
      >
        {parsed?.leftSideText && (
          <span className="conventional-commit-prefix">
            {parsed.leftSideText}
          </span>
        )}
        {parsed && <ConventionalCommitBadge parsed={parsed} />}
        {commitGraph_renderSummaryTokens(
          emoji,
          parsed ? parsed.rightSideText : text
        )}
      </TooltippedContent>
    )
  }
}

export class CommitGraphCommitListItem extends React.PureComponent<ICommitGraphCommitListItemProps> {
  public render() {
    const { commit } = this.props
    const avatarUsers = getAvatarUsersForCommit(
      this.props.gitHubRepository,
      commit
    )
    const commitSummary = commitGraph_getCommitSummary(commit)
    const hasEmptySummary = commit.summary.length === 0
    const commitClassNames = classNames('commit', 'commitGraph-commit', {
      'merge-commit': commit.isMergeCommit,
    })
    const summaryClassNames = classNames('commitGraph-summary', {
      'empty-summary': hasEmptySummary,
    })

    return (
      <div className={commitClassNames}>
        {this.commitGraph_renderGraph()}
        <div className="commitGraph-commit-content">
          <div className="info">
            <CommitGraphSummary
              className={summaryClassNames}
              emoji={this.props.emoji}
              text={commitSummary}
              showConventionalCommitBadges={
                this.props.showConventionalCommitBadges
              }
            />
            <div className="description">
              <AvatarStack users={avatarUsers} accounts={this.props.accounts} />
              <div className="byline">
                <CommitAttribution avatarUsers={avatarUsers} />
                {` • `}
                {this.commitGraph_renderCommitTime(commit.author.date)}
              </div>
            </div>
          </div>
          {this.commitGraph_renderUnpushedIndicator()}
        </div>
      </div>
    )
  }

  private commitGraph_renderGraph() {
    const { commitGraphRow, commit } = this.props
    const height = commitGraph_RowHeight
    const width =
      commitGraph_LeadingPadding +
      commitGraphRow.maxColumn * commitGraph_LaneGap +
      commitGraph_MessageGap
    const centerY = height / 2
    const xForColumn = (column: number) =>
      commitGraph_LeadingPadding + column * commitGraph_LaneGap
    const shiftedLaneColumns = new Set(
      commitGraphRow.shifts.map(shift => shift.fromColumn)
    )

    // Build gradient definitions for connections and shifts whose start/end colors
    // differ. SVG gradient IDs are document-scoped, so embed the commit SHA for
    // uniqueness. Prefix "c" = connection, "s" = shift.
    const gradientDefs: JSX.Element[] = []
    for (let i = 0; i < commitGraphRow.connections.length; i++) {
      const conn = commitGraphRow.connections[i]
      if (conn.fromColor === conn.toColor) {
        continue
      }
      const fromX = xForColumn(conn.fromColumn)
      const toX = xForColumn(conn.toColumn)
      gradientDefs.push(
        <linearGradient
          key={`c${i}`}
          id={`cg-c${i}-${commit.sha}`}
          x1={fromX}
          y1={centerY}
          x2={toX}
          y2={height}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={conn.fromColor} />
          <stop offset="100%" stopColor={conn.toColor} />
        </linearGradient>
      )
    }
    for (let i = 0; i < commitGraphRow.shifts.length; i++) {
      const shift = commitGraphRow.shifts[i]
      if (shift.fromColor === shift.toColor) {
        continue
      }
      const fromX = xForColumn(shift.fromColumn)
      const toX = xForColumn(shift.toColumn)
      gradientDefs.push(
        <linearGradient
          key={`s${i}`}
          id={`cg-s${i}-${commit.sha}`}
          x1={fromX}
          y1={centerY}
          x2={toX}
          y2={height}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={shift.fromColor} />
          <stop offset="100%" stopColor={shift.toColor} />
        </linearGradient>
      )
    }

    return (
      <svg
        className="commitGraph-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden={true}
        focusable={false}
      >
        {gradientDefs.length > 0 && <defs>{gradientDefs}</defs>}
        {commitGraphRow.lanes.map(lane => (
          <line
            key={`lane-${lane.column}`}
            className="commitGraph-line"
            x1={xForColumn(lane.column)}
            x2={xForColumn(lane.column)}
            y1={0}
            y2={shiftedLaneColumns.has(lane.column) ? centerY : height}
            stroke={lane.color}
          />
        ))}
        {commitGraphRow.hasTopLine && (
          <line
            className="commitGraph-line"
            x1={xForColumn(commitGraphRow.column)}
            x2={xForColumn(commitGraphRow.column)}
            y1={0}
            y2={centerY - commitGraph_DotRadius}
            stroke={commitGraphRow.color}
          />
        )}
        {commitGraphRow.shifts.map((shift, index) => {
          const fromX = xForColumn(shift.fromColumn)
          const toX = xForColumn(shift.toColumn)
          const path = `M ${fromX} ${centerY} C ${fromX} ${
            centerY + 8
          }, ${toX} ${height - 8}, ${toX} ${height}`
          const stroke =
            shift.fromColor !== shift.toColor
              ? `url(#cg-s${index}-${commit.sha})`
              : shift.toColor

          return (
            <path
              key={`shift-${index}`}
              className="commitGraph-line"
              d={path}
              stroke={stroke}
            />
          )
        })}
        {commitGraphRow.connections.map((connection, index) => {
          const fromX = xForColumn(connection.fromColumn)
          const toX = xForColumn(connection.toColumn)
          const path =
            fromX === toX
              ? `M ${fromX} ${
                  centerY + commitGraph_DotRadius
                } L ${toX} ${height}`
              : `M ${fromX} ${centerY} C ${fromX} ${centerY + 8}, ${toX} ${
                  height - 8
                }, ${toX} ${height}`
          const stroke =
            connection.fromColor !== connection.toColor
              ? `url(#cg-c${index}-${commit.sha})`
              : connection.toColor

          return (
            <path
              key={`connection-${index}`}
              className="commitGraph-line"
              d={path}
              stroke={stroke}
            />
          )
        })}
        <circle
          className="commitGraph-dot"
          cx={xForColumn(commitGraphRow.column)}
          cy={centerY}
          r={commitGraph_DotRadius}
          fill={commitGraphRow.color}
        />
      </svg>
    )
  }

  private commitGraph_renderCommitTime(date: Date) {
    return this.props.preferAbsoluteDates ? (
      commitGraph_formatDate(date)
    ) : (
      <RelativeTime date={date} tooltip={false} />
    )
  }

  private commitGraph_renderUnpushedIndicator() {
    if (!this.props.showUnpushedIndicator) {
      return null
    }

    return (
      <span
        className="commitGraph-unpushed-indicator"
        role="img"
        aria-label={this.props.unpushedIndicatorTitle ?? 'Unpushed commit'}
      >
        <Octicon symbol={octicons.arrowUp} />
      </span>
    )
  }
}

function commitGraph_formatDate(date: Date) {
  const unpaddedTime = formatDate(date, {
    date: false,
    timeStyle: 'short',
  })
  const dateTime = formatDate(date, {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  return dateTime.replace(unpaddedTime, commitGraph_padTimeHour(unpaddedTime))
}

function commitGraph_padTimeHour(time: string) {
  return time.replace(/^(\d)(?=[:.]\d{2})/, '0$1')
}

function commitGraph_getCommitSummary(commit: Commit) {
  return commit.summary.length === 0 ? 'Empty commit message' : commit.summary
}

function commitGraph_renderSummaryTokens(
  emoji: Map<string, Emoji>,
  text: string
) {
  const tokenizer = new Tokenizer(emoji)

  return tokenizer.tokenize(text).map((token, index) => {
    switch (token.kind) {
      case TokenType.Emoji:
        return token.emoji ? (
          <span key={index}>{token.emoji}</span>
        ) : (
          <img
            key={index}
            alt={token.description ?? token.text}
            className="emoji"
            src={token.path}
          />
        )
      case TokenType.Link:
      case TokenType.Text:
        return <span key={index}>{token.text}</span>
      default:
        return assertNever(token, `Unknown token type: ${token}`)
    }
  })
}
