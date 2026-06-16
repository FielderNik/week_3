import { getFallbackModels } from "./settings";
import type {
  ChatMessage,
  ChatSettings,
  ProviderId,
  ProviderModel,
  ReasoningEffort,
  ResponseFormat,
  ThinkingMode,
  TokenUsage,
} from "./types";

type OpenAiCompatibleRequestSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  responseFormat: ResponseFormat;
  stopSequences: string;
  thinkingMode?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
};

type ChatCompletionChoice = {
  message?: {
    role?: string;
    content?: string;
  };
};

type ChatCompletionResponse = {
  choices?: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type ChatCompletionRequestBody = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  response_format?: {
    type: ResponseFormat;
  };
  stop?: string[];
  thinking?: {
    type: ThinkingMode;
    reasoning_effort?: ReasoningEffort;
  };
  stream: false;
};

export type ProviderExchangeLog = {
  request: {
    url: string;
    body: ChatCompletionRequestBody;
  };
  response: {
    content?: string;
    usage?: TokenUsage;
    error?: string;
  };
};

type ChatCompletionResult = {
  content: string;
  usage?: TokenUsage;
  exchangeLog: ProviderExchangeLog;
};

type ModelsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
    owned_by?: string;
    context_length?: number;
    pricing?: {
      prompt?: string;
      completion?: string;
    };
    top_provider?: {
      context_length?: number;
    };
  }>;
  error?: {
    message?: string;
  };
};

export async function requestChatCompletion(
  history: ChatMessage[],
  settings: ChatSettings,
  signal?: AbortSignal,
): Promise<ChatCompletionResult> {
  const requestSettings = toOpenAiCompatibleRequestSettings(settings);
  const messages: ChatMessage[] = [
    ...(requestSettings.systemPrompt.trim()
      ? [{ role: "system" as const, content: requestSettings.systemPrompt.trim() }]
      : []),
    ...history,
  ];

  const stop = requestSettings.stopSequences
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 16);
  const body: ChatCompletionRequestBody = {
    model: requestSettings.model,
    messages,
    temperature: requestSettings.temperature,
    top_p: requestSettings.topP,
    max_tokens: requestSettings.maxTokens,
    stream: false,
  };

  if (requestSettings.responseFormat !== "text") {
    body.response_format = {
      type: requestSettings.responseFormat,
    };
  }

  if (stop.length > 0) {
    body.stop = stop;
  }

  if (requestSettings.thinkingMode) {
    body.thinking = {
      type: requestSettings.thinkingMode,
      ...(requestSettings.thinkingMode === "enabled" && requestSettings.reasoningEffort
        ? { reasoning_effort: requestSettings.reasoningEffort }
        : {}),
    };
  }

  const url = `${requestSettings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requestSettings.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
  const providerLabel = settings.provider === "openrouter" ? "OpenRouter" : "DeepSeek";
  const usage = toTokenUsage(data.usage);
  const answer = data.choices?.[0]?.message?.content;
  const exchangeLog = createExchangeLog(url, body, {
    content: answer,
    usage,
    ...(data.error?.message ? { error: data.error.message } : {}),
  });

  if (!response.ok) {
    throw createProviderError(data.error?.message || `${providerLabel} API вернул ${response.status}`, exchangeLog);
  }

  if (!answer) {
    throw createProviderError(`${providerLabel} API вернул пустой ответ.`, exchangeLog);
  }

  return {
    content: answer,
    usage,
    exchangeLog,
  };
}

export async function fetchProviderModels(settings: ChatSettings, signal?: AbortSignal): Promise<ProviderModel[]> {
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/models`, {
    method: "GET",
    signal,
    headers: {
      Accept: "application/json",
      ...(settings.apiKey.trim() ? { Authorization: `Bearer ${settings.apiKey.trim()}` } : {}),
    },
  });

  const data = (await response.json().catch(() => ({}))) as ModelsResponse;
  const providerLabel = settings.provider === "openrouter" ? "OpenRouter" : "DeepSeek";

  if (!response.ok) {
    throw new Error(data.error?.message || `${providerLabel} API моделей вернул ${response.status}`);
  }

  const models = (data.data || [])
    .map((model) => toProviderModel(model, settings.provider))
    .filter((model): model is ProviderModel => model !== null);

  if (models.length === 0) {
    throw new Error(`${providerLabel} API вернул пустой список моделей.`);
  }

  return mergeFallbackModelDetails(models, settings.provider);
}

