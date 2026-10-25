import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// Node 22.18+ loads TypeScript directly (type stripping), so the real client helper is tested.
import { consumeInviteFragment } from '../../client/src/lib/inviteSession.ts';

let replaced;
function fakeWindow(hash) {
  replaced = null;
  globalThis.window = {
    location: { hash, pathname: '/invite', search: '' },
    history: { replaceState: (_s, _t, url) => { replaced = url; } }
  };
}

beforeEach(() => delete globalThis.window);

test('reads the session token from an invite link and clears the address bar', () => {
  fakeWindow('#access_token=abc.def&refresh_token=r1&expires_in=3600&type=magiclink');
  assert.deepEqual(consumeInviteFragment(), { kind: 'session', accessToken: 'abc.def' });
  assert.equal(replaced, '/invite');
});

test('turns a used or expired link into a friendly message', () => {
  fakeWindow('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  const result = consumeInviteFragment();
  assert.equal(result.kind, 'error');
  assert.match(result.message, /already been used or has expired/);
  assert.equal(replaced, '/invite');
});

test('ignores ordinary pages and unrelated fragments', () => {
  fakeWindow('');
  assert.deepEqual(consumeInviteFragment(), { kind: 'none' });
  fakeWindow('#section-2');
  assert.deepEqual(consumeInviteFragment(), { kind: 'none' });
  assert.equal(replaced, null);
});
