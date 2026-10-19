import * as LocalStorage from '../local-storage'

const SnoozedRepositoriesKey = 'snoozed-repositories'

/**
 * The ids of the snoozed repositories, mapped to the time (in milliseconds
 * since the epoch) when their snooze ends. May include expired snoozes.
 */
export function getSnoozedRepositories(): ReadonlyMap<number, number> {
  const stored = LocalStorage.getObject<unknown>(SnoozedRepositoriesKey)
  const snoozed = new Map<number, number>()

  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return snoozed
  }

  for (const [key, until] of Object.entries(stored)) {
    const repositoryId = Number(key)
    if (
      Number.isSafeInteger(repositoryId) &&
      typeof until === 'number' &&
      Number.isFinite(until)
    ) {
      snoozed.set(repositoryId, until)
    }
  }

  return snoozed
}

export function setSnoozedRepositories(
  snoozed: ReadonlyMap<number, number>
): void {
  LocalStorage.setObject(SnoozedRepositoriesKey, Object.fromEntries(snoozed))
}

/** Returns the snoozes that haven't ended by the given time */
export function getActiveSnoozes(
  snoozed: ReadonlyMap<number, number>,
  now: number
): ReadonlyMap<number, number> {
  return new Map([...snoozed].filter(([, until]) => until > now))
}

export function areSnoozesEqual(
  x: ReadonlyMap<number, number>,
  y: ReadonlyMap<number, number>
): boolean {
  return x.size === y.size && [...x].every(([id, until]) => y.get(id) === until)
}
