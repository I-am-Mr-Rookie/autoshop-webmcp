import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const context = new AsyncLocalStorage();
export const shopSchema = userId => {
  if (typeof userId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(userId)) throw new Error('Invalid verified Clerk user.');
  return `shop_${createHash('sha256').update(userId).digest('hex').slice(0, 48)}`;
};
export const currentShop = () => context.getStore();
export const withShop = (identity, run) => context.run({ ...identity, schema: shopSchema(identity.userId) }, run);
