import { describe, expect, it } from 'vitest';
import { mergeProviderModelOptions } from './provider-ui';

describe('compatible API model choices', () => {
  it('keeps the provider order while removing empty and duplicate models', () => {
    expect(mergeProviderModelOptions(
      ['model-b', 'model-a', 'model-b'],
      ['model-c', ' ', 'model-a'],
    )).toEqual(['model-b', 'model-a', 'model-c']);
  });

  it('accepts missing model groups', () => {
    expect(mergeProviderModelOptions(undefined, ['manual-model'])).toEqual(['manual-model']);
  });
});
