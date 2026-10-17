import { ISecureStore } from './stores/stores'
import { getKeyForAccount } from './auth'
import { Account, accountEquals } from '../models/account'
import { getHTMLURL } from './api'
import {
  IOAuthToken,
  OAuthRefreshRejectedError,
  OAuthTokenResponseError,
} from './oauth-token'
import {
  AccountCredential,
  deserializeAccountCredential,
  serializeAccountCredential,
} from './account-credential'
import {
  renewAccountToken,
  revokeAccountToken,
  RevocableToken,
} from './third-party-oauth-token'
import { sleep } from './promise'

/** Renew credentials that expire within this window before handing them out. */
export const refreshMargin = 10 * 60 * 1000
/** Stop waiting for a leased token's holders once it is this close to expiring. */
const leasedRenewalMargin = 60 * 1000
const revocationTimeout = 30_000
/** Wait this long before renewing again after a rejected token failed to renew. */
const recoveryRetryInterval = 60_000
const maxRenewalJitter = 5 * 60 * 1000

/**
 * Keeps a window from consuming a single-use refresh token that another app
 * window renews at the same time. Windows have their own sessions but share
 * secure storage.
 */
export interface IRenewalTiming {
  /** Added to every renewal margin, so windows rarely renew at the same time. */
  readonly renewalJitter: number
  /**
   * After the provider rejects this window's refresh token, secure storage is
   * read again after these delays, in case another window's concurrent
   * renewal is still being saved.
   */
  readonly rereadDelays: ReadonlyArray<number>
  readonly wait: (milliseconds: number) => Promise<void>
}

export const immediateRenewalTiming: IRenewalTiming = {
  renewalJitter: 0,
  rereadDelays: [],
  wait: () => Promise.resolve(),
}

let installedRenewalTiming: IRenewalTiming | undefined

export function installRenewalTiming(timing: IRenewalTiming) {
  installedRenewalTiming = timing
}

export function getDefaultRenewalTiming(): IRenewalTiming {
  return installedRenewalTiming ?? immediateRenewalTiming
}

export function createRenewalTiming(random = Math.random): IRenewalTiming {
  return {
    renewalJitter: Math.floor(random() * maxRenewalJitter),
    rereadDelays: [1_000, 1_500],
    wait: sleep,
  }
}

/** Authentication cannot proceed until the user signs in again. */
export class AccountRequiresSignInError extends Error {
  public constructor() {
    super('Your session could not be renewed. Please sign in again.')
  }
}

interface ICredentialSession {
  readonly account: Account
  credential: AccountCredential
  retired: boolean
  refreshing?: Promise<string>
  /** Leases on access tokens that are in use, such as by running Git processes. */
  readonly leases: Set<ILease>
  /** Callers waiting for a leased token to be released or the session to retire. */
  readonly leaseWaiters: Set<() => void>
  /** The credential this session was signed out for being unusable, if any. */
  signedOutCredential?: AccountCredential
  isStored?: boolean
  /**
   * A token this session obtained because its predecessor was rejected, by
   * renewing or adopting another window's pair. It is never renewed again.
   */
  recoveredToken?: string
  /** The last renewal attempted for a rejected token, which failed. */
  failedRecovery?: { readonly token: string; readonly at: number }
}

type SignIn = Pick<Account, 'endpoint' | 'login'>

interface ILease {
  readonly token: string
  readonly holder: string
}

/** An access token that is not renewed until it is released. */
export interface ITokenLease {
  readonly token: string
  /** Stop holding the token. Safe to call more than once. */
  readonly release: () => void
}

/** Account-list changes that credential sessions ask their owner to perform. */
export interface ICredentialSessionsDelegate {
  /**
   * Sign the account out because its credential can no longer be used.
   *
   * Must call `retire` synchronously before its first `await`. Returns the
   * removed account, or null if it was no longer installed.
   */
  readonly requireSignIn: (account: Account) => Promise<Account | null>

  /** A renewed access token for the endpoint was saved and installed. */
  readonly onTokenRenewed: (
    endpoint: string,
    accessToken: string,
    login: string
  ) => void

  /**
   * A sign-in was saved and installed, replacing any session for its login.
   *
   * Called synchronously with the swap, so the owner's account list never
   * disagrees with the installed session.
   */
  readonly onSignedIn: (account: Account) => void

  /** Another app window removed the account, so its credential is already gone. */
  readonly onRemovedElsewhere?: (account: Account) => void
}

