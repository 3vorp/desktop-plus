import { Account } from '../models/account'
import {
  BitbucketCloudAPIEndpoint,
  BitbucketCloudURL,
  CodebergCloudAPIEndpoint,
  CodebergCloudURL,
  deleteToken,
  getThirdPartyOAuthApp,
  GiteaCloudAPIEndpoint,
  GiteaCloudURL,
  GitLabCloudAPIEndpoint,
  GitLabCloudURL,
  oauthRedirectUri,
} from './api'
import { RegisteredApiType } from './endpoint-api-type-registry'
import { assertNever } from './fatal-error'
import { getAbsoluteUrl, getUserAgent } from './http'
import { isRecord } from './is-record'
import {
  IOAuthToken,
  OAuthRefreshRejectedError,
  OAuthTokenResponseError,
  parseOAuthToken,
  refreshOAuthToken,
} from './oauth-token'

const requestTimeout = 30_000

interface IThirdPartyOAuthProvider {
  readonly cloudEndpoint: string
  readonly tokenURL: string
  readonly formEncoded: boolean
  readonly sendsRedirectUri: boolean
  /** Error codes (HTTP 400) meaning the refresh token can never be used again. */
  readonly rejectionErrors: ReadonlyArray<string>
  /**
   * Bitbucket refresh tokens were reusable before it started rotating them,
   * so a refresh response without one must not sign the user out.
   */
  readonly mayKeepRefreshToken: boolean
}

function getProvider(apiType: RegisteredApiType): IThirdPartyOAuthProvider {
  switch (apiType) {
    case 'bitbucket':
      return {
        cloudEndpoint: BitbucketCloudAPIEndpoint,
        tokenURL: getAbsoluteUrl(BitbucketCloudURL, 'site/oauth2/access_token'),
        formEncoded: true,
        sendsRedirectUri: false,
        rejectionErrors: ['invalid_grant', 'invalid_request'],
        mayKeepRefreshToken: true,
      }
    case 'gitlab':
      return {
        cloudEndpoint: GitLabCloudAPIEndpoint,
        tokenURL: getAbsoluteUrl(GitLabCloudURL, 'oauth/token'),
        formEncoded: false,
        sendsRedirectUri: true,
        rejectionErrors: ['invalid_grant'],
        mayKeepRefreshToken: false,
      }
    case 'forgejo':
      return {
        cloudEndpoint: CodebergCloudAPIEndpoint,
        tokenURL: getAbsoluteUrl(CodebergCloudURL, 'login/oauth/access_token'),
        formEncoded: false,
        sendsRedirectUri: true,
        rejectionErrors: ['invalid_grant', 'unauthorized_client'],
        mayKeepRefreshToken: false,
      }
    case 'gitea':
      return {
        cloudEndpoint: GiteaCloudAPIEndpoint,
        tokenURL: getAbsoluteUrl(GiteaCloudURL, 'login/oauth/access_token'),
        formEncoded: false,
        sendsRedirectUri: true,
        rejectionErrors: ['invalid_grant', 'unauthorized_client'],
        mayKeepRefreshToken: false,
      }
    default:
      return assertNever(apiType, `Unknown API type ${apiType}`)
  }
}

/** Self-hosted instances use personal access tokens, not our OAuth apps. */
export function isThirdPartyOAuthAccount(
  account: Pick<Account, 'apiType' | 'endpoint'>
): boolean {
  const { apiType, endpoint } = account
  return (
    apiType !== 'dotcom' &&
    apiType !== 'enterprise' &&
    getProvider(apiType).cloudEndpoint === endpoint
  )
}

/** `htmlEndpoint` is only used for GitHub and GitHub Enterprise. */
export function renewAccountToken(
  htmlEndpoint: string,
  refreshToken: string,
  account: Pick<Account, 'apiType' | 'endpoint'>
): Promise<IOAuthToken> {
  const { apiType } = account
  if (apiType === 'dotcom' || apiType === 'enterprise') {
    return refreshOAuthToken(htmlEndpoint, refreshToken)
  }
  return refreshThirdPartyOAuthToken(apiType, account.endpoint, refreshToken)
}

async function refreshThirdPartyOAuthToken(
  apiType: RegisteredApiType,
  endpoint: string,
  refreshToken: string
): Promise<IOAuthToken> {
  const provider = getProvider(apiType)
  // Our client credentials belong to the cloud host and must not be sent elsewhere.
  if (provider.cloudEndpoint !== endpoint) {
    throw new OAuthRefreshRejectedError()
  }
  const token = await requestThirdPartyOAuthToken(
    apiType,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    true
  )
  if (token.refreshToken !== undefined) {
    return token
  }
  if (provider.mayKeepRefreshToken) {
    return { ...token, refreshToken }
  }
  throw new OAuthTokenResponseError()
}

