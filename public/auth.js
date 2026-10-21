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
  script.onerror = () => reject(new Error('Google sign-in could not load. Please retry.'));
  document.head.appendChild(script);
});

export const signOutGoogle = () => clerk?.signOut({ redirectUrl: '/' });

// Prebuilt sign-in (D3 Path A), themed from the page's live :root brand tokens. Google stays on the page's own button.
const tokenVariables = { colorPrimary: '--agent', colorForeground: '--ink', colorInputForeground: '--ink', colorMutedForeground: '--muted',
  colorDanger: '--alert', colorBackground: '--surface', colorInput: '--surface', colorBorder: '--line-strong', borderRadius: '--radius', fontFamily: '--sans' };
export const appearanceFromTokens = read => ({
  variables: Object.fromEntries(Object.entries(tokenVariables).map(([key, name]) => [key, String(read(name) ?? '').trim()]).filter(([, value]) => value)),
  elements: { socialButtonsRoot: { display: 'none' }, dividerRow: { display: 'none' } }
});

// One email-code form signs in existing accounts and signs up new ones, then returns to the same portal.
export const emailSignInOptions = pathname => {
  const target = pathname === '/buyer' ? '/buyer' : '/seller';
  return { routing: 'hash', withSignUp: true, forceRedirectUrl: target, signUpForceRedirectUrl: target };
};

export const mountEmailSignIn = (instance, node, pathname) => pathname === '/sign-up'
  ? instance.mountSignUp(node, emailSignInOptions(pathname))
  : instance.mountSignIn(node, emailSignInOptions(pathname));

export const ensureGoogleSession = async () => {
  const gate = document.querySelector('#auth-gate');
  const status = document.querySelector('#auth-status');
  const button = document.querySelector('#google-sign-in');
  try {
    const response = await nativeFetch('/api/config');
    const config = await response.json();
    if (!response.ok || !config.ok) throw new Error('Google sign-in is not configured.');
    const base = `https://${config.domain}/npm`;
    await Promise.all([
      loadScript(`${base}/@clerk/ui@1/dist/ui.browser.js`),
      loadScript(`${base}/@clerk/clerk-js@6.39.1/dist/clerk.browser.js`, config.publishableKey)
    ]);
    clerk = window.Clerk;
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance: appearanceFromTokens(name => getComputedStyle(document.documentElement).getPropertyValue(name)), signInUrl: '/sign-in', signUpUrl: '/sign-up', telemetry: false });
    if (location.pathname === '/sso-callback') {
      status.textContent = 'Completing Google sign-in…';
      await clerk.handleRedirectCallback({ signInUrl: '/sign-in', signUpUrl: '/sign-up', signInFallbackRedirectUrl: '/seller', signUpFallbackRedirectUrl: '/seller' });
      return false;
    }
    if (!clerk.user) {
      status.textContent = 'Use Google or a one-time email code. Each account gets its own products, cart, orders, and approvals.';
      mountEmailSignIn(clerk, document.querySelector('#clerk-auth-component'), location.pathname);
      button.disabled = false;
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = 'Opening Google…';
        try {
          await clerk.client.signIn.authenticateWithRedirect({
            strategy: 'oauth_google', redirectUrl: `${location.origin}/sso-callback`,
            redirectUrlComplete: `${location.origin}${location.pathname === '/buyer' ? '/buyer' : '/seller'}`
          });
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
    document.querySelector('#demo-sign-out').addEventListener('click', signOutGoogle);
    const initialUser = clerk.user.id;
    clerk.addListener(({ user, session }) => {
      if (!session || user?.id !== initialUser) {
        document.dispatchEvent(new Event('autoshop:seller-session-lost'));
        location.reload(); // Clear buyer tools, cart consent, and UI before another account can use them.
      }
    });
    return true;
  } catch (error) {
    status.textContent = error.message;
    button.disabled = true;
    return false;
  }
};
