import * as React from 'react'
import { Branch } from '../../../models/branch'
import { IMatches } from '../../../lib/fuzzy-find'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  OkCancelButtonGroup,
} from '../../dialog'
import {
  BranchList,
  IBranchListItem,
  renderDefaultBranch,
} from '../../branches'
import { ClickSource } from '../../lib/list'
import { getDefaultAriaLabelForBranch } from '../../branches/branch-renderer'
import { Repository } from '../../../models/repository'
import { BranchSortOrder } from '../../../models/branch-sort-order'
import { Checkbox, CheckboxValue } from '../../lib/checkbox'

interface IChooseTargetBranchDialogProps {
  readonly repository: Repository
  /**
   * See IBranchesState.defaultBranch
   */
  readonly defaultBranch: Branch | null

  /**
   * The currently checked out branch
   */
  readonly currentBranch: Branch

  /**
   * See IBranchesState.allBranches
   */
  readonly allBranches: ReadonlyArray<Branch>

  /**
   * See IBranchesState.recentBranches
   */
  readonly recentBranches: ReadonlyArray<Branch>

  /**
   * Number of commits to cherry pick
   */
  readonly commitCount: number

  /**
   * A function that's called when the user selects a branch and hits start
   * cherry pick
   */
  readonly onCherryPick: (targetBranch: Branch) => void

  /**
   * A function that's called when the user checks more than one branch and
   * hits start cherry pick
   */
  readonly onCherryPickToMultipleBranches: (
    targetBranches: ReadonlyArray<Branch>
  ) => void

  /**
   * A function that's called when the dialog is dismissed by the user in the
   * ways described in the Dialog component's dismissable prop.
   */
  readonly onDismissed: () => void

  /**
   * Call back to invoke create new branch dialog
   */
  readonly onCreateNewBranch: (targetBranchName: string) => void

  /** The sort order for branch lists in the current user preferences. */
  readonly branchSortOrder: BranchSortOrder
}

interface IChooseTargetBranchDialogState {
  /** The currently selected branch. */
  readonly selectedBranch: Branch | null

  /** The filter text to use in the branch selector */
  readonly filterText: string

  /** When there are no branches to show, prompt for create branch */
  readonly isCreateBranchState: boolean

  /** The branches checked as cherry-pick targets, in the order checked. */
  readonly checkedBranches: ReadonlyArray<Branch>
}

/** A component for initiating a rebase of the current branch. */
export class ChooseTargetBranchDialog extends React.Component<
  IChooseTargetBranchDialogProps,
  IChooseTargetBranchDialogState
