/**
 * Resolve a usable Kiro bearer token from the credentials Kiro itself stores.
 *
 * Kiro's IDE sign-in writes `~/.aws/sso/cache/kiro-auth-token.json` (the
 * access and refresh tokens) plus a sibling `<clientIdHash>.json` (the OIDC
 * device-registration client id and secret). The two files are one credential:
 * refreshing requires the client pair that issued the refresh token, so a
 * token file naming a registration that is absent cannot be refreshed.
 *
 * Refreshed access tokens are cached in memory only. Kiro owns those files and
 * writes them from its own sign-in and refresh; writing back would race a
 * process this adapter does not coordinate with, and the refresh endpoint
 * returns the same refresh token rather than rotating it, so a fresh access
 * token is derivable at any time.
 *
 * @module dsh-llm-kiro/auth
 */
/** One usable bearer token and the region whose endpoint accepts it. */
export interface KiroToken {
    /** Bearer value for the `authorization` header. */
    accessToken: string;
    /** Region selecting the `q.<region>.amazonaws.com` endpoint. */
    region: string;
    /** Epoch milliseconds after which this token stops being accepted. */
    expiresAt: number;
}
/** Everything {@link resolveToken} needs, so tests can supply files and clock. */
export interface TokenSourceOptions {
    /** Directory holding the token and registration files; defaults to the user's SSO cache. */
    cacheDir?: string;
    /** Refresh this many milliseconds before actual expiry. */
    expiryBufferMs: number;
    /** HTTP transport for the refresh call, so a configured proxy applies to it too. */
    fetchJson: (url: string, body: unknown) => Promise<{
        status: number;
        body: unknown;
    }>;
}
/** Discard the cached access token; tests and credential rotation start clean. */
export declare function clearTokenCache(): void;
/**
 * Resolve a bearer token that is valid now.
 *
 * The in-memory token is preferred, then the token Kiro has on disk, and only
 * a request that finds neither usable spends an OIDC refresh — so a session
 * running beside the Kiro IDE normally reuses the IDE's own fresh token.
 * @param options - file location, expiry buffer, and refresh transport.
 * @returns a token whose remaining lifetime exceeds the configured buffer.
 * @throws `LlmError` with `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, or `AUTH`.
 */
export declare function resolveToken(options: TokenSourceOptions): Promise<KiroToken>;
