export const createSeedRecords = () => ({
  products: [
    { id: 'cpu-1', name: 'Ryzen 5 7600', priceCents: 18900, stock: 10, version: 1 },
    { id: 'ram-1', name: '16GB DDR5 Kit', priceCents: 4900, stock: 12, version: 1 },
    { id: 'ssd-1', name: '1TB NVMe SSD', priceCents: 6900, stock: 8, version: 1 }
  ],
  buyerSessions: [],
  carts: [],
  orders: [],
  mandates: [{ id: 'default', maxItems: 5, maxTotalCents: 10000, maxDiscountPercent: 10, minRemainingStock: 2, state: 'active', version: 1 }],
  pendingActions: [],
  approvalTokens: [],
  receipts: [],
  sellerUsers: [{ id: 'seller-1', username: 'seller', status: 'active', version: 1 }]
});

export const resetDemoData = async repository => {
  const records = createSeedRecords();
  await repository.replace(records);
  return { ok: true, products: records.products.length, mandateVersion: 1, sellerUsers: records.sellerUsers.length };
};