> {
  public constructor(props: IChooseTargetBranchDialogProps) {
    super(props)

    this.state = {
      selectedBranch: null,
      filterText: '',
      isCreateBranchState: props.allBranches.length === 0,
      checkedBranches: [],
    }
  }

  private onFilterTextChanged = (filterText: string) => {
    this.setState({ filterText })
  }

  private onSelectionChanged = (selectedBranch: Branch | null) => {
    this.setState({ selectedBranch })
  }

  private isBranchChecked(branch: Branch) {
    return this.state.checkedBranches.some(b => b.name === branch.name)
  }

  private toggleCheckedBranch(branch: Branch) {
    if (branch.name === this.props.currentBranch.name) {
      return
    }

    this.setState(({ checkedBranches }) => ({
      checkedBranches: checkedBranches.some(b => b.name === branch.name)
        ? checkedBranches.filter(b => b.name !== branch.name)
        : [...checkedBranches, branch],
    }))
  }

  private renderBranch = (item: IBranchListItem, matches: IMatches) => {
    const { branch } = item
    const checkboxValue = this.isBranchChecked(branch)
      ? CheckboxValue.On
      : CheckboxValue.Off

    return (
      <div className="cherry-pick-target-branch">
        <Checkbox
          tabIndex={-1}
          value={checkboxValue}
          disabled={branch.name === this.props.currentBranch.name}
        />
        {renderDefaultBranch(item, matches, this.props.currentBranch)}
      </div>
    )
  }

  private getBranchAriaLabel = (item: IBranchListItem): string => {
    const label = getDefaultAriaLabelForBranch(item)
    return this.isBranchChecked(item.branch)
      ? `${label}, checked`
      : `${label}, not checked`
  }

  private onItemClick = (branch: Branch, source: ClickSource) => {
    if (source.kind === 'keyboard' && source.event.key === 'Enter') {
      this.onEnterPressed(branch, source)
    } else {
      this.toggleCheckedBranch(branch)
    }
  }

  private onEnterPressed = (branch: Branch, source: ClickSource) => {
    if (source.kind !== 'keyboard' || source.event.key !== 'Enter') {
      return
    }

    source.event.preventDefault()

    const { selectedBranch } = this.state
    if (selectedBranch !== null && selectedBranch.name === branch.name) {
      this.startCherryPick()
    }
  }

  private canCherryPickOntoSelectedBranch() {
    if (this.state.checkedBranches.length > 0) {
      return true
    }

    const { selectedBranch, isCreateBranchState } = this.state
    return (
      (selectedBranch !== null && !this.selectedBranchIsCurrentBranch()) ||
      isCreateBranchState
    )
  }

  private selectedBranchIsCurrentBranch() {
    const { selectedBranch } = this.state
    const currentBranch = this.props.currentBranch
    return (
      selectedBranch !== null &&
      currentBranch !== null &&
      selectedBranch.name === currentBranch.name
    )
  }

  private renderOkButtonText() {
    const { selectedBranch, isCreateBranchState } = this.state

    if (isCreateBranchState) {
      return __DARWIN__
        ? 'Cherry-pick to New Branch'
        : 'Cherry-pick to new branch'
    }

    const pluralize = this.props.commitCount > 1 ? 'commits' : 'commit'
    const okButtonText = `Cherry-pick ${this.props.commitCount} ${pluralize}`

    const { checkedBranches } = this.state
    if (checkedBranches.length > 1) {
      return (
        <>
          <span>{okButtonText} to</span>{' '}
          <strong>{checkedBranches.length} branches</strong>…
        </>
      )
    }

    if (checkedBranches.length === 1) {
      return (
        <>
          <span>{okButtonText} to</span>{' '}
          <strong>{checkedBranches[0].name}</strong>…
        </>
      )
    }

    if (selectedBranch !== null) {
      return (
        <>
          <span>{okButtonText} to</span> <strong>{selectedBranch.name}</strong>…
        </>
      )
    }

    return okButtonText
  }

  private onFilterListResultsChanged = (resultCount: number) => {
    const { isCreateBranchState } = this.state
    if (resultCount === 0 && !isCreateBranchState) {
      this.setState({ isCreateBranchState: true })
    } else if (resultCount > 0 && isCreateBranchState) {
      this.setState({ isCreateBranchState: false })
    }
  }

  public render() {
    const tooltip =
      this.state.checkedBranches.length === 0 &&
      this.selectedBranchIsCurrentBranch()
        ? 'You are not able to cherry-pick from and to the same branch'
        : undefined

    const pluralize = this.props.commitCount > 1 ? 'commits' : 'commit'
    return (
      <Dialog
        id="cherry-pick"
        onDismissed={this.props.onDismissed}
        onSubmit={this.onSubmit}
        title={
          <strong>
            Cherry-pick {this.props.commitCount} {pluralize} to a branch
          </strong>
        }
      >
        <DialogContent>
          <BranchList
            repository={this.props.repository}
            allBranches={this.props.allBranches}
            currentBranch={this.props.currentBranch}
            defaultBranch={this.props.defaultBranch}
            recentBranches={this.props.recentBranches}
            branchSortOrder={this.props.branchSortOrder}
            filterText={this.state.filterText}
            onFilterTextChanged={this.onFilterTextChanged}
            onFilterListResultsChanged={this.onFilterListResultsChanged}
            selectedBranch={this.state.selectedBranch}
            onSelectionChanged={this.onSelectionChanged}
            canCreateNewBranch={true}
            onCreateNewBranch={this.props.onCreateNewBranch}
            renderBranch={this.renderBranch}
            getBranchAriaLabel={this.getBranchAriaLabel}
            onItemClick={this.onItemClick}
            invalidationProps={this.state.checkedBranches}
          />
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={this.renderOkButtonText()}
            okButtonDisabled={!this.canCherryPickOntoSelectedBranch()}
            okButtonTitle={tooltip}
            cancelButtonVisible={false}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private onSubmit = async () => {
    const { isCreateBranchState, filterText } = this.state
    if (isCreateBranchState) {
      this.props.onCreateNewBranch(filterText)
      return
    }

    this.startCherryPick()
  }

  private startCherryPick = async () => {
    if (this.state.checkedBranches.length > 0) {
      this.startCherryPickToCheckedBranches()
      return
    }

    const { selectedBranch } = this.state

    if (selectedBranch === null || !this.canCherryPickOntoSelectedBranch()) {
      return
    }

    this.props.onCherryPick(selectedBranch)
  }

  private startCherryPickToCheckedBranches() {
    const { checkedBranches } = this.state

    if (checkedBranches.length === 1) {
      this.props.onCherryPick(checkedBranches[0])
    } else if (checkedBranches.length > 1) {
      this.props.onCherryPickToMultipleBranches(checkedBranches)
    }
  }
}
