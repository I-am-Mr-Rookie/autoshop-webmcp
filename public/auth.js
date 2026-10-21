let clerk;
const nativeFetch = (...args) => globalThis.fetch(...args);

export const authenticatedFetch = async (url, options = {}) => {
  if (!clerk) return nativeFetch(url, options); // Unit-test/non-browser callers still use the injected transport.
  const token = await clerk.session?.getToken();
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return nativeFetch(url, { ...options, headers });
};

const loadScript = (src, key) => new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.crossOrigin = 'anonymous';
  if (key) script.dataset.clerkPublishableKey = key;
  script.onload = resolve;
  script.onerror = () => reject(new Error('Sign-in script failed to load.'));
  document.head.appendChild(script);
});

export const signOut = () => clerk?.signOut({ redirectUrl: '/' });

// Google always returns through /sso-callback, then to the portal that started sign-in.
export const googleRedirectOptions = (origin, pathname) => ({
  strategy: 'oauth_google', redirectUrl: `${origin}/sso-callback`, redirectUrlComplete: `${origin}${pathname === '/buyer' ? '/buyer' : '/seller'}`
});

export const accountLabel = user => user.primaryEmailAddress?.emailAddress || user.fullName || 'your account';

// Prebuilt sign-in (D3 Path A), themed from the page's live :root brand tokens. Google stays on the page's own button.
const tokenVariables = { colorPrimary: '--agent', colorForeground: '--ink', colorInputForeground: '--ink', colorMutedForeground: '--muted',
  colorDanger: '--alert', colorBackground: '--surface', colorInput: '--surface', colorBorder: '--line-strong', borderRadius: '--radius', fontFamily: '--sans' };
export const appearanceFromTokens = read => ({
  variables: Object.fromEntries(Object.entries(tokenVariables).map(([key, name]) => [key, String(read(name) ?? '').trim()]).filter(([, value]) => value)),
  elements: { rootBox: { width: '100%' }, cardBox: { width: '100%' }, socialButtonsRoot: { display: 'none' }, dividerRow: { display: 'none' } }
});

// One email-code form signs in existing accounts and signs up new ones, then returns to the same portal.
export const emailSignInOptions = pathname => {
  const target = pathname === '/buyer' ? '/buyer' : '/seller';
  return { routing: 'hash', withSignUp: true, forceRedirectUrl: target, signUpForceRedirectUrl: target };
};

export const mountEmailSignIn = (instance, node, pathname) => pathname === '/sign-up'
  ? instance.mountSignUp(node, emailSignInOptions(pathname))
  : instance.mountSignIn(node, emailSignInOptions(pathname));

export const ensureSession = async () => {
  const gate = document.querySelector('#auth-gate');
  const status = document.querySelector('#auth-status');
  const button = document.querySelector('#google-sign-in');
  try {
    const response = await nativeFetch('/api/config');
    const config = await response.json();
    if (!response.ok || !config.ok) throw new Error('Sign-in is not configured.');
    const base = `https://${config.domain}/npm`;
    await Promise.all([
      loadScript(`${base}/@clerk/ui@1/dist/ui.browser.js`),
      loadScript(`${base}/@clerk/clerk-js@6.39.1/dist/clerk.browser.js`, config.publishableKey)
    ]);
    clerk = window.Clerk;
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance: appearanceFromTokens(name => getComputedStyle(document.documentElement).getPropertyValue(name)), signInUrl: '/sign-in', signUpUrl: '/sign-up', telemetry: false });
    if (location.pathname === '/sso-callback') {
      status.textContent = 'Finishing sign-in…';
      await clerk.handleRedirectCallback({ signInUrl: '/sign-in', signUpUrl: '/sign-up', signInFallbackRedirectUrl: '/seller', signUpFallbackRedirectUrl: '/seller' });
      return false;
    }
    if (!clerk.user) {
      status.textContent = 'Sign in with Google or your email. Each account gets its own products, cart, orders, and approvals.';
      mountEmailSignIn(clerk, document.querySelector('#clerk-auth-component'), location.pathname);
      button.disabled = false;
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = 'Opening Google…';
        try {
          await clerk.client.signIn.authenticateWithRedirect(googleRedirectOptions(location.origin, location.pathname));
        } catch {
          status.textContent = 'Google sign-in did not complete. Please retry.';
          button.disabled = false;
        }
      });
      return false;
    }
    if (['/sign-in', '/sign-up'].includes(location.pathname)) { location.replace('/seller'); return false; }
    gate.hidden = true;
    document.body.classList.remove('auth-pending');
    const account = document.querySelector('#demo-account');
    account.hidden = false;
    document.querySelector('#account-label').textContent = accountLabel(clerk.user);
    document.querySelector('#demo-sign-out').addEventListener('click', signOut);
    const initialUser = clerk.user.id;
    clerk.addListener(({ user, session }) => {
      if (!session || user?.id !== initialUser) {
        document.dispatchEvent(new Event('autoshop:seller-session-lost'));
        location.reload(); // Clear buyer tools, cart consent, and UI before another account can use them.
      }
    });
    return true;
  } catch {
    status.textContent = 'Sign-in could not load. Refresh to retry.'; // Never surface library or provider error text.
    button.disabled = true;
    return false;
  }
};
