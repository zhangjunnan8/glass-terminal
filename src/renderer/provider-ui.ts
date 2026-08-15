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