function toTokenUsage(usage: ChatCompletionResponse["usage"]): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const reportedTotalTokens = Number(usage.total_tokens || 0);
  const totalTokens = promptTokens + completionTokens || reportedTotalTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

export function getProviderExchangeLog(error: unknown): ProviderExchangeLog | undefined {
  return error instanceof Error ? (error as Error & { exchangeLog?: ProviderExchangeLog }).exchangeLog : undefined;
}

function createExchangeLog(
  url: string,
  body: ChatCompletionRequestBody,
  response: ProviderExchangeLog["response"],
): ProviderExchangeLog {
  return {
    request: {
      url,
      body,
    },
    response,
  };
}

function createProviderError(message: string, exchangeLog: ProviderExchangeLog) {
  const error = new Error(message) as Error & { exchangeLog?: ProviderExchangeLog };
  error.exchangeLog = exchangeLog;
  return error;
}

function toOpenAiCompatibleRequestSettings(settings: ChatSettings): OpenAiCompatibleRequestSettings {
  const baseSettings: OpenAiCompatibleRequestSettings = {
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    temperature: settings.temperature,
    topP: settings.topP,
    maxTokens: settings.maxTokens,
    responseFormat: settings.responseFormat,
    stopSequences: settings.stopSequences,
  };

  if (settings.provider === "deepseek" && settings.model.startsWith("deepseek-v4")) {
    return {
      ...baseSettings,
      thinkingMode: settings.thinkingMode,
      reasoningEffort: settings.thinkingMode === "enabled" ? settings.reasoningEffort : undefined,
    };
  }

  return baseSettings;
}

function toProviderModel(model: NonNullable<ModelsResponse["data"]>[number], provider: ProviderId): ProviderModel | null {
  if (!model.id) {
    return null;
  }

  const inputPricePerMillion = toPricePerMillion(model.pricing?.prompt);
  const outputPricePerMillion = toPricePerMillion(model.pricing?.completion);
  const description = model.description || model.owned_by || "";

  return {
    id: model.id,
    name: model.name || model.id,
    description,
    provider,
    contextLength: model.context_length || model.top_provider?.context_length,
    parameterCountB: parseParameterCountB(`${model.name || ""} ${model.description || ""} ${model.id}`),
    inputPricePerMillion,
    outputPricePerMillion,
  };
}

function mergeFallbackModelDetails(models: ProviderModel[], provider: ProviderId): ProviderModel[] {
  const fallbackModels = getFallbackModels(provider);

  return models.map((model) => {
    const fallback = fallbackModels.find((item) => item.id === model.id);

    if (!fallback) {
      return model;
    }

    return {
      ...fallback,
      ...model,
      description: model.description || fallback.description,
      contextLength: model.contextLength || fallback.contextLength,
      parameterCountB: model.parameterCountB || fallback.parameterCountB,
      inputPricePerMillion: model.inputPricePerMillion ?? fallback.inputPricePerMillion,
      outputPricePerMillion: model.outputPricePerMillion ?? fallback.outputPricePerMillion,
    };
  });
}

function toPricePerMillion(value?: string) {
  const price = Number(value);

  if (!Number.isFinite(price) || price < 0) {
    return undefined;
  }

  return price * 1_000_000;
}

function parseParameterCountB(value: string) {
  const match = value.match(/(\d+(?:\.\d+)?)\s*([bmт]|billion|million|trillion)/i);

  if (!match) {
    return undefined;
  }

  const count = Number(match[1]);

  if (!Number.isFinite(count)) {
    return undefined;
  }

  const unit = match[2].toLowerCase();

  if (unit === "m" || unit === "million") {
    return count / 1000;
  }

  if (unit === "t" || unit === "т" || unit === "trillion") {
    return count * 1000;
  }

  return count;
}
