import { createGoogleOAuth } from './google-oauth.mjs';
import { developerSessionCookie } from './independent-api.mjs';

export function createGoogleSignIn({accounts, ...options}) {
  return createGoogleOAuth({...options, login: identity => accounts.loginWithGoogle(identity),
    sessionCookie:developerSessionCookie, successPath:'/#platforms', errorPath:'/#account?google='});
}
