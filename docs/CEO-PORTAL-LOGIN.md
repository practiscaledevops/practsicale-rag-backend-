# CEO Portal direct sign-in

AI Brain RAG uses the CEO Portal's existing one-use launch protocol with PKCE
and browser state. Configure these server-only variables in Vercel Production:

- `CEO_PORTAL_ORIGIN=https://ceo.practicescalingsystems.com`
- `AI_BRAIN_RAG_ORIGIN=https://practsicale-rag-backend-gules.vercel.app`
- `CEO_PORTAL_APP_ID` is the AI Brain RAG catalogue UUID.
- `CEO_PORTAL_TARGET_USER_ID` is the approved existing RAG Auth account UUID.
- `CEO_PORTAL_TARGET_ORG_ID` is that account's active organization UUID.
- `CEO_PORTAL_CLIENT_SECRET` is a new RAG-only connection secret.
- `PORTAL_LOGIN_ENABLED=true` activates the receiver.

Store the matching `<app-uuid>:<secret>` in the CEO Portal's server-only
`APP_LOGIN_ADDITIONAL_CLIENT_SECRETS_AI_BRAIN_RAG` variable. Deploy both apps,
register the exact RAG origin in the CEO catalogue, then link the approved
CEO identity to the configured account.

The callback checks an active admin membership in the configured organization,
using the same earliest-active-membership selection as the native dashboard.
It checks membership again before committing cookies. Existing roles and
permissions continue to be read by the dashboard. Accounts with enrolled MFA
use native sign-in. Foreign browser sessions and unverified account lookups
refuse the bridge. Demo mode disables the receiver.

Run `npm test -- test/portal-login.test.ts`, typecheck, lint and build, then
verify a real launch from CEO Portal with a fresh destination session.
Disable the catalogue connection or `PORTAL_LOGIN_ENABLED` to turn off the bridge.
