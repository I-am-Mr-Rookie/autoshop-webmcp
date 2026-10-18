import { createClerkClient } from '@clerk/backend';

export const clerkPublicConfig = () => {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!/^pk_(test|live)_[A-Za-z0-9_-]+$/.test(publishableKey ?? '')) return null;
  const domain = Buffer.from(publishableKey.split('_')[2], 'base64url').toString().replace(/\$$/, '');
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  return { publishableKey, domain };
};

export const authenticateGoogleSession = async request => {
  const config = clerkPublicConfig();
  if (!config || !process.env.CLERK_SECRET_KEY) throw new Error('Clerk is not configured.');
  // Only session tokens for this application and origin; never trust a client-supplied shop ID.
  const state = await createClerkClient({ publishableKey: config.publishableKey, secretKey: process.env.CLERK_SECRET_KEY })
    .authenticateRequest(request, { authorizedParties: [new URL(request.url).origin], acceptsToken: 'session_token' });
  if (!state.isAuthenticated) return null;
  const auth = state.toAuth();
  return auth?.userId && auth?.sessionId ? { userId: auth.userId, sessionId: auth.sessionId } : null;
};
