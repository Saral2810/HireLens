// Sign-in links (Google, email links, HR test links) go through Supabase Auth, which sends the browser back to the app with
// the session in the URL fragment: #access_token=...&refresh_token=...&type=magiclink
// (or #error=...&error_description=... when the link was already used or has expired).

export type InviteResult =
  | { kind: 'none' }
  | { kind: 'session'; accessToken: string }
  | { kind: 'error'; message: string };

/** Reads the invite result from the URL fragment, then removes it from the address bar. */
export function consumeInviteFragment(): InviteResult {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  if (!hash) return { kind: 'none' };
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const error = params.get('error_description') || params.get('error');
  if (!accessToken && !error) return { kind: 'none' };

  // Keep the token out of browser history and anything copied from the address bar.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  if (accessToken) return { kind: 'session', accessToken };
  const expired = /expired|invalid/i.test(error || '');
  return {
    kind: 'error',
    message: expired
      ? 'This sign-in link has already been used or has expired. Sign in again below.'
      : `Sign-in failed: ${error}`
  };
}
