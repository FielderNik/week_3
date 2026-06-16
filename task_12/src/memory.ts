import type { ChatSettings, MemoryDocument, UserProfile } from "./types";

export const emptyMemoryDocument: MemoryDocument = {
  content: "",
  updatedAt: "",
};

export const emptyUserProfile: UserProfile = {
  displayName: "",
  context: "",
  stylePreferences: "",
  formatPreferences: "",
  restrictions: "",
  updatedAt: "",
};

export function createMemoryAwareSettings(
  settings: ChatSettings,
  userProfile: UserProfile,
  longTermMemory: MemoryDocument,
  projectMemory: MemoryDocument,
): ChatSettings {
  return {
    ...settings,
    systemPrompt: createMemoryAwareSystemPrompt(settings.systemPrompt, userProfile, longTermMemory, projectMemory),
  };
}

function createMemoryAwareSystemPrompt(
  systemPrompt: string,
  userProfile: UserProfile,
  longTermMemory: MemoryDocument,
  projectMemory: MemoryDocument,
) {
  return [
    systemPrompt.trim(),
    createUserProfileBlock(userProfile),
    createMemoryBlock("Долговременная память", longTermMemory.content),
    createMemoryBlock("Память проекта", projectMemory.content),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createUserProfileBlock(userProfile: UserProfile) {
  const lines = [
    createProfileLine("Имя или обращение", userProfile.displayName),
    createProfileLine("Контекст пользователя", userProfile.context),
    createProfileLine("Предпочтения по стилю", userProfile.stylePreferences),
    createProfileLine("Предпочтения по формату", userProfile.formatPreferences),
    createProfileLine("Ограничения", userProfile.restrictions),
  ].filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  return `Профиль пользователя:\n${lines.join("\n")}`;
}

function createProfileLine(label: string, value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  return `- ${label}: ${trimmedValue}`;
}

function createMemoryBlock(title: string, content: string) {
  const trimmedContent = content.trim();

  if (!trimmedContent) {
    return "";
  }

  return `${title}:\n${trimmedContent}`;
}
