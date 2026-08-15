import { describe, expect, it } from 'vitest';
import {
  mergeProviderModelOptions,
  providerModelOptionPrompt,
} from './provider-ui';

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

  it('labels template suggestions separately from successful discovery results', () => {
    expect(providerModelOptionPrompt('suggested', 2)).toBe('模板建议（2 个）');
    expect(providerModelOptionPrompt('discovered', 7)).toBe('已检索到 7 个可用模型');
  });
});