export function exchangeThirdPartyOAuthToken(
  apiType: RegisteredApiType,
  code: string,
  codeVerifier: string
): Promise<IOAuthToken> {
  return requestThirdPartyOAuthToken(
    apiType,
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      ...(getProvider(apiType).sendsRedirectUri
        ? { redirect_uri: oauthRedirectUri }
        : {}),
    },
    false
  )
}

/**
 * The shortest lifetime any of these providers uses. Without a lifetime,
 * every use would renew the token again.
 */
const defaultLifetimeSeconds = 3600
/** Lifetimes beyond this are treated as this, so expiry stays representable. */
const maxLifetimeSeconds = 365 * 24 * 60 * 60

/**
 * Providers changing fields we ignore (e.g. `token_type` casing, `scopes`
 * becoming an array) must never make a renewal unusable and sign everyone out.
 */
function usedTokenFields(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  const { access_token, refresh_token, expires_in } = value
  return {
    access_token,
    ...(refresh_token === undefined || refresh_token === null
      ? {}
      : { refresh_token }),
    expires_in:
      typeof expires_in === 'number' && expires_in >= 0
        ? Math.min(Math.floor(expires_in), maxLifetimeSeconds)
        : defaultLifetimeSeconds,
  }
}

/** Third-party counterpart of `requestOAuthToken`. */
async function requestThirdPartyOAuthToken(
  apiType: RegisteredApiType,
  parameters: Readonly<Record<string, string>>,
  refreshing: boolean
): Promise<IOAuthToken> {
  const provider = getProvider(apiType)
  const { clientId, clientSecret } = getThirdPartyOAuthApp(apiType)
  const controller = new AbortController()
  const issuedAt = Date.now()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error('The OAuth token request timed out.'))
    }, requestTimeout)
  })

  try {
    const request = async () => {
      const response = await fetch(provider.tokenURL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'User-Agent': getUserAgent(),
          ...(provider.formEncoded
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${Buffer.from(
                  `${clientId}:${clientSecret}`
                ).toString('base64')}`,
              }
            : { 'Content-Type': 'application/json' }),
        },
        body: provider.formEncoded
          ? new URLSearchParams(parameters).toString()
          : JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              ...parameters,
            }),
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      })

      let value: unknown
      try {
        value = await response.json()
      } catch {
        // E.g. a proxy's page, which must not sign the user out.
        throw new Error('The OAuth token request failed.')
      }

      if (response.status >= 500) {
        throw new Error('The OAuth token request failed.')
      }
      if (isRecord(value) && 'error' in value) {
        if (
          refreshing &&
          response.status === 400 &&
          typeof value.error === 'string' &&
          provider.rejectionErrors.includes(value.error)
        ) {
          throw new OAuthRefreshRejectedError()
        }
        throw new Error('The OAuth token request failed.')
      }

      if (!response.ok) {
        throw new Error('The OAuth token request failed.')
      }

      return parseOAuthToken(usedTokenFields(value), issuedAt)
    }

    return await Promise.race([request(), deadline])
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The OAuth token request timed out.')
    }
    if (
      error instanceof OAuthTokenResponseError ||
      error instanceof OAuthRefreshRejectedError
    ) {
      throw error
    }
    // Fetch and JSON errors can contain credentials, URLs, or response bodies.
    throw new Error('The OAuth token request failed.')
  } finally {
    clearTimeout(timeout)
  }
}

export type RevocableToken = Pick<Account, 'endpoint' | 'token' | 'apiType'>

export async function revokeAccountToken(
  account: RevocableToken,
  signal?: AbortSignal
): Promise<boolean> {
  switch (account.apiType) {
    case 'dotcom':
    case 'enterprise':
      return deleteToken(account, signal)
    case 'gitlab':
      return account.endpoint === GitLabCloudAPIEndpoint
        ? revokeGitLabToken(account.token, signal)
        : true
    // No per-token revocation.
    case 'bitbucket':
    case 'forgejo':
    case 'gitea':
      return true
    default:
      return assertNever(account.apiType, 'Unknown API type')
  }
}

async function revokeGitLabToken(
  token: string,
  signal?: AbortSignal
): Promise<boolean> {
  const { clientId, clientSecret } = getThirdPartyOAuthApp('gitlab')
  try {
    const response = await fetch(
      getAbsoluteUrl(GitLabCloudURL, 'oauth/revoke'),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getUserAgent(),
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          token,
        }).toString(),
        signal,
        redirect: 'error',
        cache: 'no-store',
      }
    )
    return response.ok
  } catch {
    log.error('revokeGitLabToken: failed')
    return false
  }
}