/**
 * Credential lifecycle for signed-in accounts: one session per account.
 *
 * Owns token renewal, lookup of stale token copies, rejected-token handling,
 * and ordered secure-storage writes. The account list stays with the owner,
 * which is told through `ICredentialSessionsDelegate` when it must change.
 */
export class CredentialSessions {
  /** Signed-in session for each `signInKey`: account, credential, renewal state. */
  private readonly sessionsBySignIn = new Map<string, ICredentialSession>()
  /**
   * Session that issued each access token, keyed by `tokenKey`. API clients
   * keep the token they were created with; this maps that copy (even after
   * rotation) back to its session so `resolveToken` can return the current one.
   */
  private readonly sessionsByToken = new Map<string, ICredentialSession>()
  /** Immutable account snapshots retain their issuing session across token reuse. */
  private readonly sessionsByAccount = new WeakMap<
    Account,
    ICredentialSession
  >()
  /** Per-account queue so secure-storage saves and deletes never interleave. */
  private readonly credentialWriteQueues = new Map<string, Promise<void>>()

  public constructor(
    private readonly secureStore: ISecureStore,
    private readonly delegate: ICredentialSessionsDelegate,
    private readonly renewToken = renewAccountToken,
    private readonly now = Date.now,
    private readonly revokeToken = revokeAccountToken,
    private readonly timing = getDefaultRenewalTiming()
  ) {}

  /**
   * Install a credential and return its account snapshot.
   *
   * An already-associated snapshot keeps its original session; restoring it
   * again creates a distinct snapshot, even when its token is unchanged.
   */
  public restore(
    account: Account,
    credential: AccountCredential,
    isStored = false
  ): Account {
    const restored = this.sessionsByAccount.has(account)
      ? account.withToken(account.token)
      : account
    const session: ICredentialSession = {
      account: restored,
      credential,
      retired: false,
      leases: new Set(),
      leaseWaiters: new Set(),
      isStored,
    }
    this.retireSession(account)
    this.sessionsBySignIn.set(this.signInKey(account), session)
    this.sessionsByAccount.set(restored, session)
    if (credential !== null) {
      this.sessionsByToken.set(
        this.tokenKey(account.endpoint, credential.accessToken),
        session
      )
    }
    return restored
  }

  /**
   * Save and install a new credential, replacing any session for its login.
   *
   * Saves run in call order and each one is installed as soon as it succeeds,
   * so memory always matches the last successful save. A failed save leaves
   * the current session untouched. Returns the account carrying the
   * credential's access token. Throws if secure storage fails.
   */
  public async add(
    account: Account,
    credential: IOAuthToken
  ): Promise<Account> {
    const authenticated = account.withToken(credential.accessToken)
    await this.write(this.signInKey(account), async () => {
      await this.secureStore.setItem(
        getKeyForAccount(account),
        account.login,
        serializeAccountCredential(credential)
      )
      // Swap inside the write so a renewal of the replaced session queued
      // behind it sees the retirement and cannot overwrite this credential.
      this.retireSession(account)
      this.restore(authenticated, credential, true)
      if (!this.sessionsByAccount.has(account)) {
        this.inheritSession(authenticated, account)
      }
      this.delegate.onSignedIn(authenticated)
    })
    return authenticated
  }

  /** Stop using the login's session so no caller can obtain its token again. */
  public retire(endpoint: string, login: string): void {
    this.retireSession({ endpoint, login })
  }

  /**
   * Delete the account's stored credential after any pending write.
   *
   * Skipped if a later sign-in with the same login has been installed since:
   * the stored item now holds that sign-in's credential.
   */
  public delete(account: Account): Promise<void> {
    return this.write(this.signInKey(account), async () => {
      const current = this.getSession(account)
      if (current?.account.login === account.login) {
        return
      }
      if (await this.hasNewerStoredCredential(account)) {
        return
      }
      await this.secureStore.deleteItem(
        getKeyForAccount(account),
        account.login
      )
    })
  }

  private retireSession(account: SignIn): void {
    const previous = this.getSession(account)
    if (previous !== undefined) {
      previous.retired = true
      previous.credential = null
      this.notifyLeaseWaiters(previous)
    }
    this.sessionsBySignIn.delete(this.signInKey(account))
  }

