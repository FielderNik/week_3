import type { ChatSettings, ProviderId, ProviderModel } from "./types";

type ProviderConfig = {
  id: ProviderId;
  label: string;
  description: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  modelOptions: ProviderModel[];
};

export const providerOptions: ProviderConfig[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "Прямой OpenAI-compatible API DeepSeek",
    apiKey: import.meta.env.VITE_DEEPSEEK_API_KEY || "",
    baseUrl: import.meta.env.VITE_DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: import.meta.env.VITE_DEEPSEEK_MODEL || "deepseek-v4-flash",
    modelOptions: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        description: "284B / 13B active",
        provider: "deepseek",
        contextLength: 1_000_000,
        parameterCountB: 284,
        inputPricePerMillion: 0.14,
        outputPricePerMillion: 0.28,
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        description: "1.6T / 49B active",
        provider: "deepseek",
        contextLength: 1_000_000,
        parameterCountB: 1600,
        inputPricePerMillion: 0.435,
        outputPricePerMillion: 0.87,
      },
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat (legacy)",
        description: "Legacy alias for DeepSeek V4 Flash non-thinking mode",
        provider: "deepseek",
        contextLength: 1_000_000,
        parameterCountB: 284,
        inputPricePerMillion: 0.14,
        outputPricePerMillion: 0.28,
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner (legacy)",
        description: "Legacy alias for DeepSeek V4 Flash thinking mode",
        provider: "deepseek",
        contextLength: 1_000_000,
        parameterCountB: 284,
        inputPricePerMillion: 0.14,
        outputPricePerMillion: 0.28,
      },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Маршрутизатор моделей через OpenAI-compatible API",
    apiKey: import.meta.env.VITE_OPENROUTER_API_KEY || "",
    baseUrl: import.meta.env.VITE_OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    model: import.meta.env.VITE_OPENROUTER_MODEL || "openrouter/auto",
    modelOptions: [
      {
        id: "openrouter/auto",
        name: "OpenRouter Auto",
        description: "Автоматический выбор модели OpenRouter",
        provider: "openrouter",
      },
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek Chat через OpenRouter",
        description: "DeepSeek Chat из каталога OpenRouter",
        provider: "openrouter",
      },
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        description: "Anthropic Claude Sonnet через OpenRouter",
        provider: "openrouter",
      },
      {
        id: "openai/gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        description: "OpenAI GPT-4.1 Mini через OpenRouter",
        provider: "openrouter",
      },
    ],
  },
];

export function getProviderConfig(provider: ProviderId) {
  return providerOptions.find((option) => option.id === provider) || providerOptions[0];
}

export function getInitialProvider(): ProviderId {
  return import.meta.env.VITE_AI_PROVIDER === "openrouter" ? "openrouter" : "deepseek";
}

export function getProviderDefaults(provider: ProviderId): Pick<ChatSettings, "apiKey" | "baseUrl" | "model"> {
  const config = getProviderConfig(provider);

  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

export function getFallbackModels(provider: ProviderId): ProviderModel[] {
  return getProviderConfig(provider).modelOptions;
}

const initialProvider = getInitialProvider();
const initialProviderDefaults = getProviderDefaults(initialProvider);

export const initialSettings: ChatSettings = {
  provider: initialProvider,
  ...initialProviderDefaults,
  systemPrompt: "Ты полезный AI-ассистент. Отвечай кратко и по делу.",
  temperature: 0.7,
  topP: 1,
  maxTokens: 1200,
  responseFormat: "text",
  stopSequences: "",
  thinkingMode: "enabled",
  reasoningEffort: "high",
};

export function isChatSettingsKey(value: string): value is keyof ChatSettings {
  return value in initialSettings;
}

export function parseNumberSetting(rawValue: string, fallback: number, min: number, max: number) {
  const value = Number(rawValue);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}
