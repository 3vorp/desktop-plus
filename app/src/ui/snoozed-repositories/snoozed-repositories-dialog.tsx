import * as React from 'react'

import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { CloningRepository } from '../../models/cloning-repository'
import { Dialog, DialogContent, DefaultDialogFooter } from '../dialog'
import { SnoozedRepositoryListItem } from './snoozed-repository-list-item'

interface ISnoozedRepositoriesDialogProps {
  readonly dispatcher: Dispatcher
  readonly repositories: ReadonlyArray<Repository | CloningRepository>

  /** The ids of the snoozed repositories, mapped to when their snooze ends */
  readonly snoozedRepositories: ReadonlyMap<number, number>

  readonly onDismissed: () => void
}

/** Lists the snoozed repositories, allowing to unsnooze them */
export class SnoozedRepositoriesDialog extends React.Component<ISnoozedRepositoriesDialogProps> {
  private onUnsnoozeRepository = (repository: Repository) => {
    this.props.dispatcher.unsnoozeRepository(repository)
  }

  private renderList() {
    const { repositories, snoozedRepositories } = this.props
    const snoozed = repositories
      .filter(
        (r): r is Repository =>
          r instanceof Repository && snoozedRepositories.has(r.id)
      )
      .map(repository => ({
        repository,
        until: snoozedRepositories.get(repository.id) ?? 0,
      }))
      .sort((x, y) => x.until - y.until)

    if (snoozed.length === 0) {
      return (
        <div className="no-snoozed-repositories">No snoozed repositories.</div>
      )
    }

    return (
      <ul className="snoozed-repository-list">
        {snoozed.map(({ repository, until }) => (
          <SnoozedRepositoryListItem
            key={repository.id}
            repository={repository}
            until={until}
            onUnsnooze={this.onUnsnoozeRepository}
          />
        ))}
      </ul>
    )
  }

  public render() {
    return (
      <Dialog
        id="snoozed-repositories"
        title={__DARWIN__ ? 'Snoozed Repositories' : 'Snoozed repositories'}
        onSubmit={this.props.onDismissed}
        onDismissed={this.props.onDismissed}
      >
        <DialogContent>{this.renderList()}</DialogContent>
        <DefaultDialogFooter />
      </Dialog>
    )
  }
}
