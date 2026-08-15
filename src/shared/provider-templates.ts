export interface ProviderTemplate {
  id: 'openai' | 'deepseek' | 'zhipu' | 'minimax-cn' | 'minimax-global' | 'custom';
  name: string;
  baseUrl: string;
  suggestedModels: readonly string[];
  custom: boolean;
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI API',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModels: ['gpt-5.2'],
    custom: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    suggestedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    custom: false,
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    suggestedModels: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7-flash'],
    custom: false,
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax（中国）',
    baseUrl: 'https://api.minimaxi.com/v1',
    suggestedModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    custom: false,
  },
  {
    id: 'minimax-global',
    name: 'MiniMax（国际）',
    baseUrl: 'https://api.minimax.io/v1',
    suggestedModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    custom: false,
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容 API',
    baseUrl: '',
    suggestedModels: [],
    custom: true,
  },
] as const;

export function providerTemplateForBaseUrl(baseUrl: string): ProviderTemplate {
  const normalized = baseUrl.replace(/\/+$/, '');
  return PROVIDER_TEMPLATES.find((template) => (
    !template.custom && template.baseUrl === normalized
  )) ?? PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1]!;
}
