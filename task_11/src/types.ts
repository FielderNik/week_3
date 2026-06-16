export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ResponseFormat = "text" | "json_object";
export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "high" | "max";
export type ProviderId = "deepseek" | "openrouter";

export type ProviderModel = {
  id: string;
  name: string;
  description: string;
  provider: ProviderId;
  contextLength?: number;
  parameterCountB?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
};

export type ChatSettings = {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  responseFormat: ResponseFormat;
  stopSequences: string;
  thinkingMode: ThinkingMode;
  reasoningEffort: ReasoningEffort;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type AiExchangeLogEntry = {
  id: string;
  kind: "chat_completion";
  createdAt: string;
  provider: ProviderId;
  model: string;
  request: {
    url: string;
    body: unknown;
  };
  response: {
    content?: string;
    usage?: TokenUsage;
    error?: string;
  };
};

export type UiChatMessage = ChatMessage & {
  createdAt: string;
  tokenUsage?: TokenUsage;
};

export type SavedChatMetadata = Omit<ChatSettings, "apiKey"> & {
  tokenUsage?: TokenUsage;
};

export type SavedChat = {
  id: string;
  title: string;
  fileName?: string;
  messages: UiChatMessage[];
  metadata: SavedChatMetadata;
  createdAt: string;
  updatedAt: string;
};

export type MemoryDocument = {
  content: string;
  updatedAt: string;
};
