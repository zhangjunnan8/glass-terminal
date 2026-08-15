export function mergeProviderModelOptions(
  ...groups: Array<readonly string[] | undefined>
): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const group of groups) {
    for (const value of group ?? []) {
      const model = value.trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      models.push(model);
    }
  }
  return models;
}

export type ProviderModelOptionSource = 'suggested' | 'discovered';

export function providerModelOptionPrompt(
  source: ProviderModelOptionSource,
  count: number,
): string {
  return source === 'discovered'
    ? `已检索到 ${count} 个可用模型`
    : `模板建议（${count} 个）`;
}
