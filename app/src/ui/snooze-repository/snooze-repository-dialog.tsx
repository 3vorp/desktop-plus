import * as React from 'react'
import { addDays, addMonths, addWeeks } from 'date-fns'

import { Dispatcher } from '../dispatcher'
import { nameOf, Repository } from '../../models/repository'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Button } from '../lib/button'
import { Row } from '../lib/row'

interface ISnoozeRepositoryProps {
  readonly dispatcher: Dispatcher
  readonly onDismissed: () => void
  readonly repository: Repository
}

interface ISnoozeRepositoryState {
  /** The end of the snooze, as the value of a datetime-local input */
  readonly until: string
}

/** Formats the date as the value of a datetime-local input, in local time */
function toDateTimeLocalValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export class SnoozeRepository extends React.Component<
  ISnoozeRepositoryProps,
  ISnoozeRepositoryState
> {
  private readonly presets = [
    { label: '1 day', onClick: () => this.usePreset(addDays(new Date(), 1)) },
    { label: '1 week', onClick: () => this.usePreset(addWeeks(new Date(), 1)) },
    {
      label: '2 weeks',
      onClick: () => this.usePreset(addWeeks(new Date(), 2)),
    },
    {
      label: '1 month',
      onClick: () => this.usePreset(addMonths(new Date(), 1)),
    },
  ]

  public constructor(props: ISnoozeRepositoryProps) {
    super(props)

    this.state = { until: toDateTimeLocalValue(addWeeks(new Date(), 1)) }
  }

  public render() {
    return (
      <Dialog
        id="snooze-repository"
        title={__DARWIN__ ? 'Snooze Repository' : 'Snooze repository'}
        ariaDescribedBy="snooze-repository-description"
        onDismissed={this.props.onDismissed}
        onSubmit={this.snooze}
      >
        <DialogContent>
          <p id="snooze-repository-description">
            Snooze the repository "{nameOf(this.props.repository)}" until the
            chosen date. Until then, it will be hidden from the repository list
            and won't be refreshed in the background.
          </p>
          <Row>
            <div className="text-box-component">
              <label htmlFor="snooze-repository-until">Snooze until</label>
              <input
                id="snooze-repository-until"
                type="datetime-local"
                value={this.state.until}
                min={toDateTimeLocalValue(new Date())}
                required={true}
                onChange={this.onUntilChanged}
              />
            </div>
          </Row>
          <Row className="snooze-repository-presets">
            {this.presets.map(preset => (
              <Button key={preset.label} type="button" onClick={preset.onClick}>
                {preset.label}
              </Button>
            ))}
          </Row>
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Snooze"
            okButtonDisabled={this.getUntil() === null}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  /** The chosen end of the snooze, or null if it's invalid or in the past */
  private getUntil(): number | null {
    const until = new Date(this.state.until).getTime()
    return Number.isFinite(until) && until > Date.now() ? until : null
  }

  private onUntilChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ until: event.currentTarget.value })
  }

  private usePreset(date: Date) {
    this.setState({ until: toDateTimeLocalValue(date) })
  }

  private snooze = () => {
    const until = this.getUntil()
    if (until === null) {
      return
    }

    this.props.dispatcher.snoozeRepository(this.props.repository, until)
    this.props.onDismissed()
  }
}