  /** Resolve token snapshots held by long-lived clients without changing identity. */
  public resolveToken(
    endpoint: string,
    token: string,
    login?: string
  ): Promise<string> {
    const session = this.sessionsByToken.get(this.tokenKey(endpoint, token))
    // Several accounts can share an endpoint: only the caller's login
    // identifies which one an empty token belongs to.
    const current =
      login === undefined ? undefined : this.getSession({ endpoint, login })
    if (token === '' && current?.credential === null) {
      return this.validToken(current)
    }
    // Never resolve a caller's token to another account's current token.
    if (
      session !== undefined &&
      login !== undefined &&
      session.account.login !== login
    ) {
      return Promise.resolve(token)
    }
    return session === undefined
      ? Promise.resolve(token)
      : this.validToken(session)
  }

  /**
   * Get an access token for the account valid for at least `minimumValidity`.
   *
   * If the token needs renewing while it is leased, waits for its holders to
   * release it first. See `leaseToken`.
   *
   * Throws `AccountRequiresSignInError` if the account has no usable session.
   */
  public async getFreshToken(
    account: Account,
    minimumValidity = refreshMargin
  ): Promise<string> {
    const session = this.getSession(account)
    if (session === undefined || session.account.id !== account.id) {
      throw new AccountRequiresSignInError()
    }
    const token = await this.validToken(session, minimumValidity)
    if (session.retired) {
      throw new AccountRequiresSignInError()
    }
    return token
  }

  /** Preserve the issuing session when publishing an immutable account copy. */
  public inheritSession(original: Account, updated: Account): Account {
    const session = this.sessionsByAccount.get(original)
    const previous = this.sessionsByAccount.get(updated)
    if (
      session === undefined ||
      !accountEquals(original, updated) ||
      (previous !== undefined && previous !== session)
    ) {
      throw new AccountRequiresSignInError()
    }
    this.sessionsByAccount.set(updated, session)
    return updated
  }

  /**
   * Bind access-token acquisition and expiry metadata to the account's session.
   *
   * Follows token rotation within the issuing session, but permanently rejects
   * once that session retires, even if the same user signs in again.
   * Throws at creation if the snapshot is unknown or its session has retired.
   */
  public createTokenGetter(
    account: Account,
    minimumValidity = refreshMargin
  ): () => Promise<Pick<IOAuthToken, 'accessToken' | 'expiresAt'>> {
    const session = this.sessionsByAccount.get(account)
    if (
      session === undefined ||
      session.retired ||
      !accountEquals(session.account, account)
    ) {
      throw new AccountRequiresSignInError()
    }
    return async () => {
      for (;;) {
        const token = await this.validToken(session, minimumValidity)
        if (session.retired) {
          throw new AccountRequiresSignInError()
        }
        const credential = session.credential
        // A concurrent rotation must not pair an old token with the new expiry.
        if (
          session.refreshing === undefined &&
          credential?.accessToken === token
        ) {
          return { accessToken: token, expiresAt: credential.expiresAt }
        }
      }
    }
  }

  /**
   * Get an access token for `holder` and hold off renewing it until the lease
   * is released.
   *
   * Renewal revokes the previous access token, but some consumers keep using
   * the token they were given: Git reuses a credential for every request a
   * process makes. Anyone who needs a leased token renewed waits until every
   * holder releases it, or until it is about to expire anyway, except a holder
   * of that token, which gets it again instead. If renewal fails for a reason other than
   * the account being signed out, the current token is used while it is
   * unexpired.
   *
   * Throws `AccountRequiresSignInError` if the account has no usable session.
   */
  public async leaseToken(
    account: Account,
    holder: string,
    minimumValidity = refreshMargin
  ): Promise<ITokenLease> {
    for (;;) {
      const session = this.getSession(account)
      if (session === undefined || session.account.id !== account.id) {
        throw new AccountRequiresSignInError()
      }
      let token: string
      try {
        token = await this.validToken(session, minimumValidity, holder)
      } catch (e) {
        const credential = session.credential
        if (session.retired || e instanceof AccountRequiresSignInError) {
          throw new AccountRequiresSignInError()
        }
        if (
          credential === null ||
          (credential.expiresAt !== undefined &&
            credential.expiresAt <= this.now())
        ) {
          throw e
        }
        log.warn('OAuth renewal failed; using the current credentials.')
        token = credential.accessToken
      }
      if (session.retired) {
        throw new AccountRequiresSignInError()
      }
      // A renewal that started while this caller waited would revoke `token`.
      if (
        session.refreshing === undefined &&
        session.credential?.accessToken === token
      ) {
        const lease: ILease = { token, holder }
        session.leases.add(lease)
        const release = () => {
          if (session.leases.delete(lease)) {
            this.notifyLeaseWaiters(session)
          }
        }
        return { token, release }
      }
    }
  }

