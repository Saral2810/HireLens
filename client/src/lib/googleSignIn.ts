// Google's own sign-in button (Google Identity Services). Google hands this page an ID token, and the
// server signs in with it, so the candidate never sees the Supabase project address.

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: Record<string, unknown>): void;
          renderButton(el: HTMLElement, options: Record<string, unknown>): void;
        };
      };
    };
  }
}

const SCRIPT_URL = 'https://accounts.google.com/gsi/client';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { loading = null; reject(new Error('Google sign-in could not load. Check your connection, or use the email code.')); };
    document.head.appendChild(script);
  });
  return loading;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A random nonce: Google gets its SHA-256 (hex), the server gets the raw value, so a token cannot be replayed. */
async function makeNonce(): Promise<{ raw: string; hashed: string }> {
  const raw = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return { raw, hashed: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') };
}

/**
 * Shows Google's sign-in button in `el`. onCredential gets the ID token and the raw nonce.
 */
export async function renderGoogleButton(el: HTMLElement, clientId: string, onCredential: (credential: string, nonce: string) => void): Promise<void> {
  await loadScript();
  const nonce = await makeNonce();
  window.google!.accounts.id.initialize({
    client_id: clientId,
    nonce: nonce.hashed,
    ux_mode: 'popup',
    use_fedcm_for_prompt: true,
    callback: (response: { credential?: string }) => { if (response.credential) onCredential(response.credential, nonce.raw); }
  });
  el.replaceChildren();
  window.google!.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: Math.min(360, el.clientWidth || 320) });
}
