import type { AgentChatMetadata, ChatSettings, MemoryDocument, TaskState, TaskStep, UserProfile } from "./types";

export type PromptTaskContext = {
  taskState?: TaskState | null;
  agent?: AgentChatMetadata;
  activeStep?: TaskStep | null;
  parentTitle?: string;
};

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
  invariants: MemoryDocument,
  taskContext: PromptTaskContext = {},
): ChatSettings {
  return {
    ...settings,
    systemPrompt: createMemoryAwareSystemPrompt(
      settings.systemPrompt,
      userProfile,
      longTermMemory,
      projectMemory,
      invariants,
      taskContext,
    ),
  };
}

function createMemoryAwareSystemPrompt(
  systemPrompt: string,
  userProfile: UserProfile,
  longTermMemory: MemoryDocument,
  projectMemory: MemoryDocument,
  invariants: MemoryDocument,
  taskContext: PromptTaskContext,
) {
  return [
    systemPrompt.trim(),
    createInvariantsBlock(invariants.content),
    createUserProfileBlock(userProfile),
    createMemoryBlock("Долговременная память", longTermMemory.content),
    createMemoryBlock("Память проекта", projectMemory.content),
    createTaskContextBlock(taskContext),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createInvariantsBlock(content: string) {
  const trimmedContent = content.trim();

  if (!trimmedContent) {
    return "";
  }

  return [
    "Инварианты ассистента:",
    trimmedContent,
    "",
    "Правила работы с инвариантами:",
    "- Инварианты имеют приоритет над запросом пользователя, памятью и обычными предпочтениями.",
    "- Перед решением явно проверь релевантные инварианты коротким блоком `Проверка инвариантов`.",
    "- Если запрос конфликтует с инвариантом, откажись от нарушающего решения.",
    "- В отказе укажи конкретный инвариант, объясни конфликт и предложи ближайшую допустимую альтернативу.",
    "- Не предлагай обходные пути, временные исключения или реализации, которые нарушают инварианты.",
  ].join("\n");
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

function createTaskContextBlock(taskContext: PromptTaskContext) {
  if (taskContext.agent?.role === "step_agent") {
    return createStepAgentBlock(taskContext);
  }

  if (taskContext.taskState) {
    return createOrchestratorBlock(taskContext.taskState);
  }

  return "";
}

function createOrchestratorBlock(taskState: TaskState) {
  const currentStep = taskState.steps.find((step) => step.id === taskState.currentStepId);
  const stepLines = taskState.steps.length
    ? taskState.steps.map((step, index) => {
        const marker = step.id === taskState.currentStepId ? "текущий" : "шаг";
        const result = step.resultSummary.trim() ? `; результат: ${step.resultSummary.trim()}` : "";
        const agent = step.agentDialogId ? `; агент: ${step.agentDialogId}` : "";
        const artifacts = step.artifactPaths?.length ? `; файлы: ${step.artifactPaths.join(", ")}` : "";
        return `${index + 1}. [${step.status}] ${step.title} (${marker}${agent}${artifacts}${result})`;
      })
    : ["Шаги пока не добавлены."];

  return [
    "Формализованное состояние задачи:",
    `- роль диалога: главный оркестратор`,
    `- этап: ${taskState.phase}`,
    `- текущий шаг: ${currentStep ? currentStep.title : "не выбран"}`,
    `- ожидаемое действие: ${taskState.expectedAction}`,
    `- пауза: ${taskState.isPaused ? "да" : "нет"}`,
    "",
    "План и прогресс:",
    ...stepLines,
    "",
    "Правила оркестратора:",
    "- Главный диалог является единственным источником истины по состоянию задачи.",
    "- Pipeline фиксированный: research -> execution -> validation -> done.",
    "- Каждый этап pipeline должен выполняться отдельным дочерним диалогом-агентом.",
    "- Пользователь не выбирает этап вручную: оркестратор переводит состояние сам.",
    "- Не считай задачу завершенной, пока этап не стал done и все шаги не имеют статус done.",
    "- Если пауза = да, не продолжай выполнение шагов сам. Сначала обработай ожидаемое действие пользователя.",
    "- Если пользователь ответил на вопрос, дал подтверждение или провалидировал результат, используй этот ответ и продолжай без повторного объяснения уже пройденного.",
    "- Если для продолжения нужен ответ пользователя или валидация результата, явно задай вопрос и ожидай ответ пользователя.",
  ].join("\n");
}

function createStepAgentBlock(taskContext: PromptTaskContext) {
  const step = taskContext.activeStep;

  return [
    "Формализованное состояние задачи:",
    `- роль диалога: дочерний агент шага`,
    `- родительский диалог: ${taskContext.agent?.role === "step_agent" ? taskContext.agent.parentChatId : "не указан"}`,
    `- родительская задача: ${taskContext.parentTitle || "не указана"}`,
    `- шаг: ${step ? step.title : "не найден"}`,
    `- статус шага: ${step ? step.status : "неизвестен"}`,
    `- ожидаемый результат: краткий отчет для оркестратора`,
    "",
    "Правила дочернего агента:",
    "- Выполняй только назначенный шаг.",
    "- Не меняй общий план и не объявляй всю задачу завершенной.",
    "- В конце дай отчет: что сделано, что найдено, риски, что оркестратор должен обновить в состоянии.",
  ].join("\n");
}
