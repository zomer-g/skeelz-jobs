# "Continue with Microsoft" (candidates)

Candidates can sign in with a personal Microsoft account (outlook.com, hotmail.com, live.com …) or a work/school
account. **Staff never sign in this way.** They use "Continue with Google" (xhostd SSO) only. A staff email that
comes back from Microsoft is refused and never linked.

It is **off** until the owner registers an app in Microsoft Entra and sets the values below.

## Why not through xhostd
xhostd's built-in sign-in (`/xhost-auth/login`) supports Google only. Its docs say: "xhostd's built-in dance is
Google only", and for other providers you "run your own login" (docs.xhostd.com, *Sign in with Google*). So the
site runs its own OpenID Connect client against the Microsoft identity platform.

## What the owner does in Entra (once)
Do this at https://entra.microsoft.com, in the tenant that already holds your other two app registrations. Create a
**new** registration; don't reuse the others, so this app has its own secret and its own permissions.

1. **App registrations → New registration**
   - Name: `SKEELZ Jobs` (candidates see this name on Microsoft's consent screen).
   - Supported account types: **"Accounts in any organizational directory (Any Microsoft Entra ID tenant –
     Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)"**. This option must be chosen at
     registration so that personal accounts work.
   - Redirect URI: platform **Web**, value exactly
     `https://<prod-app>.xhostd.app/api/auth/microsoft/callback`
     If you later add a custom domain, add `https://<that domain>/api/auth/microsoft/callback` in
     **Authentication → Web → Redirect URIs** as well.
2. **Authentication**: leave "Access tokens" and "ID tokens" (implicit / hybrid flows) **unchecked**. The site uses the
   authorization-code flow with PKCE. Front-channel logout URL: leave it empty.
3. **Certificates & secrets → Client secrets → New client secret**
   - Expiry: **12 months** is recommended (the maximum is 24). Put a reminder about a month before it expires, then
     create a new secret, set it (below) and delete the old one. While the secret is expired, Microsoft sign-in
     fails ("sign-in failed"); Google and the other options keep working.
   - Copy the secret's **Value** (not the "Secret ID"). It is shown only once.
4. **API permissions**: Microsoft Graph, *Delegated*: `openid`, `email`, `profile`. `User.Read` is added by default and
   can be removed, because the site never calls Graph. None of these need admin consent.
5. **Token configuration → Add optional claim → Token type: ID** → tick **`email`** and **`xms_edov`** → Add. If the
   portal asks, also tick "Turn on the Microsoft Graph email permission".
   If `xms_edov` isn't in the list, add it in **Manifest**: under `optionalClaims.idToken`, add
   `{ "name": "xms_edov", "source": null, "essential": false, "additionalProperties": [] }`.
   Without `xms_edov`, **work/school accounts are refused**. Personal accounts still work.
6. **Branding & properties → Publisher verification** (needs a Microsoft AI Cloud Partner Program ID). Entra warns on a
   new multitenant app: "End users cannot grant consent to newly registered multitenant apps without verified
   publishers". Until the publisher is verified, **work/school accounts from other organizations can't sign in**
   unless their own admin approves the app. Personal Microsoft accounts aren't affected.
7. From **Overview**, copy the **Application (client) ID**.

## What to set on xhostd (app `skeelz-jobs`)
| Name | How | Value |
|---|---|---|
| `MS_CLIENT_ID` | `set_env` | the Application (client) ID |
| `MS_CLIENT_SECRET` | `set_secret` | the client secret **Value** |
| `ENABLE_MICROSOFT_SSO` | `set_env` | `true` (anything else = off, and the button is hidden) |
| `MS_REDIRECT_URI` | `set_env`, optional | pins the redirect URI. Without it, the URI is built from the host of the request, which works on the platform host and on any custom domain registered in step 1 |

Never set `MS_LOGIN_BASE` on prod. It points the server at a local mock and is ignored unless `DEV_MODE=true`.
The privacy texts (`/privacy` and `docs/privacy/*.md`) already name Microsoft as a sign-in option. Deploy them and turn
the option on in the same release, so the texts and the site match.

## How it works (for reviewers)
- `/api/auth/microsoft/start`: random state, nonce and PKCE verifier, and the redirect URI, all go into a signed,
  httpOnly cookie that lasts 10 minutes (`oidc_microsoft`, path `/api/auth`, SameSite=Lax). The server then redirects
  to `login.microsoftonline.com/common/oauth2/v2.0/authorize` with `response_type=code`, `scope=openid email profile`,
  `code_challenge_method=S256` and `prompt=select_account`.
- `/api/auth/microsoft/callback`: checks the state against the cookie. Then it exchanges the code server to server
  (client secret + verifier) and checks the ID token (`security/microsoft.ts`):
  - RS256 only, with a key from Microsoft's JWKS (`common/discovery/v2.0/keys`);
  - issuer `https://login.microsoftonline.com/<tid>/v2.0` for the token's own tenant. The `tid` only picks which issuer
    is required; a forged tid fails the signature or the issuer check;
  - `aud` = our client id, expiry (30 s tolerance), and the nonce from our cookie.

  The access token is discarded.
- **Which email is trusted.** Microsoft warns against using the `email` claim for authorization unless it is
  verified. So the rule is:
  - Personal accounts (tid `9188040d-6c67-4c5b-b112-36a304b66dad`): the `email` claim. Microsoft accounts confirm
    their address when they are created.
  - Work/school accounts: the `email` claim **only** when the token says `xms_edov: true`, meaning the owner of the
    email's domain has been verified (step 5). Otherwise the sign-in is refused with "this Microsoft account did not
    give a verified email address".
  - `preferred_username` / `upn` are never used. An admin of any tenant can set them to any address, which is the
    "nOAuth" account-takeover pattern.
- Mapping (same as Google, candidates only): the stored key (`users.ms_sub` = `<tid>:<sub>`) → that candidate.
  Otherwise, a candidate with the same verified email is linked (`auth.sso_linked`; a password left from before 11.2026 is cleared and old
  sessions are closed, and the candidate is told on screen). A staff email is **refused**. Anyone else gets the same
  sign-up form as Google, and nothing is created until it is sent.
- The session carries `via: 'microsoft'`, and `methodAllowedForRole` never accepts it for a staff role.
- Signing out of the site doesn't sign the visitor out of Microsoft, but `prompt=select_account` means the next
  person at a shared computer has to pick an account; they aren't signed straight back in.
- Activity log: `auth.login` (`method: microsoft`), `auth.sso_linked` / `auth.sso_password_cleared` / `auth.signup_sso`
  (`provider: microsoft`), `auth.oauth_failed` (`provider: microsoft`, reason code; never tokens or emails).

## Tests
- `cd server && npx tsc && npm test`: `test/microsoft.test.mjs` covers the config, the ID-token checks and the email rule.
- `BASE=http://localhost:3100 node test/e2e-microsoft-sso.mjs`: the whole flow against the mock provider (24 checks).
  The local server needs `ENABLE_MICROSOFT_SSO=true MS_CLIENT_ID=e2e-ms-client MS_CLIENT_SECRET=e2e-ms-secret
  MS_LOGIN_BASE=http://127.0.0.1:3199` (in `server/.env.example`) and `DEV_MODE=true`. Restart the server before
  running another sign-in suite: they share the per-IP sign-in rate limit.