  /**
   * Resolve once a lease may have been released, the credential is about to
   * expire, or the session is retired. Callers must check the session again.
   */
  private waitForLeaseRelease(
    session: ICredentialSession,
    credential: IOAuthToken
  ): Promise<void> {
    return new Promise(resolve => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        clearTimeout(timeout)
        session.leaseWaiters.delete(done)
        resolve()
      }
      session.leaseWaiters.add(done)
      if (credential.expiresAt !== undefined) {
        timeout = setTimeout(
          done,
          credential.expiresAt - leasedRenewalMargin - this.now()
        )
      }
    })
  }

  private notifyLeaseWaiters(session: ICredentialSession) {
    for (const done of [...session.leaseWaiters]) {
      done()
    }
  }

  /**
   * Follow the login's current session across renewals.
   *
   * The returned function yields that session's access token, or null once it
   * is retired, so a slow caller never adopts a later sign-in's token.
   */
  public trackToken(endpoint: string, login: string): () => string | null {
    const session = this.getSession({ endpoint, login })
    return () =>
      session === undefined || session.retired
        ? null
        : session.credential?.accessToken ?? null
  }

  /** Whether an account owns a rotating credential pair. */
  public isRefreshable(account: Account): boolean {
    const session = this.sessionsByAccount.get(account)
    return (
      session !== undefined &&
      !session.retired &&
      session.credential?.refreshToken !== undefined
    )
  }

  /** Ignore obsolete 401s; sign out when the current token is rejected. */
  public async invalidateToken(endpoint: string, token: string): Promise<void> {
    const session = this.sessionsByToken.get(this.tokenKey(endpoint, token))
    if (session === undefined || session.credential?.accessToken !== token) {
      return
    }
    // A request using the previous pair can finish while rotation is in flight.
    if (session.refreshing !== undefined) {
      try {
        await session.refreshing
      } catch {
        // The renewal path reports its own failure and preserves its classification.
        return
      }
      if (session.credential?.accessToken !== token) {
        return
      }
    }
    if (await this.recoverRejectedToken(session, token)) {
      return
    }
    const retired = await this.requireSignIn(session)
    if (retired !== null) {
      void this.revokeUnusedToken({
        endpoint: retired.endpoint,
        apiType: retired.apiType,
        token: retired.token,
        hasRefreshToken:
          session.signedOutCredential?.refreshToken !== undefined,
      })
    }
  }

  /**
   * Keep a session whose current token was rejected if it can still be
   * used: another app window may have rotated the pair (which revokes the
   * old access token on some providers), and a rotating pair is renewed once
   * before giving up on it.
   */
  private async recoverRejectedToken(
    session: ICredentialSession,
    token: string
  ): Promise<boolean> {
    const credential = session.credential
    if (credential === null) {
      return false
    }
    // A recovered token is never renewed again, but the window whose renewal
    // revoked it may still be saving the new pair.
    const adopted =
      session.recoveredToken === token && credential.refreshToken !== undefined
        ? await this.adoptConcurrentRenewal(session, credential)
        : await this.adoptStoredCredential(session, credential)
    if (adopted !== null) {
      // Windows must not keep handing each other replacements forever.
      session.recoveredToken = adopted.accessToken
      return true
    }
    if (session.credential !== credential) {
      return true
    }
    // A renewal started meanwhile will replace the token.
    if (session.refreshing !== undefined) {
      return true
    }
    if (
      credential.refreshToken === undefined ||
      session.recoveredToken === token
    ) {
      return false
    }
    const failed = session.failedRecovery
    if (
      failed?.token === token &&
      failed.at + recoveryRetryInterval > this.now()
    ) {
      return true
    }
    session.failedRecovery = { token, at: this.now() }
    const renewing = this.rotate(session, credential)
    session.refreshing = renewing
    try {
      session.recoveredToken = await renewing
    } catch {
      // Renewal signs out when the pair is rejected, and keeps it otherwise.
    } finally {
      if (session.refreshing === renewing) {
        session.refreshing = undefined
      }
    }
    return true
  }

  /**
   * Revoke an unused credential, even if account lookup has not completed.
   *
   * Cleanup is bounded and failures are logged. Callers need not await it, but
   * must only pass credentials that have not been installed for an account.
   */
  public async revokeUnusedToken(account: RevocableToken): Promise<void> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error('OAuth revocation timed out.'))
      }, revocationTimeout)
    })
    try {
      const revoked = await Promise.race([
        this.revokeToken(account, controller.signal),
        deadline,
      ])
      if (!revoked) {
        log.warn('Unable to revoke unused OAuth credentials.')
      }
    } catch {
      log.warn('Unable to revoke unused OAuth credentials.')
    } finally {
      clearTimeout(timeout)
    }
  }

  private tokenKey(endpoint: string, token: string) {
    return `${endpoint}\0${token}`
  }

  /** Identifies an account: several logins can share an endpoint. */
  private signInKey({ endpoint, login }: SignIn) {
    return `${endpoint}\0${login}`
  }

  private getSession(account: SignIn) {
    return this.sessionsBySignIn.get(this.signInKey(account))
  }

  private async write(
    endpoint: string,
    action: () => Promise<void>
  ): Promise<void> {
    const previous = this.credentialWriteQueues.get(endpoint)
    const next = (previous ?? Promise.resolve()).then(action)
    // The caller receives the error; the queue must remain usable for sign-out.
    const settled = next.catch(() => {})
    this.credentialWriteQueues.set(endpoint, settled)
    try {
      await next
    } finally {
      if (this.credentialWriteQueues.get(endpoint) === settled) {
        this.credentialWriteQueues.delete(endpoint)
      }
    }
  }

  private requireSignIn(session: ICredentialSession): Promise<Account | null> {
    if (this.getSession(session.account) !== session) {
      return Promise.resolve(null)
    }
    session.signedOutCredential = session.credential
    return this.delegate.requireSignIn(session.account)
  }

  /**
   * Another app window may have rotated the pair this session holds, or
   * removed the account if the stored credential is gone.
   */
  private async adoptStoredCredential(
    session: ICredentialSession,
    current: AccountCredential
  ): Promise<IOAuthToken | null> {
    const { account } = session
    let stored: AccountCredential
    try {
      stored = deserializeAccountCredential(
        await this.secureStore.getItem(getKeyForAccount(account), account.login)
      )
    } catch {
      return null
    }
    if (session.retired || session.credential !== current) {
      return null
    }
    if (stored === null) {
      if (current !== null && session.isStored) {
        this.retireRemovedSession(session)
      }
      return null
    }
    if (stored.accessToken === current?.accessToken) {
      return null
    }
    session.credential = stored
    session.isStored = true
    this.sessionsByToken.set(
      this.tokenKey(account.endpoint, stored.accessToken),
      session
    )
    this.delegate.onTokenRenewed(
      account.endpoint,
      stored.accessToken,
      account.login
    )
    log.info('Adopted OAuth credentials saved by another window.')
    return stored
  }

  /**
   * Another app window's concurrent renewal can be saved shortly after the
   * provider rejected this window's refresh token.
   */
  private async adoptConcurrentRenewal(
    session: ICredentialSession,
    current: IOAuthToken
  ): Promise<IOAuthToken | null> {
    const delays = this.timing.rereadDelays
    for (let attempt = 0; ; attempt++) {
      await this.adoptStoredCredential(session, current)
      if (
        session.retired ||
        session.credential !== current ||
        attempt >= delays.length
      ) {
        break
      }
      await this.timing.wait(delays[attempt])
    }
    return session.credential === current ? null : session.credential
  }

  private retireRemovedSession(session: ICredentialSession) {
    if (this.getSession(session.account) !== session) {
      return
    }
    log.info('Removing an account that was removed in another window.')
    this.delegate.onRemovedElsewhere?.(session.account)
    this.retireSession(session.account)
  }

  /**
   * Another app window may have saved a new credential since this account was
   * signed out. Removing an account on purpose always deletes it.
   */
  private async hasNewerStoredCredential(account: Account): Promise<boolean> {
    const signedOut = this.sessionsByAccount.get(account)?.signedOutCredential
    if (signedOut === undefined) {
      return false
    }
    let value: string | null
    try {
      value = await this.secureStore.getItem(
        getKeyForAccount(account),
        account.login
      )
    } catch {
      // Unknown contents: leaving them is safer than deleting a newer sign-in.
      return true
    }
    let stored: AccountCredential
    try {
      stored = deserializeAccountCredential(value)
    } catch {
      return false
    }
    if (stored !== null && stored.accessToken !== signedOut?.accessToken) {
      log.info('Keeping OAuth credentials saved by another window.')
      return true
    }
    return false
  }

  private async validToken(
    session: ICredentialSession,
    minimumValidity = refreshMargin,
    holder?: string
  ): Promise<string> {
    if (session.retired) {
      throw new AccountRequiresSignInError()
    }
    const credential = session.credential
    if (credential === null) {
      await this.requireSignIn(session)
      throw new AccountRequiresSignInError()
    }
    // Rotation invalidates the old pair even if this caller needs less validity.
    if (session.refreshing !== undefined) {
      return session.refreshing
    }
    if (
      credential.refreshToken === undefined ||
      (credential.expiresAt !== undefined &&
        credential.expiresAt >
          this.now() + minimumValidity + this.timing.renewalJitter)
    ) {
      return credential.accessToken
    }
    const holders = this.leaseHolders(session, credential)
    // Renewing would revoke the token this holder is still using.
    if (holder !== undefined && holders.includes(holder)) {
      return credential.accessToken
    }
    if (holders.length > 0) {
      await this.waitForLeaseRelease(session, credential)
      return this.validToken(session, minimumValidity, holder)
    }
    const refreshing = this.rotate(session, credential)
    session.refreshing = refreshing
    try {
      return await refreshing
    } finally {
      session.refreshing = undefined
    }
  }

  /** Holders of the credential's token, unless it is about to expire anyway. */
  private leaseHolders(
    session: ICredentialSession,
    credential: IOAuthToken
  ): ReadonlyArray<string> {
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt <= this.now() + leasedRenewalMargin
    ) {
      return []
    }
    return [...session.leases]
      .filter(l => l.token === credential.accessToken)
      .map(l => l.holder)
  }

  private revokeUnusedRenewal(account: Account, renewed: IOAuthToken) {
    void this.revokeUnusedToken({
      endpoint: account.endpoint,
      apiType: account.apiType,
      token: renewed.accessToken,
      hasRefreshToken: true,
    })
  }

  private needsRenewal(credential: IOAuthToken) {
    return (
      credential.refreshToken !== undefined &&
      (credential.expiresAt === undefined ||
        credential.expiresAt <=
          this.now() + refreshMargin + this.timing.renewalJitter)
    )
  }

  private async rotate(
    session: ICredentialSession,
    credential: IOAuthToken
  ): Promise<string> {
    const { account } = session
    // Another app window may have renewed the pair since this one read it.
    await this.adoptStoredCredential(session, credential)
    const current = session.credential
    if (session.retired || current === null) {
      throw new AccountRequiresSignInError()
    }
    if (current !== credential) {
      return this.needsRenewal(current)
        ? this.rotate(session, current)
        : current.accessToken
    }
    const refreshToken = credential.refreshToken
    if (refreshToken === undefined) {
      throw new Error('Cannot renew a credential without a refresh token.')
    }
    let renewed: IOAuthToken
    try {
      renewed = await this.renewToken(
        getHTMLURL(account.endpoint),
        refreshToken,
        account
      )
    } catch (e) {
      if (!session.retired) {
        if (
          e instanceof OAuthRefreshRejectedError ||
          e instanceof OAuthTokenResponseError
        ) {
          const concurrent = await this.adoptConcurrentRenewal(
            session,
            credential
          )
          if (concurrent !== null) {
            return concurrent.accessToken
          }
          await this.requireSignIn(session)
        } else {
          log.warn(
            'OAuth renewal failed; retaining credentials for a later retry.'
          )
          throw new Error(
            'Unable to renew your session. Check your connection and try again shortly.'
          )
        }
      }
      throw e
    }

    if (session.retired) {
      this.revokeUnusedRenewal(account, renewed)
      throw new AccountRequiresSignInError()
    }
    try {
      await this.write(this.signInKey(account), async () => {
        if (session.retired) {
          throw new AccountRequiresSignInError()
        }
        await this.secureStore.setItem(
          getKeyForAccount(account),
          account.login,
          serializeAccountCredential(renewed)
        )
      })
    } catch {
      if (!session.retired) {
        await this.requireSignIn(session)
      }
      this.revokeUnusedRenewal(account, renewed)
      throw new Error(
        'Unable to save renewed credentials. Please sign in again.'
      )
    }
    if (session.retired) {
      this.revokeUnusedRenewal(account, renewed)
      throw new AccountRequiresSignInError()
    }
    session.credential = renewed
    session.isStored = true
    this.sessionsByToken.set(
      this.tokenKey(account.endpoint, renewed.accessToken),
      session
    )
    this.delegate.onTokenRenewed(
      account.endpoint,
      renewed.accessToken,
      account.login
    )
    log.info('OAuth credentials renewed and saved.')
    return renewed.accessToken
  }
}
