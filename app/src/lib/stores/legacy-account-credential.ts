import { Account } from '../../models/account'
import {
  AccountCredential,
  deserializeAccountCredential,
  serializeAccountCredential,
} from '../account-credential'
import { IOAuthToken, isToken } from '../oauth-token'
import { isThirdPartyOAuthAccount } from '../third-party-oauth-token'
import { ISecureStore } from './stores'

/** Persisted in plain text in the `users` entry by earlier versions. */
export interface ILegacyCredentialFields {
  readonly refreshToken?: unknown
  /** Milliseconds since the Unix epoch; 0 meant unknown. */
  readonly tokenExpiresAt?: unknown
}

export function hasLegacyCredentialFields(fields: object) {
  return 'refreshToken' in fields || 'tokenExpiresAt' in fields
}

export interface ILegacyCredentialMigration {
  readonly credential: AccountCredential
  /** Keep the legacy fields so the migration is retried on the next launch. */
  readonly pending: boolean
  /** Another app window removed the account while this one was loading. */
  readonly removed?: boolean
}

export async function migrateLegacyCredential(
  secureStore: ISecureStore,
  key: string,
  account: Account,
  legacy: ILegacyCredentialFields,
  stored: string | null,
  credential: AccountCredential
): Promise<ILegacyCredentialMigration> {
  const { refreshToken, tokenExpiresAt } = legacy
  // Versioned credentials already hold their refresh token, and GitHub
  // accounts and personal access tokens never had one.
  if (
    credential === null ||
    credential.refreshToken !== undefined ||
    !isToken(refreshToken) ||
    !isThirdPartyOAuthAccount(account)
  ) {
    return { credential, pending: false }
  }

  // An unknown expiry renews the pair the first time it is used. The stored
  // expiry is up to 10% earlier than the real one, which is harmless.
  const migrated: IOAuthToken = {
    accessToken: credential.accessToken,
    refreshToken,
    ...(typeof tokenExpiresAt === 'number' &&
    Number.isSafeInteger(tokenExpiresAt) &&
    tokenExpiresAt > 0
      ? { expiresAt: tokenExpiresAt }
      : {}),
  }

  try {
    // Another app window may have migrated, rotated or removed it since.
    const current = await secureStore.getItem(key, account.login)
    if (current === null) {
      return { credential: null, pending: false, removed: true }
    }
    if (current !== stored) {
      const latest = deserializeAccountCredential(current)
      return latest === null
        ? { credential: migrated, pending: true }
        : { credential: latest, pending: false }
    }
    await secureStore.setItem(
      key,
      account.login,
      serializeAccountCredential(migrated)
    )
    return { credential: migrated, pending: false }
  } catch {
    log.error('Unable to move a refresh token to secure storage.')
    return { credential: migrated, pending: true }
  }
}

export const getPersistedUserKey = (user: {
  readonly endpoint: unknown
  readonly login: unknown
}) => `${user.endpoint}:${user.login}`

/**
 * Pending migrations keep their legacy fields so they can be retried, and
 * entries that could not be loaded (e.g. secure storage was locked) are kept
 * unchanged so they load again later.
 *
 * `unloaded` maps persisted keys to the keys they load as, which differ when
 * loading migrates the endpoint.
 */
export function withPersistedUsers(
  users: ReadonlyArray<Account>,
  persisted: string | null,
  isPending: (account: Account) => boolean,
  unloaded: Map<string, string>
): ReadonlyArray<object> {
  const loaded = new Set(users.map(getPersistedUserKey))
  for (const [persistedKey, loadedKey] of unloaded) {
    if (loaded.has(persistedKey) || loaded.has(loadedKey)) {
      unloaded.delete(persistedKey)
    }
  }
  if (!users.some(isPending) && unloaded.size === 0) {
    return users
  }
  let parsed: unknown
  try {
    parsed = persisted === null ? [] : JSON.parse(persisted)
  } catch {
    parsed = []
  }
  const persistedUsers = new Map<string, Record<string, unknown>>()
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    if (typeof entry === 'object' && entry !== null) {
      persistedUsers.set(getPersistedUserKey(entry), entry)
    }
  }

  const saved: Array<object> = users.map(user => {
    const legacy = isPending(user)
      ? persistedUsers.get(getPersistedUserKey(user))
      : undefined
    return legacy === undefined
      ? user
      : {
          ...user,
          refreshToken: legacy.refreshToken,
          tokenExpiresAt: legacy.tokenExpiresAt,
        }
  })
  for (const [persistedKey, loadedKey] of [...unloaded]) {
    const entry =
      persistedUsers.get(persistedKey) ?? persistedUsers.get(loadedKey)
    if (entry === undefined) {
      unloaded.delete(persistedKey)
    } else {
      saved.push(entry)
    }
  }
  return saved
}
