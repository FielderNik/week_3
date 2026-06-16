import type { ChatSettings, MemoryDocument } from "./types";

export const emptyMemoryDocument: MemoryDocument = {
  content: "",
  updatedAt: "",
};

export function createMemoryAwareSettings(
  settings: ChatSettings,
  longTermMemory: MemoryDocument,
  projectMemory: MemoryDocument,
): ChatSettings {
  return {
    ...settings,
    systemPrompt: createMemoryAwareSystemPrompt(settings.systemPrompt, longTermMemory, projectMemory),
  };
}

function createMemoryAwareSystemPrompt(
  systemPrompt: string,
  longTermMemory: MemoryDocument,
  projectMemory: MemoryDocument,
) {
  return [
    systemPrompt.trim(),
    createMemoryBlock("Долговременная память", longTermMemory.content),
    createMemoryBlock("Память проекта", projectMemory.content),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createMemoryBlock(title: string, content: string) {
  const trimmedContent = content.trim();

  if (!trimmedContent) {
    return "";
  }

  return `${title}:\n${trimmedContent}`;
}
