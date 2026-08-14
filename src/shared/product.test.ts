import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from './product';

describe('product metadata', () => {
  it('uses the stable desktop product name', () => {
    expect(PRODUCT_NAME).toBe('AI Terminal');
  });
});
