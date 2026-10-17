import { Account } from '../../models/account'
import {
  AccountCredential,
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

export async function migrateLegacyCredential(
  secureStore: ISecureStore,
  key: string,
  account: Account,
  legacy: ILegacyCredentialFields,
  credential: AccountCredential
): Promise<{
  readonly credential: AccountCredential
  /** Keep the legacy fields so the migration is retried on the next launch. */
  readonly pending: boolean
}> {
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

  // An unknown expiry renews the pair the first time it is used.
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

export type PersistedUsers = ReadonlyMap<string, Record<string, unknown>>

/** Returns undefined if there are no persisted `users` or they cannot be read. */
export function parsePersistedUsers(
  persisted: string | null
): PersistedUsers | undefined {
  let parsed: unknown
  try {
    parsed = persisted === null ? undefined : JSON.parse(persisted)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) {
    return undefined
  }
  const users = new Map<string, Record<string, unknown>>()
  for (const entry of parsed) {
    if (typeof entry === 'object' && entry !== null) {
      users.set(getPersistedUserKey(entry), entry)
    }
  }
  return users
}

/**
 * Pending migrations keep their legacy fields so they can be retried, and
 * entries not in `ownKeys` were written by other app windows and are kept.
 */
export function withPersistedUsers(
  users: ReadonlyArray<Account>,
  persisted: PersistedUsers | undefined,
  isPending: (account: Account) => boolean,
  ownKeys: ReadonlySet<string>
): ReadonlyArray<object> {
  const saved: Array<object> = users.map(user => {
    const legacy = isPending(user)
      ? persisted?.get(getPersistedUserKey(user))
      : undefined
    return legacy === undefined
      ? user
      : {
          ...user,
          refreshToken: legacy.refreshToken,
          tokenExpiresAt: legacy.tokenExpiresAt,
        }
  })
  const keys = new Set(users.map(getPersistedUserKey))
  for (const [key, entry] of persisted ?? []) {
    if (!keys.has(key) && !ownKeys.has(key)) {
      saved.push(entry)
    }
  }
  return saved
}
