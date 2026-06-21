import "./styles.css";
import { createMemoryAwareSettings, emptyMemoryDocument, emptyUserProfile } from "./memory";
import type { PromptTaskContext } from "./memory";
import { renderMarkdown } from "./markdown";
import { fetchProviderModels, getProviderExchangeLog, requestChatCompletion } from "./providers";
import type { ProviderExchangeLog } from "./providers";
import {
  getFallbackModels,
  getProviderConfig,
  getProviderDefaults,
  initialSettings,
  isChatSettingsKey,
  parseNumberSetting,
  providerOptions,
} from "./settings";
import {
  appendSavedChatLog,
  deleteSavedChatFiles,
  hasDialogsDirectory,
  isFileStorageSupported,
  loadLongTermMemory,
  loadProjectMemory,
  loadUserProfile,
  loadSavedChats,
  persistArtifactFiles,
  persistLongTermMemory,
  persistProjectMemory,
  persistUserProfile,
  persistSavedChat,
  selectDialogsDirectory,
} from "./storage";
import type { ArtifactFileDraft } from "./storage";
import type {
  AiExchangeLogEntry,
  AgentChatMetadata,
  ChatMessage,
  ChatSettings,
  MemoryDocument,
  ProviderId,
  ProviderModel,
  SavedChat,
  SavedChatMetadata,
  TaskPhase,
  TaskState,
  TaskStep,
  TaskStepStatus,
  TokenUsage,
  UiChatMessage,
  UserProfile,
} from "./types";

type MemoryKind = "project" | "longTerm";
type PipelinePhase = Exclude<TaskPhase, "done">;

const pipelinePhases: PipelinePhase[] = ["research", "execution", "validation"];

let messages: UiChatMessage[] = [];
let settings: ChatSettings = { ...initialSettings };
let savedChats: SavedChat[] = [];
let activeSavedChatId: string | null = null;
let currentChatTitle = "Новый диалог";
let currentTokenUsage: TokenUsage = createEmptyTokenUsage();
let pendingLogEntries: AiExchangeLogEntry[] = [];
let storageStatus = isFileStorageSupported() ? "Папка не выбрана" : "Файловое хранение не поддерживается";
let isDialogsDirectoryConnected = false;
let isSending = false;
let activeRequest: AbortController | null = null;
let modelCatalog: ProviderModel[] = getFallbackModels(settings.provider);
let isLoadingModels = false;
let modelLoadError = "";
let activeModelsRequest: AbortController | null = null;
let modelParameterFilter = "all";
let modelCostFilter = "all";
let projectMemory: MemoryDocument = { ...emptyMemoryDocument };
let longTermMemory: MemoryDocument = { ...emptyMemoryDocument };
let userProfile: UserProfile = { ...emptyUserProfile };
let activeMemoryKind: MemoryKind | null = null;
let currentTaskState: TaskState | null = createInitialTaskState();
let currentAgentMetadata: AgentChatMetadata = { role: "orchestrator" };
const runningWorkflowChatIds = new Set<string>();

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root was not found.");
}

const appRoot = app;

appRoot.innerHTML = `
  <main class="app-shell">
    <aside class="saved-dialogs-panel" aria-label="Saved chats">
      <div class="saved-dialogs-header">
        <div>
          <p class="wordmark">Chat Template</p>
          <h2>Диалоги</h2>
        </div>
        <div class="saved-dialogs-actions">
          <button
            class="icon-button"
            data-action="create-orchestrator-dialog"
            type="button"
            aria-label="Создать новый диалог с оркестратором"
            title="Создать новый диалог с оркестратором"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            class="icon-button"
            data-action="select-dialogs-directory"
            data-select-dialogs-directory-button
            type="button"
            aria-label="Выбрать папку для файлов диалогов"
            title="Выбрать папку для файлов диалогов"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h4" />
            </svg>
          </button>
          <button
            class="icon-button danger-icon-button"
            data-action="clear-saved-dialogs"
            data-clear-saved-dialogs-button
            type="button"
            aria-label="Очистить сохраненные диалоги"
            title="Очистить сохраненные диалоги"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M6 6l1 16h10l1-16" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
            </svg>
          </button>
        </div>
      </div>
      <p class="storage-status" data-storage-status></p>
      <div class="saved-dialogs-list" data-saved-dialogs></div>
    </aside>

    <section class="chat-panel" aria-label="AI chat">
      <header class="chat-header">
        <div>
          <h1>AI Chat Template</h1>
          <p>Минимальный браузерный чат для задач курса</p>
        </div>
        <div class="header-actions">
          <button class="primary-button compact-button" data-action="save" type="button">Сохранить</button>
          <button class="ghost-button" data-action="clear" type="button">Очистить</button>
        </div>
      </header>

      <section class="dialog-info" aria-label="Текущий диалог">
        <div class="dialog-title-block">
          <span>Текущий диалог</span>
          <div class="dialog-title-row">
            <strong data-current-dialog-title></strong>
          </div>
        </div>
        <div class="dialog-metadata-row">
          <details class="dialog-metadata">
            <summary>Метаданные: настройки ИИ и расход</summary>
            <dl data-current-dialog-metadata></dl>
          </details>
          <output class="dialog-token-counter" data-current-dialog-token-counter aria-label="Потрачено токенов"></output>
        </div>
        <section class="task-state-summary" data-task-state-summary aria-label="Состояние задачи"></section>
      </section>

      <div class="messages" data-messages aria-live="polite"></div>

      <form class="composer" data-composer>
        <label class="visually-hidden" for="message-input">Сообщение</label>
        <textarea
          id="message-input"
          name="message"
          rows="3"
          placeholder="Спросите что-нибудь"
          autocomplete="off"
          data-message-input
        ></textarea>
        <button class="primary-button" type="submit" data-send-button>Отправить</button>
      </form>
    </section>

    <aside class="settings-panel" aria-label="Chat settings">
      <h2>Параметры AI</h2>

      <section class="task-state-panel" aria-label="Конечный автомат задачи">
        <div class="task-state-panel-header">
          <h3>Оркестратор</h3>
          <small data-task-state-status>research</small>
        </div>
        <div class="task-state-controls" data-task-state-controls></div>
      </section>

      <section class="memory-panel" aria-label="Память ассистента">
        <div class="memory-panel-header">
          <h3>Память</h3>
          <small>Добавляется в системный промпт</small>
        </div>
        <button class="memory-button" data-action="open-user-profile" type="button">
          <strong>Профиль пользователя</strong>
          <span data-user-profile-status>пусто</span>
        </button>
        <button class="memory-button" data-action="open-project-memory" type="button">
          <strong>Память проекта</strong>
          <span data-project-memory-status>пусто</span>
        </button>
        <button class="memory-button" data-action="open-long-term-memory" type="button">
          <strong>Долговременная память</strong>
          <span data-long-term-memory-status>пусто</span>
        </button>
      </section>

      <form class="settings-form" autocomplete="off">
        <div class="provider-field">
          <span>Провайдер <code>provider</code></span>
          <button class="provider-button" data-action="open-provider-dialog" type="button">
            <strong data-provider-name>${getProviderConfig(settings.provider).label}</strong>
            <small data-provider-description>${getProviderConfig(settings.provider).description}</small>
          </button>
        </div>

        <label>
          <span>Ключ API <code>api_key</code></span>
          <input data-setting="apiKey" type="password" autocomplete="off" placeholder="Берется из .env.local" />
        </label>

        <label>
          <span>Адрес API <code>base_url</code></span>
          <input data-setting="baseUrl" type="url" />
        </label>

        <div class="model-field">
          <span>Модель <code>model</code></span>
          <button class="model-button" data-action="open-model-dialog" type="button">
            <strong data-model-name>${getModelName(settings.model)}</strong>
            <small data-model-description>${getModelDescription(settings.model)}</small>
          </button>
        </div>

        <label class="wide-field">
          <span>Системный промпт <code>messages[0]</code></span>
          <textarea data-setting="systemPrompt" rows="4"></textarea>
        </label>

        <label>
          <span>Креативность <code>temperature</code> <output data-temperature-value></output></span>
          <input data-setting="temperature" type="range" min="0" max="2" step="0.1" />
        </label>

        <label>
          <span>Ядро вероятностей <code>top_p</code> <output data-top-p-value></output></span>
          <input data-setting="topP" type="range" min="0" max="1" step="0.05" />
        </label>

        <label>
          <span>Максимум токенов <code>max_tokens</code></span>
          <input data-setting="maxTokens" type="number" min="1" max="8000" step="100" />
        </label>

        <label>
          <span>Формат ответа <code>response_format.type</code></span>
          <select data-setting="responseFormat">
            <option value="text">Текст</option>
            <option value="json_object">JSON object</option>
          </select>
        </label>

        <label class="wide-field">
          <span>Стоп-последовательности <code>stop</code></span>
          <textarea data-setting="stopSequences" rows="3" placeholder="Одна строка = одна stop sequence"></textarea>
        </label>

        <label>
          <span>Режим размышления <code>thinking.type</code></span>
          <select data-setting="thinkingMode">
            <option value="enabled">Включен</option>
            <option value="disabled">Выключен</option>
          </select>
        </label>

        <label>
          <span>Глубина размышления <code>thinking.reasoning_effort</code></span>
          <select data-setting="reasoningEffort">
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </label>
      </form>
    </aside>
  </main>

  <dialog class="provider-dialog" data-provider-dialog>
    <form class="provider-dialog-form" method="dialog">
      <div>
        <p class="eyebrow">Провайдер</p>
        <h2>Выберите API-провайдера</h2>
      </div>
      <div class="provider-options">
        ${providerOptions
          .map(
            (provider) => `
              <button
                class="provider-option${provider.id === settings.provider ? " is-active" : ""}"
                data-action="select-provider"
                data-provider-id="${provider.id}"
                type="button"
              >
                <strong>${provider.label}</strong>
                <span>${provider.description}</span>
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="provider-dialog-actions">
        <button class="ghost-button" data-action="close-provider-dialog" type="button">Закрыть</button>
      </div>
    </form>
  </dialog>

  <dialog class="model-dialog" data-model-dialog>
    <form class="model-dialog-form" data-model-dialog-form method="dialog">
      <div>
        <p class="eyebrow">Модель</p>
        <h2>Выберите модель</h2>
      </div>

      <div class="model-dialog-toolbar">
        <label>
          <span>Параметры</span>
          <select data-model-parameter-filter>
            <option value="all">Любые</option>
            <option value="small">до 8B</option>
            <option value="medium">8B-70B</option>
            <option value="large">70B-300B</option>
            <option value="xlarge">300B+</option>
            <option value="unknown">Неизвестно</option>
          </select>
        </label>

        <label>
          <span>Стоимость</span>
          <select data-model-cost-filter>
            <option value="all">Любая</option>
            <option value="free">Бесплатно</option>
            <option value="cheap">до $0.50 / 1M</option>
            <option value="balanced">до $3 / 1M</option>
            <option value="premium">$3+ / 1M</option>
            <option value="unknown">Неизвестно</option>
          </select>
        </label>
      </div>

      <div class="model-dialog-status" data-model-dialog-status></div>
      <div class="model-options" data-model-options></div>

      <details class="custom-model-details">
        <summary>Своя модель</summary>
        <label>
          <span>Model id</span>
          <input data-custom-model type="text" placeholder="provider/model-id" />
        </label>
        <button class="ghost-button" data-action="select-custom-model" type="button">Использовать</button>
      </details>

      <div class="model-dialog-actions">
        <button class="ghost-button" data-action="refresh-models" type="button">Обновить</button>
        <button class="ghost-button" data-action="close-model-dialog" type="button">Закрыть</button>
      </div>
    </form>
  </dialog>

  <dialog class="save-dialog" data-save-dialog>
    <form class="save-dialog-form" data-save-dialog-form>
      <div>
        <p class="eyebrow">Сохранение</p>
        <h2>Название диалога</h2>
      </div>
      <label>
        <span>Название</span>
        <input data-save-title type="text" maxlength="80" required />
      </label>
      <p class="save-dialog-status" data-save-dialog-status aria-live="polite"></p>
      <div class="save-dialog-actions">
        <button class="ghost-button" data-action="cancel-save" type="button">Отмена</button>
        <button class="primary-button" type="submit">Сохранить</button>
      </div>
    </form>
  </dialog>

  <dialog class="memory-dialog" data-memory-dialog>
    <form class="memory-dialog-form" data-memory-dialog-form>
      <div>
        <p class="eyebrow" data-memory-dialog-eyebrow>Память</p>
        <h2 data-memory-dialog-title>Память</h2>
        <p class="memory-dialog-description" data-memory-dialog-description></p>
      </div>
      <label>
        <span data-memory-dialog-label>Содержимое</span>
        <textarea data-memory-content rows="12" spellcheck="true"></textarea>
      </label>
      <p class="memory-dialog-status" data-memory-dialog-status aria-live="polite"></p>
      <div class="memory-dialog-actions">
        <button class="ghost-button" data-action="cancel-memory-edit" type="button">Отмена</button>
        <button class="primary-button" type="submit">Сохранить</button>
      </div>
    </form>
  </dialog>

  <dialog class="profile-dialog" data-profile-dialog>
    <form class="profile-dialog-form" data-profile-dialog-form>
      <div>
        <p class="eyebrow">Профиль пользователя</p>
        <h2>Персонализация ассистента</h2>
        <p class="profile-dialog-description">
          Этот профиль хранится в user-profile.json и добавляется в системный промпт каждого запроса.
        </p>
      </div>
      <label>
        <span>Имя или обращение</span>
        <input data-profile-field="displayName" type="text" maxlength="120" autocomplete="off" />
      </label>
      <label>
        <span>Контекст пользователя</span>
        <textarea data-profile-field="context" rows="3" spellcheck="true"></textarea>
      </label>
      <label>
        <span>Предпочтения по стилю</span>
        <textarea data-profile-field="stylePreferences" rows="3" spellcheck="true"></textarea>
      </label>
      <label>
        <span>Предпочтения по формату</span>
        <textarea data-profile-field="formatPreferences" rows="3" spellcheck="true"></textarea>
      </label>
      <label>
        <span>Ограничения</span>
        <textarea data-profile-field="restrictions" rows="3" spellcheck="true"></textarea>
      </label>
      <p class="profile-dialog-status" data-profile-dialog-status aria-live="polite"></p>
      <div class="profile-dialog-actions">
        <button class="ghost-button" data-action="cancel-profile-edit" type="button">Отмена</button>
        <button class="primary-button" type="submit">Сохранить</button>
      </div>
    </form>
  </dialog>

`;

const savedDialogsContainer = appRoot.querySelector<HTMLDivElement>("[data-saved-dialogs]")!;
const storageStatusElement = appRoot.querySelector<HTMLParagraphElement>("[data-storage-status]")!;
const selectDialogsDirectoryButton = appRoot.querySelector<HTMLButtonElement>("[data-select-dialogs-directory-button]")!;
const clearSavedDialogsButton = appRoot.querySelector<HTMLButtonElement>("[data-clear-saved-dialogs-button]")!;
const messagesContainer = appRoot.querySelector<HTMLDivElement>("[data-messages]")!;
const composer = appRoot.querySelector<HTMLFormElement>("[data-composer]")!;
const messageInput = appRoot.querySelector<HTMLTextAreaElement>("[data-message-input]")!;
const sendButton = appRoot.querySelector<HTMLButtonElement>("[data-send-button]")!;
const currentDialogTitleElement = appRoot.querySelector<HTMLElement>("[data-current-dialog-title]")!;
const currentDialogTokenCounterElement = appRoot.querySelector<HTMLOutputElement>("[data-current-dialog-token-counter]")!;
const currentDialogMetadataElement = appRoot.querySelector<HTMLElement>("[data-current-dialog-metadata]")!;
const taskStateSummaryElement = appRoot.querySelector<HTMLElement>("[data-task-state-summary]")!;
const taskStateStatusElement = appRoot.querySelector<HTMLElement>("[data-task-state-status]")!;
const taskStateControlsElement = appRoot.querySelector<HTMLElement>("[data-task-state-controls]")!;
const providerDialog = appRoot.querySelector<HTMLDialogElement>("[data-provider-dialog]")!;
const providerName = appRoot.querySelector<HTMLElement>("[data-provider-name]")!;
const providerDescription = appRoot.querySelector<HTMLElement>("[data-provider-description]")!;
const modelDialog = appRoot.querySelector<HTMLDialogElement>("[data-model-dialog]")!;
const modelName = appRoot.querySelector<HTMLElement>("[data-model-name]")!;
const modelOptionsContainer = appRoot.querySelector<HTMLElement>("[data-model-options]")!;
const modelDialogStatus = appRoot.querySelector<HTMLElement>("[data-model-dialog-status]")!;
const modelParameterFilterSelect = appRoot.querySelector<HTMLSelectElement>("[data-model-parameter-filter]")!;
const modelCostFilterSelect = appRoot.querySelector<HTMLSelectElement>("[data-model-cost-filter]")!;
const saveDialog = appRoot.querySelector<HTMLDialogElement>("[data-save-dialog]")!;
const saveDialogForm = appRoot.querySelector<HTMLFormElement>("[data-save-dialog-form]")!;
const saveTitleInput = appRoot.querySelector<HTMLInputElement>("[data-save-title]")!;
const saveDialogStatusElement = appRoot.querySelector<HTMLParagraphElement>("[data-save-dialog-status]")!;
const temperatureValue = appRoot.querySelector<HTMLOutputElement>("[data-temperature-value]")!;
const topPValue = appRoot.querySelector<HTMLOutputElement>("[data-top-p-value]")!;
const modelDescription = appRoot.querySelector<HTMLElement>("[data-model-description]")!;
const customModelInput = appRoot.querySelector<HTMLInputElement>("[data-custom-model]")!;
const userProfileStatusElement = appRoot.querySelector<HTMLElement>("[data-user-profile-status]")!;
const projectMemoryStatusElement = appRoot.querySelector<HTMLElement>("[data-project-memory-status]")!;
const longTermMemoryStatusElement = appRoot.querySelector<HTMLElement>("[data-long-term-memory-status]")!;
const memoryDialog = appRoot.querySelector<HTMLDialogElement>("[data-memory-dialog]")!;
const memoryDialogForm = appRoot.querySelector<HTMLFormElement>("[data-memory-dialog-form]")!;
const memoryDialogEyebrow = appRoot.querySelector<HTMLElement>("[data-memory-dialog-eyebrow]")!;
const memoryDialogTitle = appRoot.querySelector<HTMLElement>("[data-memory-dialog-title]")!;
const memoryDialogDescription = appRoot.querySelector<HTMLParagraphElement>("[data-memory-dialog-description]")!;
const memoryDialogLabel = appRoot.querySelector<HTMLElement>("[data-memory-dialog-label]")!;
const memoryContentInput = appRoot.querySelector<HTMLTextAreaElement>("[data-memory-content]")!;
const memoryDialogStatusElement = appRoot.querySelector<HTMLParagraphElement>("[data-memory-dialog-status]")!;
const profileDialog = appRoot.querySelector<HTMLDialogElement>("[data-profile-dialog]")!;
const profileDialogForm = appRoot.querySelector<HTMLFormElement>("[data-profile-dialog-form]")!;
const profileDisplayNameInput = appRoot.querySelector<HTMLInputElement>("[data-profile-field='displayName']")!;
const profileContextInput = appRoot.querySelector<HTMLTextAreaElement>("[data-profile-field='context']")!;
const profileStylePreferencesInput = appRoot.querySelector<HTMLTextAreaElement>(
  "[data-profile-field='stylePreferences']",
)!;
const profileFormatPreferencesInput = appRoot.querySelector<HTMLTextAreaElement>(
  "[data-profile-field='formatPreferences']",
)!;
const profileRestrictionsInput = appRoot.querySelector<HTMLTextAreaElement>("[data-profile-field='restrictions']")!;
const profileDialogStatusElement = appRoot.querySelector<HTMLParagraphElement>("[data-profile-dialog-status]")!;

if (
  !savedDialogsContainer ||
  !storageStatusElement ||
  !selectDialogsDirectoryButton ||
  !clearSavedDialogsButton ||
  !messagesContainer ||
  !composer ||
  !messageInput ||
  !sendButton ||
  !currentDialogTitleElement ||
  !currentDialogTokenCounterElement ||
  !currentDialogMetadataElement ||
  !taskStateSummaryElement ||
  !taskStateStatusElement ||
  !taskStateControlsElement ||
  !providerDialog ||
  !providerName ||
  !providerDescription ||
  !modelDialog ||
  !modelName ||
  !modelOptionsContainer ||
  !modelDialogStatus ||
  !modelParameterFilterSelect ||
  !modelCostFilterSelect ||
  !saveDialog ||
  !saveDialogForm ||
  !saveTitleInput ||
  !saveDialogStatusElement ||
  !temperatureValue ||
  !topPValue ||
  !modelDescription ||
  !customModelInput ||
  !userProfileStatusElement ||
  !projectMemoryStatusElement ||
  !longTermMemoryStatusElement ||
  !memoryDialog ||
  !memoryDialogForm ||
  !memoryDialogEyebrow ||
  !memoryDialogTitle ||
  !memoryDialogDescription ||
  !memoryDialogLabel ||
  !memoryContentInput ||
  !memoryDialogStatusElement ||
  !profileDialog ||
  !profileDialogForm ||
  !profileDisplayNameInput ||
  !profileContextInput ||
  !profileStylePreferencesInput ||
  !profileFormatPreferencesInput ||
  !profileRestrictionsInput ||
  !profileDialogStatusElement
) {
  throw new Error("Required UI elements were not found.");
}

function createChatId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createEmptyTokenUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function createInitialTaskState(): TaskState {
  const now = new Date().toISOString();
  const steps = createPipelineSteps(now);

  return {
    phase: "research",
    currentStepId: steps[0]?.id || null,
    expectedAction: "Напишите задачу в главный чат.",
    isPaused: false,
    askBeforeStageTransition: true,
    steps,
    updatedAt: now,
  };
}

function createPipelineSteps(createdAt: string): TaskStep[] {
  return pipelinePhases.map((phase) => ({
    id: `phase-${phase}`,
    phase,
    title: getPipelinePhaseTitle(phase),
    status: "pending",
    agentDialogId: null,
    artifactPaths: [],
    resultSummary: "",
    updatedAt: createdAt,
  }));
}

function touchTaskState(taskState: TaskState): TaskState {
  return {
    ...taskState,
    updatedAt: new Date().toISOString(),
  };
}

function ensureCurrentTaskState() {
  if (!currentTaskState) {
    currentTaskState = createInitialTaskState();
  }

  currentTaskState = normalizeTaskState(currentTaskState);
  return currentTaskState;
}

function normalizeTaskState(taskState: TaskState): TaskState {
  const now = new Date().toISOString();
  const existingStepsByPhase = new Map(taskState.steps.flatMap((step) => (step.phase ? [[step.phase, step]] : [])));
  const steps = createPipelineSteps(now).map((pipelineStep) => ({
    ...pipelineStep,
    ...existingStepsByPhase.get(pipelineStep.phase!),
    artifactPaths: existingStepsByPhase.get(pipelineStep.phase!)?.artifactPaths || [],
    phase: pipelineStep.phase,
    title: pipelineStep.title,
  }));
  const phase = isPipelinePhase(taskState.phase) || taskState.phase === "done" ? taskState.phase : "research";
  const currentPhase = phase === "done" ? "validation" : phase;
  const currentStep = steps.find((step) => step.phase === currentPhase) || steps[0] || null;
  const hasValidCurrentStep = steps.some((step) => step.id === taskState.currentStepId);

  return {
    ...taskState,
    phase,
    currentStepId: hasValidCurrentStep ? taskState.currentStepId : currentStep?.id || null,
    askBeforeStageTransition: taskState.askBeforeStageTransition !== false,
    steps,
  };
}

function setCurrentTaskState(nextTaskState: TaskState) {
  currentTaskState = touchTaskState(nextTaskState);
  renderTaskState();
}

function getCurrentStep(taskState: TaskState = ensureCurrentTaskState()) {
  return taskState.steps.find((step) => step.id === taskState.currentStepId) || null;
}

function getTaskPhaseLabel(phase: TaskPhase) {
  const labels: Record<TaskPhase, string> = {
    research: "research",
    execution: "execution",
    validation: "validation",
    done: "done",
  };

  return labels[phase];
}

function getStepStatusLabel(status: TaskStepStatus) {
  const labels: Record<TaskStepStatus, string> = {
    pending: "ожидает",
    in_progress: "в работе",
    blocked: "блокер",
    done: "готово",
    failed: "ошибка",
  };

  return labels[status];
}

function getNextTaskPhase(phase: TaskPhase): TaskPhase | null {
  if (phase === "research") {
    return "execution";
  }

  if (phase === "execution") {
    return "validation";
  }

  if (phase === "validation") {
    return "done";
  }

  return null;
}

function isPipelinePhase(phase: TaskPhase): phase is PipelinePhase {
  return phase === "research" || phase === "execution" || phase === "validation";
}

function getPipelinePhaseTitle(phase: PipelinePhase) {
  const titles: Record<PipelinePhase, string> = {
    research: "Research: изучить задачу и контекст",
    execution: "Execution: реализовать решение",
    validation: "Validation: проверить результат",
  };

  return titles[phase];
}

function getStepByPhase(taskState: TaskState, phase: TaskPhase) {
  return isPipelinePhase(phase) ? taskState.steps.find((step) => step.phase === phase) || null : null;
}

function isWaitingForStageApproval(taskState: TaskState) {
  const currentStep = getCurrentStep(taskState);
  return taskState.isPaused && currentStep?.status === "done" && taskState.expectedAction.includes("подтверд");
}

function isUserApproval(value: string) {
  const text = value.trim().toLowerCase();

  if (!text) {
    return false;
  }

  if (/(^|\s)(нет|не|стоп|погоди|исправь|плохо|не ок|не норм)(\s|$)/u.test(text)) {
    return false;
  }

  return /(^|\s)(да|ага|ок|okay|yes|норм|готово|подтверждаю|можно|передавай|go|го)(\s|$)/u.test(text);
}

function createStageApprovalQuestion(completedStep: TaskStep, nextPhase: TaskPhase | null) {
  const artifactsText = createStepArtifactsText(completedStep);

  if (nextPhase && nextPhase !== "done") {
    return [
      `Агент этапа "${completedStep.title}": Я закончил, можно передавать в работу следующему агенту (${nextPhase}), все ок?`,
      artifactsText,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [`Агент этапа "${completedStep.title}": Я закончил, можно завершать задачу, все ок?`, artifactsText]
    .filter(Boolean)
    .join("\n\n");
}

function createStageTransitionExpectedAction(completedStep: TaskStep, nextPhase: TaskPhase | null) {
  if (nextPhase && nextPhase !== "done") {
    return `Пользователь должен подтвердить передачу результата этапа "${completedStep.title}" следующему агенту (${nextPhase}).`;
  }

  return `Пользователь должен подтвердить завершение задачи после этапа "${completedStep.title}".`;
}

function getNextPhaseStep(taskState: TaskState) {
  const nextPhase = getNextTaskPhase(taskState.phase);
  return {
    nextPhase,
    nextStep: nextPhase ? getStepByPhase(taskState, nextPhase) : null,
  };
}

function getParentChatForAgent(agentMetadata: AgentChatMetadata) {
  if (agentMetadata.role !== "step_agent") {
    return null;
  }

  return savedChats.find((chat) => chat.id === agentMetadata.parentChatId) || null;
}

function getStepForAgent(agentMetadata: AgentChatMetadata) {
  const parentChat = getParentChatForAgent(agentMetadata);

  if (!parentChat?.taskState || agentMetadata.role !== "step_agent") {
    return null;
  }

  return parentChat.taskState.steps.find((step) => step.id === agentMetadata.stepId) || null;
}

function getPromptTaskContext(): PromptTaskContext {
  if (currentAgentMetadata.role === "step_agent") {
    const parentChat = getParentChatForAgent(currentAgentMetadata);

    return {
      agent: currentAgentMetadata,
      taskState: parentChat?.taskState,
      activeStep: getStepForAgent(currentAgentMetadata),
      parentTitle: parentChat?.title,
    };
  }

  const taskState = ensureCurrentTaskState();

  return {
    agent: currentAgentMetadata,
    taskState,
    activeStep: getCurrentStep(taskState),
    parentTitle: currentChatTitle,
  };
}

function createStepAgentPrompt(parentTitle: string, parentTaskBrief: string, taskState: TaskState, step: TaskStep) {
  const doneSummaries = taskState.steps
    .filter((item) => item.status === "done" && item.resultSummary.trim())
    .map((item) => `- ${item.title}: ${item.resultSummary.trim()}`);
  const askBeforeStageTransition = taskState.askBeforeStageTransition !== false;

  return [
    "Ты отдельный агент для одного шага задачи.",
    "",
    `Родительская задача: ${parentTitle}`,
    "",
    "Исходное описание задачи от пользователя:",
    parentTaskBrief,
    "",
    `Этап оркестратора: ${taskState.phase}`,
    `Твой этап: ${step.phase || taskState.phase}`,
    `Твоя работа: ${step.title}`,
    "",
    "Что уже сделано:",
    doneSummaries.length ? doneSummaries.join("\n") : "- Пока нет завершенных шагов.",
    "",
    "Верни краткий отчет для главного диалога:",
    "- что сделано или найдено",
    "- какие файлы или части системы важны",
    "- риски и ограничения",
    "- что оркестратор должен обновить в состоянии",
    "",
    "Если ты создаешь или изменяешь файл, обязательно верни его содержимое отдельным code block в формате:",
    "```file:relative/path.ext",
    "содержимое файла",
    "```",
    "Не утверждай, что файл сохранен на диск. Файл сохраняет только оркестратор после твоего ответа.",
    "",
    askBeforeStageTransition
      ? "В конце явно напиши, что этап закончен и можно спрашивать пользователя о передаче дальше. Сам вопрос пользователю задаст оркестратор в главном чате."
      : "В конце дай отчет так, чтобы оркестратор мог сразу передать работу дальше.",
    "Не переходи к другим этапам и не объявляй всю задачу завершенной.",
  ].join("\n");
}

function getOrchestratorNextActionMessage(taskState: TaskState) {
  const currentStep = getCurrentStep(taskState);

  if (taskState.phase === "done") {
    return "Задача уже завершена.";
  }

  if (taskState.isPaused) {
    return `Задача на паузе. Ожидаемое действие: ${taskState.expectedAction}`;
  }

  return currentStep
    ? `Задача принята. Оркестратор передает работу агенту этапа ${currentStep.phase || taskState.phase}.`
    : "Задача принята. Оркестратор готовит следующий этап.";
}

function getShortExpectedAction(value: string) {
  const normalized = value.replaceAll(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  return normalized.length > 160 ? `${normalized.slice(0, 160).trim()}...` : normalized;
}

function shouldPauseForAssistantQuestion(content: string) {
  const text = content.trim();

  if (!text.includes("?")) {
    return false;
  }

  const lowerText = text.toLowerCase();
  return (
    lowerText.includes("уточ") ||
    lowerText.includes("вопрос") ||
    lowerText.includes("подтверд") ||
    lowerText.includes("проверь") ||
    lowerText.includes("можно") ||
    lowerText.includes("нужно ли") ||
    lowerText.includes("как лучше") ||
    lowerText.includes("что выбрать")
  );
}

function getPauseExpectedActionFromAssistant(content: string) {
  const question = content
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.includes("?"));

  return `Ответить на вопрос агента${question ? `: ${getShortExpectedAction(question)}` : "."}`;
}

async function updateParentTaskStateFromStepAgent(
  agentMetadata: Extract<AgentChatMetadata, { role: "step_agent" }>,
  nextStatus: TaskStepStatus,
  expectedAction: string,
  isPaused: boolean,
) {
  const parentChat = getParentChatForAgent(agentMetadata);

  if (!parentChat?.taskState) {
    return;
  }

  const steps = parentChat.taskState.steps.map((step) =>
    step.id === agentMetadata.stepId
      ? {
          ...step,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        }
      : step,
  );
  const nextTaskState: TaskState = touchTaskState({
    ...parentChat.taskState,
    steps,
    currentStepId: agentMetadata.stepId,
    expectedAction,
    isPaused,
  });
  const nextParentChat: SavedChat = {
    ...parentChat,
    taskState: nextTaskState,
    updatedAt: new Date().toISOString(),
  };
  const savedParentChat = await persistSavedChat(nextParentChat, parentChat.fileName);
  savedChats = savedChats.map((chat) => (chat.id === savedParentChat.id ? savedParentChat : chat));
  renderSavedChats();
  renderTaskState();
}

function normalizeTokenUsage(usage: TokenUsage): TokenUsage {
  const totalTokens = usage.promptTokens + usage.completionTokens || usage.totalTokens;

  return {
    ...usage,
    totalTokens,
  };
}

function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return normalizeTokenUsage({
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  });
}

function createPromptTokenUsage(usage: TokenUsage): TokenUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: 0,
    totalTokens: usage.promptTokens,
  };
}

function createCompletionTokenUsage(usage: TokenUsage): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: usage.completionTokens,
    totalTokens: usage.completionTokens,
  };
}

function getMessagesTokenUsage(savedMessages: UiChatMessage[]): TokenUsage {
  return savedMessages.reduce(
    (tokenUsage, message) => (message.tokenUsage ? addTokenUsage(tokenUsage, message.tokenUsage) : tokenUsage),
    createEmptyTokenUsage(),
  );
}

function getSavedTokenUsage(metadata: SavedChatMetadata, savedMessages: UiChatMessage[] = []): TokenUsage {
  return metadata.tokenUsage ? normalizeTokenUsage(metadata.tokenUsage) : getMessagesTokenUsage(savedMessages);
}

function getSettingsMetadata(): SavedChatMetadata {
  const { apiKey: _apiKey, ...metadata } = settings;
  return {
    ...metadata,
    tokenUsage: { ...currentTokenUsage },
  };
}

function applySavedMetadata(metadata: SavedChatMetadata, savedMessages: UiChatMessage[] = []) {
  const { tokenUsage: _tokenUsage, ...savedSettings } = metadata;
  const provider = isProviderId(savedSettings.provider) ? savedSettings.provider : "deepseek";
  settings = {
    ...savedSettings,
    provider,
    apiKey: provider === settings.provider ? settings.apiKey : getProviderDefaults(provider).apiKey,
  };
  currentTokenUsage = getSavedTokenUsage(metadata, savedMessages);
  resetModelCatalog(provider);
  syncSettingsForm();
}

function syncSettingsForm() {
  const providerConfig = getProviderConfig(settings.provider);
  providerName.textContent = providerConfig.label;
  providerDescription.textContent = providerConfig.description;
  appRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-setting]").forEach((control) => {
    const settingName = control.dataset.setting;

    if (!settingName || !isChatSettingsKey(settingName)) {
      return;
    }

    control.value = String(settings[settingName]);
  });
  temperatureValue.textContent = settings.temperature.toFixed(1);
  topPValue.textContent = settings.topP.toFixed(2);
  modelName.textContent = getModelName(settings.model);
  modelDescription.textContent = getModelDescription(settings.model);
  renderProviderDialogOptions();
  renderModelDialog();
}

function getModelName(modelValue: string) {
  return modelCatalog.find((model) => model.id === modelValue)?.name || modelValue;
}

function getModelDescription(modelValue: string) {
  const model = modelCatalog.find((item) => item.id === modelValue);

  if (!model) {
    return "Своя модель";
  }

  return [formatParameterCount(model.parameterCountB), formatModelPrice(model)].filter(Boolean).join(" · ") || model.description;
}

function resetModelCatalog(provider: ProviderId) {
  modelCatalog = getFallbackModels(provider);
  modelLoadError = "";
  isLoadingModels = false;
  activeModelsRequest?.abort();
  activeModelsRequest = null;
}

function renderProviderDialogOptions() {
  appRoot.querySelectorAll<HTMLButtonElement>("[data-provider-id]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.providerId === settings.provider);
  });
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "deepseek" || value === "openrouter";
}

function selectProvider(provider: ProviderId) {
  if (settings.provider === provider) {
    providerDialog.close();
    return;
  }

  settings = {
    ...settings,
    provider,
    ...getProviderDefaults(provider),
  };
  customModelInput.value = "";
  resetModelCatalog(provider);
  syncSettingsForm();
  renderCurrentDialogInfo();
  providerDialog.close();
}

async function openModelDialog() {
  modelDialog.showModal();
  customModelInput.value = settings.model;
  renderModelDialog();
  await loadProviderModels();
}

async function loadProviderModels() {
  activeModelsRequest?.abort();
  activeModelsRequest = new AbortController();
  isLoadingModels = true;
  modelLoadError = "";
  renderModelDialog();

  try {
    modelCatalog = await fetchProviderModels(settings, activeModelsRequest.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }

    modelCatalog = getFallbackModels(settings.provider);
    modelLoadError = error instanceof Error ? error.message : "Не удалось загрузить список моделей.";
  } finally {
    activeModelsRequest = null;
    isLoadingModels = false;
    syncSettingsForm();
    renderCurrentDialogInfo();
  }
}

function renderModelDialog() {
  modelParameterFilterSelect.value = modelParameterFilter;
  modelCostFilterSelect.value = modelCostFilter;
  const filteredModels = getFilteredModels();

  modelDialogStatus.textContent = getModelDialogStatus(filteredModels.length);
  modelOptionsContainer.innerHTML =
    filteredModels.length > 0
      ? filteredModels.map((model) => renderModelOption(model)).join("")
      : `<p class="model-options-empty">Под выбранные фильтры моделей нет.</p>`;
}

function getModelDialogStatus(modelsCount: number) {
  const parts = [`${modelsCount} ${getModelsWord(modelsCount)}`];

  if (isLoadingModels) {
    parts.push("загрузка из API");
  }

  if (modelLoadError) {
    parts.push(`fallback: ${modelLoadError}`);
  }

  return parts.join(" · ");
}

function getFilteredModels() {
  return modelCatalog.filter((model) => matchesParameterFilter(model) && matchesCostFilter(model));
}

function matchesParameterFilter(model: ProviderModel) {
  const value = model.parameterCountB;

  if (modelParameterFilter === "all") {
    return true;
  }

  if (modelParameterFilter === "unknown") {
    return value === undefined;
  }

  if (value === undefined) {
    return false;
  }

  if (modelParameterFilter === "small") {
    return value <= 8;
  }

  if (modelParameterFilter === "medium") {
    return value > 8 && value <= 70;
  }

  if (modelParameterFilter === "large") {
    return value > 70 && value <= 300;
  }

  return value > 300;
}

function matchesCostFilter(model: ProviderModel) {
  const price = getModelFilterPrice(model);

  if (modelCostFilter === "all") {
    return true;
  }

  if (modelCostFilter === "unknown") {
    return price === undefined;
  }

  if (price === undefined) {
    return false;
  }

  if (modelCostFilter === "free") {
    return price === 0;
  }

  if (modelCostFilter === "cheap") {
    return price > 0 && price <= 0.5;
  }

  if (modelCostFilter === "balanced") {
    return price > 0.5 && price <= 3;
  }

  return price > 3;
}

function renderModelOption(model: ProviderModel) {
  return `
    <button
      class="model-option${model.id === settings.model ? " is-active" : ""}"
      data-action="select-model"
      data-model-id="${escapeHtml(model.id)}"
      type="button"
    >
      <strong>${escapeHtml(model.name)}</strong>
      <span>${escapeHtml(model.id)}</span>
      <small>${escapeHtml(formatModelMeta(model))}</small>
    </button>
  `;
}

function selectModel(modelId: string) {
  settings.model = modelId;
  customModelInput.value = modelId;
  syncSettingsForm();
  renderCurrentDialogInfo();
  modelDialog.close();
}

function renderSavedChats() {
  storageStatusElement.textContent = storageStatus;
  selectDialogsDirectoryButton.disabled = !isFileStorageSupported();
  clearSavedDialogsButton.disabled = savedChats.length === 0;

  if (savedChats.length === 0) {
    savedDialogsContainer.innerHTML = `
      <p class="saved-dialogs-empty">Сохраненных диалогов пока нет.</p>
    `;
    return;
  }

  const childChatsByParentId = new Map<string, SavedChat[]>();
  const rootChats: SavedChat[] = [];

  for (const chat of savedChats) {
    if (chat.agent?.role === "step_agent") {
      const children = childChatsByParentId.get(chat.agent.parentChatId) || [];
      children.push(chat);
      childChatsByParentId.set(chat.agent.parentChatId, children);
    } else {
      rootChats.push(chat);
    }
  }

  const orphanChildChats = savedChats.filter((chat) => {
    if (chat.agent?.role !== "step_agent") {
      return false;
    }

    const parentChatId = chat.agent.parentChatId;
    return !savedChats.some((parent) => parent.id === parentChatId);
  });

  savedDialogsContainer.innerHTML = [...rootChats, ...orphanChildChats]
    .map((chat) => renderSavedChatGroup(chat, childChatsByParentId.get(chat.id) || []))
    .join("");
}

function renderSavedChatGroup(chat: SavedChat, childChats: SavedChat[]) {
  const childrenMarkup = childChats.length
    ? `
        <details class="saved-dialog-children">
          <summary>${childChats.length} ${getAgentsWord(childChats.length)}</summary>
          <div class="saved-dialog-children-list">
            ${childChats.map((childChat) => renderSavedChatItem(childChat, { isChild: true })).join("")}
          </div>
        </details>
      `
    : "";

  return `
    <article class="saved-dialog-group">
      ${renderSavedChatItem(chat)}
      ${childrenMarkup}
    </article>
  `;
}

function renderSavedChatItem(chat: SavedChat, options: { isChild?: boolean } = {}) {
  const isActive = chat.id === activeSavedChatId;
  const messagesCount = chat.messages.length;
  const tokenUsage = getSavedTokenUsage(chat.metadata, chat.messages);
  const isRunning = runningWorkflowChatIds.has(chat.id);
  const taskState = chat.taskState;
  const statusParts = [
    options.isChild ? "субагент" : taskState ? `оркестратор · ${taskState.phase}` : "диалог",
    isRunning ? "в фоне" : "",
    `${messagesCount} ${getMessagesWord(messagesCount)}`,
  ].filter(Boolean);

  return `
    <button
      class="saved-dialog-item${isActive ? " is-active" : ""}${options.isChild ? " is-child" : ""}${isRunning ? " is-running" : ""}"
      data-action="open-saved-dialog"
      data-dialog-id="${escapeHtml(chat.id)}"
      type="button"
    >
      <strong>${escapeHtml(chat.title)}</strong>
      <span>${escapeHtml(statusParts.join(" · "))}</span>
      <small>${formatSavedChatDate(chat.updatedAt)} · ${escapeHtml(getSavedProviderLabel(chat.metadata))} · ${escapeHtml(chat.metadata.model)} · ${formatTokenCount(tokenUsage.totalTokens)} токенов</small>
    </button>
  `;
}

function renderMemoryControls() {
  userProfileStatusElement.textContent = formatUserProfileStatus(userProfile);
  projectMemoryStatusElement.textContent = formatMemoryStatus(projectMemory);
  longTermMemoryStatusElement.textContent = formatMemoryStatus(longTermMemory);
}

function renderTaskState() {
  renderTaskStateSummary();
  renderTaskStateControls();
}

function renderTaskStateSummary() {
  if (currentAgentMetadata.role === "step_agent") {
    const parentChat = getParentChatForAgent(currentAgentMetadata);
    const step = getStepForAgent(currentAgentMetadata);
    taskStateSummaryElement.innerHTML = `
      <div>
        <span>Роль</span>
        <strong>Дочерний агент шага</strong>
      </div>
      <div>
        <span>Шаг</span>
        <strong>${escapeHtml(step?.title || "Шаг не найден")}</strong>
      </div>
      <div>
        <span>Оркестратор</span>
        <strong>${escapeHtml(parentChat?.title || "Диалог не найден")}</strong>
      </div>
    `;
    return;
  }

  const taskState = ensureCurrentTaskState();
  const currentStep = getCurrentStep(taskState);
  taskStateSummaryElement.innerHTML = `
    <div>
      <span>Этап</span>
      <strong>${escapeHtml(getTaskPhaseLabel(taskState.phase))}</strong>
    </div>
    <div>
      <span>Текущий шаг</span>
      <strong>${escapeHtml(currentStep?.title || "не выбран")}</strong>
    </div>
    <div>
      <span>Ожидаемое действие</span>
      <strong>${escapeHtml(taskState.expectedAction)}</strong>
    </div>
  `;
}

function renderTaskStateControls() {
  if (currentAgentMetadata.role === "step_agent") {
    renderStepAgentControls();
    return;
  }

  const taskState = ensureCurrentTaskState();
  const currentStep = getCurrentStep(taskState);

  taskStateStatusElement.textContent = `${taskState.phase}${taskState.isPaused ? " · пауза" : ""}`;
  taskStateControlsElement.innerHTML = `
    <div class="task-state-meta">
      <span>Этап</span>
      <strong>${escapeHtml(taskState.phase)}</strong>
      <span>Текущий шаг</span>
      <strong>${escapeHtml(currentStep?.title || "не выбран")}</strong>
      <span>Ожидаемое действие</span>
      <strong>${escapeHtml(taskState.expectedAction)}</strong>
    </div>
    <label class="task-state-toggle">
      <input data-ask-between-stages type="checkbox" ${taskState.askBeforeStageTransition === false ? "" : "checked"} />
      <span>Спрашивать перед передачей следующему агенту</span>
    </label>
    <div class="task-steps">
      ${taskState.steps.map((step) => renderTaskStep(step, taskState.currentStepId)).join("")}
    </div>
  `;
}

function renderStepAgentControls() {
  const parentChat = getParentChatForAgent(currentAgentMetadata);
  const step = getStepForAgent(currentAgentMetadata);
  taskStateStatusElement.textContent = "дочерний агент";
  taskStateControlsElement.innerHTML = `
    <div class="task-state-meta">
      <span>Родительский диалог</span>
      <strong>${escapeHtml(parentChat?.title || "не найден")}</strong>
      <span>Шаг</span>
      <strong>${escapeHtml(step?.title || "не найден")}</strong>
      <span>Статус</span>
      <strong>${escapeHtml(step ? getStepStatusLabel(step.status) : "неизвестен")}</strong>
    </div>
    <div class="task-state-actions">
      <button class="ghost-button" data-action="open-parent-dialog" type="button" ${parentChat ? "" : "disabled"}>
        К оркестратору
      </button>
    </div>
  `;
}

function renderTaskStep(step: TaskStep, currentStepId: string | null) {
  const isCurrent = step.id === currentStepId;

  return `
    <article class="task-step${isCurrent ? " is-current" : ""}">
      <div class="task-step-header">
        <strong>${escapeHtml(step.title)}</strong>
        <span>${escapeHtml(getStepStatusLabel(step.status))}</span>
      </div>
      ${step.artifactPaths?.length ? `<p>Файлы: ${escapeHtml(step.artifactPaths.join(", "))}</p>` : ""}
      ${step.resultSummary.trim() ? `<p>${escapeHtml(step.resultSummary)}</p>` : ""}
    </article>
  `;
}

function formatUserProfileStatus(profile: UserProfile) {
  if (!hasUserProfileContent(profile)) {
    return "пусто";
  }

  return profile.updatedAt ? `обновлен ${formatSavedChatDate(profile.updatedAt)}` : "сохранен";
}

function hasUserProfileContent(profile: UserProfile) {
  return [
    profile.displayName,
    profile.context,
    profile.stylePreferences,
    profile.formatPreferences,
    profile.restrictions,
  ].some((value) => value.trim());
}

function formatMemoryStatus(memoryDocument: MemoryDocument) {
  if (!memoryDocument.content.trim()) {
    return "пусто";
  }

  return memoryDocument.updatedAt ? `обновлена ${formatSavedChatDate(memoryDocument.updatedAt)}` : "сохранена";
}

function getMemoryDocument(kind: MemoryKind) {
  return kind === "project" ? projectMemory : longTermMemory;
}

function getMemoryDialogCopy(kind: MemoryKind) {
  if (kind === "project") {
    return {
      eyebrow: "Память проекта",
      title: "Память проекта",
      label: "Данные текущей задачи",
      description: "Эта память хранится в project-memory.json и добавляется в системный промпт после долговременной памяти.",
    };
  }

  return {
    eyebrow: "Долговременная память",
    title: "Долговременная память",
    label: "Профиль, решения и знания",
    description: "Эта память хранится в long-term-memory.json и добавляется в системный промпт перед памятью проекта.",
  };
}

function openMemoryDialog(kind: MemoryKind) {
  const copy = getMemoryDialogCopy(kind);
  const memoryDocument = getMemoryDocument(kind);

  activeMemoryKind = kind;
  memoryDialogEyebrow.textContent = copy.eyebrow;
  memoryDialogTitle.textContent = copy.title;
  memoryDialogLabel.textContent = copy.label;
  memoryDialogDescription.textContent = copy.description;
  memoryContentInput.value = memoryDocument.content;
  memoryDialogStatusElement.textContent = isDialogsDirectoryConnected
    ? "Память будет сохранена в подключенную папку dialogs."
    : "При сохранении нужно выбрать папку для файлов памяти.";
  memoryDialog.showModal();
  memoryContentInput.focus();
}

function openUserProfileDialog() {
  profileDisplayNameInput.value = userProfile.displayName;
  profileContextInput.value = userProfile.context;
  profileStylePreferencesInput.value = userProfile.stylePreferences;
  profileFormatPreferencesInput.value = userProfile.formatPreferences;
  profileRestrictionsInput.value = userProfile.restrictions;
  profileDialogStatusElement.textContent = isDialogsDirectoryConnected
    ? "Профиль будет сохранен в подключенную папку dialogs."
    : "При сохранении нужно выбрать папку для файлов памяти.";
  profileDialog.showModal();
  profileDisplayNameInput.focus();
}

function renderCurrentDialogInfo() {
  const totalCost = calculateTokenCost(currentTokenUsage, settings.model);

  currentDialogTitleElement.textContent = currentChatTitle;
  currentDialogTokenCounterElement.value = `${formatTokenCount(currentTokenUsage.totalTokens)} токенов · ${formatCost(totalCost.total)}`;
  currentDialogTokenCounterElement.textContent = currentDialogTokenCounterElement.value;
  currentDialogMetadataElement.innerHTML = renderSettingsMetadata(settings, currentTokenUsage);
}

function renderMessages() {
  renderCurrentDialogInfo();

  const workflowActivity = renderWorkflowActivity();

  if (messages.length === 0) {
    messagesContainer.innerHTML = `
      <div class="empty-state">
        <h2>С чего начнем?</h2>
        <p>Шаблон готов отправлять сообщения через выбранный AI-провайдер.</p>
      </div>
      ${workflowActivity}
    `;
    return;
  }

  const renderedMessages = messages
    .map(
      (message) => `
        <article class="message ${message.role}">
          <div class="message-meta">
            <strong>${message.role === "user" ? "Вы" : "AI"}</strong>
            <span class="message-meta-details">
              ${renderMessageUsage(message)}
              <time datetime="${message.createdAt}">${formatMessageTime(message.createdAt)}</time>
            </span>
          </div>
          <div class="message-content">
            ${renderMessageContent(message)}
          </div>
        </article>
      `,
    )
    .join("");

  const typingIndicator = isSending
    ? `
        <article class="message assistant typing-message" aria-live="polite">
          <div class="message-meta">
            <strong>AI</strong>
            <span>набирает сообщение</span>
          </div>
          <div class="typing-dots" aria-label="AI набирает сообщение">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </article>
      `
    : "";

  messagesContainer.innerHTML = renderedMessages + workflowActivity + typingIndicator;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function renderWorkflowActivity() {
  if (!activeSavedChatId || !runningWorkflowChatIds.has(activeSavedChatId) || currentAgentMetadata.role !== "orchestrator") {
    return "";
  }

  const taskState = ensureCurrentTaskState();
  const currentStep = getCurrentStep(taskState);

  return `
    <article class="workflow-activity" aria-live="polite" aria-label="Оркестратор выполняет задачу">
      <div class="workflow-activity-header">
        <span class="workflow-activity-spinner" aria-hidden="true"></span>
        <strong>Оркестратор выполняет задачу</strong>
      </div>
      <dl class="workflow-activity-state">
        <div>
          <dt>Этап</dt>
          <dd>${escapeHtml(taskState.phase)}</dd>
        </div>
        <div>
          <dt>Шаг</dt>
          <dd>${escapeHtml(currentStep?.title || "не выбран")}</dd>
        </div>
        <div>
          <dt>Статус</dt>
          <dd>${escapeHtml(currentStep ? getStepStatusLabel(currentStep.status) : "неизвестен")}</dd>
        </div>
      </dl>
      <p>${escapeHtml(taskState.expectedAction)}</p>
      <div class="workflow-activity-dots" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </article>
  `;
}

function setSending(nextValue: boolean) {
  isSending = nextValue;
  sendButton.textContent = nextValue ? "Оркестратор работает..." : "Отправить";
  sendButton.disabled = nextValue;
  messageInput.disabled = nextValue;
}

function updateSetting(name: keyof ChatSettings, rawValue: string) {
  if (name === "temperature") {
    settings.temperature = parseNumberSetting(rawValue, settings.temperature, 0, 2);
    temperatureValue.textContent = settings.temperature.toFixed(1);
    return;
  }

  if (name === "topP") {
    settings.topP = parseNumberSetting(rawValue, settings.topP, 0, 1);
    topPValue.textContent = settings.topP.toFixed(2);
    return;
  }

  if (name === "maxTokens") {
    settings.maxTokens = parseNumberSetting(rawValue, settings.maxTokens, 1, 8000);
    return;
  }

  settings = {
    ...settings,
    [name]: rawValue,
  };
}

function renderSettingsMetadata(
  value: ChatSettings | SavedChatMetadata,
  tokenUsage: TokenUsage,
) {
  const totalCost = calculateTokenCost(tokenUsage, value.model);
  const rows: Array<[string, string]> = [
    ["base_url", value.baseUrl],
    ["provider", getProviderConfig(isProviderId(value.provider) ? value.provider : "deepseek").label],
    ["model", value.model],
    ["tokens.total", formatTokenCount(tokenUsage.totalTokens)],
    ["tokens.prompt", formatTokenCount(tokenUsage.promptTokens)],
    ["tokens.completion", formatTokenCount(tokenUsage.completionTokens)],
    ["cost.total", formatCost(totalCost.total)],
    ["cost.prompt", formatCost(totalCost.prompt)],
    ["cost.completion", formatCost(totalCost.completion)],
    ["system_prompt", value.systemPrompt || "не задан"],
    ["temperature", value.temperature.toFixed(1)],
    ["top_p", value.topP.toFixed(2)],
    ["max_tokens", String(value.maxTokens)],
    ["response_format", value.responseFormat],
    ["stop", value.stopSequences.trim() || "не заданы"],
    ["thinking.type", value.thinkingMode],
    ["thinking.reasoning_effort", value.reasoningEffort],
  ];

  return rows
    .map(
      ([name, value]) => `
        <div>
          <dt>${escapeHtml(name)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `,
    )
    .join("");
}

function getSavedProviderLabel(metadata: SavedChatMetadata) {
  return getProviderConfig(isProviderId(metadata.provider) ? metadata.provider : "deepseek").label;
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

type TokenCost = {
  prompt?: number;
  completion?: number;
  total?: number;
};

function calculateTokenCost(tokenUsage: TokenUsage, modelId: string): TokenCost {
  const model = modelCatalog.find((item) => item.id === modelId);
  const prompt = calculatePartCost(tokenUsage.promptTokens, model?.inputPricePerMillion);
  const completion = calculatePartCost(tokenUsage.completionTokens, model?.outputPricePerMillion);

  return {
    prompt,
    completion,
    total: prompt === undefined && completion === undefined ? undefined : (prompt || 0) + (completion || 0),
  };
}

function calculatePartCost(tokens: number, pricePerMillion?: number) {
  if (pricePerMillion === undefined) {
    return undefined;
  }

  return (tokens / 1_000_000) * pricePerMillion;
}

function formatCost(value?: number) {
  if (value === undefined) {
    return "стоимость неизвестна";
  }

  if (value === 0) {
    return "$0";
  }

  const maximumFractionDigits = value < 0.01 ? 6 : 4;

  return `$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value)}`;
}

function formatSavedChatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function getMessagesWord(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "сообщений";
  }

  if (lastDigit === 1) {
    return "сообщение";
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return "сообщения";
  }

  return "сообщений";
}

function getDialogsWord(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "диалогов";
  }

  if (lastDigit === 1) {
    return "диалог";
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return "диалога";
  }

  return "диалогов";
}

function getAgentsWord(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "субагентов";
  }

  if (lastDigit === 1) {
    return "субагент";
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return "субагента";
  }

  return "субагентов";
}

function getModelsWord(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "моделей";
  }

  if (lastDigit === 1) {
    return "модель";
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return "модели";
  }

  return "моделей";
}

function formatModelMeta(model: ProviderModel) {
  const details = [
    formatParameterCount(model.parameterCountB),
    formatModelContext(model.contextLength),
    formatModelPrice(model),
    model.description,
  ].filter(Boolean);

  return details.join(" · ");
}

function formatParameterCount(value?: number) {
  if (value === undefined) {
    return "";
  }

  if (value >= 1000) {
    return `${formatCompactNumber(value / 1000)}T параметров`;
  }

  return `${formatCompactNumber(value)}B параметров`;
}

function formatModelContext(value?: number) {
  if (!value) {
    return "";
  }

  return `${formatCompactNumber(value)} контекст`;
}

function formatModelPrice(model: ProviderModel) {
  const input = formatPrice(model.inputPricePerMillion);
  const output = formatPrice(model.outputPricePerMillion);

  if (!input && !output) {
    return "";
  }

  return `$${input || "?"} in / $${output || "?"} out за 1M`;
}

function formatPrice(value?: number) {
  if (value === undefined) {
    return "";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function getModelFilterPrice(model: ProviderModel) {
  const prices = [model.inputPricePerMillion, model.outputPricePerMillion].filter((value): value is number => {
    return value !== undefined;
  });

  if (prices.length === 0) {
    return undefined;
  }

  return Math.max(...prices);
}

function queueExchangeLog(exchangeLog: ProviderExchangeLog, error?: string) {
  pendingLogEntries = [...pendingLogEntries, createExchangeLogEntry(exchangeLog, error)];
}

function cloneLogValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getDefaultChatTitle() {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content.trim();

  if (firstUserMessage) {
    return firstUserMessage.length > 48 ? `${firstUserMessage.slice(0, 48)}...` : firstUserMessage;
  }

  return `Диалог ${formatSavedChatDate(new Date().toISOString())}`;
}

function openSaveDialog() {
  saveTitleInput.value = currentChatTitle === "Новый диалог" ? getDefaultChatTitle() : currentChatTitle;
  saveDialogStatusElement.textContent = isDialogsDirectoryConnected
    ? "Диалог будет сохранен в подключенную папку dialogs."
    : "При сохранении нужно выбрать папку для файлов диалогов.";
  saveDialog.showModal();
  saveTitleInput.focus();
  saveTitleInput.select();
}

async function hydrateSavedChats() {
  try {
    const [loadedSavedChats, loadedProjectMemory, loadedLongTermMemory, loadedUserProfile] = await Promise.all([
      loadSavedChats(),
      loadProjectMemory(),
      loadLongTermMemory(),
      loadUserProfile(),
    ]);
    const hasDirectory = await hasDialogsDirectory();
    savedChats = loadedSavedChats;
    projectMemory = loadedProjectMemory;
    longTermMemory = loadedLongTermMemory;
    userProfile = loadedUserProfile;
    isDialogsDirectoryConnected = hasDirectory;
    storageStatus = hasDirectory
      ? `Папка dialogs подключена: ${savedChats.length} ${getDialogsWord(savedChats.length)}`
      : "Папка не выбрана";
  } catch (error) {
    isDialogsDirectoryConnected = false;
    storageStatus = error instanceof Error ? error.message : "Не удалось прочитать файлы диалогов.";
  }

  renderSavedChats();
  renderMemoryControls();
  renderTaskState();
}

async function selectStorageDirectory() {
  try {
    const selectedSavedChats = await selectDialogsDirectory();
    const [loadedProjectMemory, loadedLongTermMemory, loadedUserProfile] = await Promise.all([
      loadProjectMemory(),
      loadLongTermMemory(),
      loadUserProfile(),
    ]);
    savedChats = selectedSavedChats;
    projectMemory = loadedProjectMemory;
    longTermMemory = loadedLongTermMemory;
    userProfile = loadedUserProfile;
    isDialogsDirectoryConnected = true;
    activeSavedChatId = null;
    storageStatus = `Папка dialogs подключена: ${savedChats.length} ${getDialogsWord(savedChats.length)}`;
    renderSavedChats();
    renderMemoryControls();
    renderTaskState();
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return false;
    }

    isDialogsDirectoryConnected = false;
    storageStatus = error instanceof Error ? error.message : "Не удалось выбрать папку.";
    renderSavedChats();
    renderMemoryControls();
    renderTaskState();
    return false;
  }
}

async function ensureStorageDirectoryConnected(statusElement?: HTMLElement) {
  if (!isFileStorageSupported()) {
    const message = "Этот браузер не умеет сохранять файлы памяти и диалогов.";
    storageStatus = message;
    if (statusElement) {
      statusElement.textContent = message;
    }
    renderSavedChats();
    return false;
  }

  if (isDialogsDirectoryConnected) {
    return true;
  }

  if (statusElement) {
    statusElement.textContent = "Выберите папку, внутри нее будет создана папка dialogs.";
  }

  const isConnected = await selectStorageDirectory();

  if (!isConnected && statusElement) {
    statusElement.textContent = "Папка не выбрана, файл не сохранен.";
  }

  return isConnected;
}

async function saveActiveMemoryDocument() {
  if (!activeMemoryKind) {
    return;
  }

  const isConnected = await ensureStorageDirectoryConnected(memoryDialogStatusElement);

  if (!isConnected) {
    return;
  }

  memoryDialogStatusElement.textContent = "Сохраняю память...";
  const content = memoryContentInput.value;

  if (activeMemoryKind === "project") {
    projectMemory = await persistProjectMemory(content);
  } else {
    longTermMemory = await persistLongTermMemory(content);
  }

  memoryDialogStatusElement.textContent = "Память сохранена.";
  renderMemoryControls();
  memoryDialog.close();
}

async function saveUserProfile() {
  const isConnected = await ensureStorageDirectoryConnected(profileDialogStatusElement);

  if (!isConnected) {
    return;
  }

  profileDialogStatusElement.textContent = "Сохраняю профиль...";
  userProfile = await persistUserProfile({
    displayName: profileDisplayNameInput.value,
    context: profileContextInput.value,
    stylePreferences: profileStylePreferencesInput.value,
    formatPreferences: profileFormatPreferencesInput.value,
    restrictions: profileRestrictionsInput.value,
  });

  profileDialogStatusElement.textContent = "Профиль сохранен.";
  renderMemoryControls();
  profileDialog.close();
}

async function saveCurrentChat(title: string) {
  const now = new Date().toISOString();
  const existingIndex = activeSavedChatId ? savedChats.findIndex((chat) => chat.id === activeSavedChatId) : -1;
  const existingChat = existingIndex >= 0 ? savedChats[existingIndex] : null;
  const isOrchestrator = currentAgentMetadata.role === "orchestrator";
  const savedChatDraft: SavedChat = {
    id: existingChat?.id || createChatId(),
    title,
    messages: messages.map((message) => ({ ...message })),
    metadata: getSettingsMetadata(),
    ...(isOrchestrator ? { taskState: ensureCurrentTaskState(), agent: { role: "orchestrator" } } : {}),
    ...(currentAgentMetadata.role === "step_agent" ? { agent: currentAgentMetadata } : {}),
    createdAt: existingChat?.createdAt || now,
    updatedAt: now,
  };
  const savedChat = await persistSavedChat(savedChatDraft, existingChat?.fileName);
  const hadPendingLogEntries = pendingLogEntries.length > 0;
  const areLogsSaved = await flushPendingLogEntries(savedChat);

  if (existingIndex >= 0) {
    savedChats = savedChats.map((chat) => (chat.id === savedChat.id ? savedChat : chat));
  } else {
    savedChats = [savedChat, ...savedChats];
  }

  savedChats = savedChats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  activeSavedChatId = savedChat.id;
  currentChatTitle = savedChat.title;
  isDialogsDirectoryConnected = true;
  storageStatus = areLogsSaved ? (hadPendingLogEntries ? "Диалог и лог сохранены в файл" : "Диалог сохранен в файл") : storageStatus;
  renderSavedChats();
  renderTaskState();
  renderMessages();
}

async function saveActiveTaskState() {
  if (currentAgentMetadata.role !== "orchestrator") {
    return;
  }

  if (!activeSavedChatId) {
    const isConnected = await ensureStorageDirectoryConnected();

    if (!isConnected) {
      return;
    }

    await saveCurrentChat(getDefaultChatTitle());
    return;
  }

  await autosaveActiveChat();
}

async function createOrchestratorDialog() {
  activeRequest?.abort();
  activeRequest = null;
  messages = [];
  activeSavedChatId = null;
  currentChatTitle = `Оркестратор ${formatSavedChatDate(new Date().toISOString())}`;
  currentTokenUsage = createEmptyTokenUsage();
  pendingLogEntries = [];
  currentTaskState = createInitialTaskState();
  currentAgentMetadata = { role: "orchestrator" };
  setSending(false);
  renderSavedChats();
  renderTaskState();
  renderMessages();

  if (isFileStorageSupported()) {
    const isConnected = await ensureStorageDirectoryConnected();

    if (isConnected) {
      await saveCurrentChat(currentChatTitle);
    }
  }

  messageInput.focus();
}

async function setAskBeforeStageTransition(value: boolean) {
  const taskState = ensureCurrentTaskState();
  setCurrentTaskState({
    ...taskState,
    askBeforeStageTransition: value,
  });
  await saveActiveTaskState();
}

function createStageTransitionState(taskState: TaskState): TaskState {
  const { nextPhase, nextStep } = getNextPhaseStep(taskState);

  if (!nextPhase || nextPhase === "done") {
    return {
      ...taskState,
      phase: "done",
      isPaused: false,
      expectedAction: "Задача завершена.",
    };
  }

  return {
    ...taskState,
    phase: nextPhase,
    currentStepId: nextStep?.id || taskState.currentStepId,
    isPaused: false,
    expectedAction: `Оркестратор передает задачу агенту этапа ${nextPhase}.`,
  };
}

function createStageTransitionConfirmationMessage(taskState: TaskState) {
  const nextPhase = getNextTaskPhase(taskState.phase);

  if (!nextPhase || nextPhase === "done") {
    return "Ок, задача завершена.";
  }

  return `Ок, передаю задачу агенту этапа ${nextPhase}.`;
}

function createAutoStageTransitionMessage(completedStep: TaskStep, nextPhase: TaskPhase | null) {
  const artifactsText = createStepArtifactsText(completedStep);

  if (nextPhase && nextPhase !== "done") {
    return [
      `Агент этапа "${completedStep.title}" завершил работу. Передаю результат агенту этапа ${nextPhase}.`,
      artifactsText,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [`Агент этапа "${completedStep.title}" завершил работу. Все этапы pipeline выполнены.`, artifactsText]
    .filter(Boolean)
    .join("\n\n");
}

function createStepArtifactsText(step: TaskStep) {
  if (!step.artifactPaths?.length) {
    return "";
  }

  return ["Сохраненные файлы:", ...step.artifactPaths.map((path) => `- ${path}`)].join("\n");
}

function createStepAgentTaskContext(
  agentMetadata: Extract<AgentChatMetadata, { role: "step_agent" }>,
  parentTaskState: TaskState,
  step: TaskStep,
): PromptTaskContext {
  return {
    agent: agentMetadata,
    taskState: parentTaskState,
    activeStep: step,
    parentTitle: currentChatTitle,
  };
}

function createExchangeLogEntry(exchangeLog: ProviderExchangeLog, error?: string): AiExchangeLogEntry {
  return {
    id: createChatId(),
    kind: "chat_completion",
    createdAt: new Date().toISOString(),
    provider: settings.provider,
    model: settings.model,
    request: {
      url: exchangeLog.request.url,
      body: cloneLogValue(exchangeLog.request.body),
    },
    response: {
      ...exchangeLog.response,
      ...(error ? { error } : {}),
    },
  };
}

function replaceSavedChat(savedChat: SavedChat) {
  const hasChat = savedChats.some((chat) => chat.id === savedChat.id);
  savedChats = (hasChat
    ? savedChats.map((chat) => (chat.id === savedChat.id ? savedChat : chat))
    : [savedChat, ...savedChats]
  ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function syncActiveChatFromSaved(savedChat: SavedChat) {
  if (activeSavedChatId !== savedChat.id) {
    return;
  }

  currentChatTitle = savedChat.title;
  messages = savedChat.messages.map((message) => ({ ...message }));
  currentAgentMetadata = savedChat.agent || { role: "orchestrator" };
  currentTaskState = currentAgentMetadata.role === "orchestrator" ? savedChat.taskState || createInitialTaskState() : null;
  currentTokenUsage = getSavedTokenUsage(savedChat.metadata, savedChat.messages);
  renderTaskState();
  renderMessages();
}

async function persistAndReplaceSavedChat(savedChat: SavedChat, previousFileName?: string) {
  const nextSavedChat = await persistSavedChat(savedChat, previousFileName);
  replaceSavedChat(nextSavedChat);
  syncActiveChatFromSaved(nextSavedChat);
  renderSavedChats();
  return nextSavedChat;
}

function createSettingsForSavedChat(savedChat: SavedChat): ChatSettings {
  const { tokenUsage: _tokenUsage, ...metadata } = savedChat.metadata;
  const provider = isProviderId(metadata.provider) ? metadata.provider : settings.provider;

  return {
    ...metadata,
    provider,
    apiKey: settings.apiKey,
  };
}

function getParentTaskBriefFromMessages(savedMessages: UiChatMessage[], fallbackTitle: string) {
  const userMessages = savedMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);

  if (userMessages.length === 0) {
    return fallbackTitle;
  }

  return userMessages.join("\n\n").slice(0, 2000);
}

function addSavedChatTokenUsage(savedChat: SavedChat, usage?: TokenUsage): SavedChat {
  if (!usage) {
    return savedChat;
  }

  return {
    ...savedChat,
    metadata: {
      ...savedChat.metadata,
      tokenUsage: addTokenUsage(getSavedTokenUsage(savedChat.metadata, savedChat.messages), usage),
    },
  };
}

function extractArtifactFiles(content: string): ArtifactFileDraft[] {
  const artifacts = new Map<string, ArtifactFileDraft>();
  const codeFencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeFencePattern.exec(content)) !== null) {
    const path = getArtifactPathFromFenceInfo(match[1] || "");

    if (!path) {
      continue;
    }

    artifacts.set(path, {
      path,
      content: stripSingleTrailingNewline(match[2] || ""),
    });
  }

  return [...artifacts.values()];
}

function getArtifactPathFromFenceInfo(value: string) {
  const info = value.trim();
  const match = info.match(/(?:^|\s)(?:file|path)\s*[:=]\s*["']?([^"'\s]+)["']?/i);

  if (!match) {
    return "";
  }

  return match[1].trim();
}

function stripSingleTrailingNewline(value: string) {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function startBackgroundWorkflow(chatId: string) {
  if (runningWorkflowChatIds.has(chatId)) {
    return;
  }

  runningWorkflowChatIds.add(chatId);
  renderSavedChats();
  if (activeSavedChatId === chatId) {
    renderMessages();
  }

  void runSavedOrchestratorWorkflow(chatId)
    .catch((error) => {
      const parentChat = savedChats.find((chat) => chat.id === chatId);

      if (!parentChat) {
        return;
      }

      const message = error instanceof Error ? error.message : "Не удалось выполнить агентный workflow.";
      const nextParentChat: SavedChat = {
        ...parentChat,
        messages: [
          ...parentChat.messages,
          {
            role: "assistant",
            content: message,
            createdAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      void persistAndReplaceSavedChat(nextParentChat, parentChat.fileName);
    })
    .finally(() => {
      runningWorkflowChatIds.delete(chatId);
      renderSavedChats();
      if (activeSavedChatId === chatId) {
        renderMessages();
      }
    });
}

async function runSavedOrchestratorWorkflow(chatId: string) {
  let parentChat = savedChats.find((chat) => chat.id === chatId);

  if (!parentChat) {
    return;
  }

  if (!settings.apiKey.trim()) {
    const providerLabel = getProviderConfig(settings.provider).label;
    parentChat = await appendAssistantMessageToSavedChat(
      parentChat,
      `Добавьте ${providerLabel} API key в .env.local или во временное поле API key, чтобы оркестратор смог запускать дочерних агентов.`,
    );
    return;
  }

  while (true) {
    const taskState = normalizeTaskState(parentChat.taskState || createInitialTaskState());

    if (taskState.phase === "done" || taskState.isPaused) {
      parentChat = await persistAndReplaceSavedChat({ ...parentChat, taskState }, parentChat.fileName);
      return;
    }

    const currentStep = getCurrentStep(taskState);

    if (!currentStep) {
      parentChat = await persistAndReplaceSavedChat(
        {
          ...parentChat,
          taskState: touchTaskState({
            ...taskState,
            isPaused: true,
            expectedAction: "Не найден текущий этап pipeline.",
          }),
          updatedAt: new Date().toISOString(),
        },
        parentChat.fileName,
      );
      return;
    }

    if (currentStep.status !== "done") {
      parentChat = await markSavedStepInProgress(parentChat, taskState, currentStep);
      const runResult = await runSavedStepAgent(parentChat, currentStep);
      parentChat = runResult.parentChat;
    }

    const completedTaskState = normalizeTaskState(parentChat.taskState || createInitialTaskState());
    const completedStep = completedTaskState.steps.find((step) => step.id === completedTaskState.currentStepId);

    if (!completedStep || completedStep.status !== "done") {
      return;
    }

    const { nextPhase } = getNextPhaseStep(completedTaskState);

    if (completedTaskState.askBeforeStageTransition !== false) {
      parentChat = await persistAndReplaceSavedChat(
        {
          ...parentChat,
          messages: [
            ...parentChat.messages,
            {
              role: "assistant",
              content: createStageApprovalQuestion(completedStep, nextPhase),
              createdAt: new Date().toISOString(),
            },
          ],
          taskState: touchTaskState({
            ...completedTaskState,
            currentStepId: completedStep.id,
            isPaused: true,
            expectedAction: createStageTransitionExpectedAction(completedStep, nextPhase),
          }),
          updatedAt: new Date().toISOString(),
        },
        parentChat.fileName,
      );
      return;
    }

    parentChat = await persistAndReplaceSavedChat(
      {
        ...parentChat,
        messages: [
          ...parentChat.messages,
          {
            role: "assistant",
            content: createAutoStageTransitionMessage(completedStep, nextPhase),
            createdAt: new Date().toISOString(),
          },
        ],
        taskState: touchTaskState(createStageTransitionState(completedTaskState)),
        updatedAt: new Date().toISOString(),
      },
      parentChat.fileName,
    );

    if (!nextPhase || nextPhase === "done") {
      return;
    }
  }
}

async function appendAssistantMessageToSavedChat(savedChat: SavedChat, content: string) {
  return persistAndReplaceSavedChat(
    {
      ...savedChat,
      messages: [
        ...savedChat.messages,
        {
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
    },
    savedChat.fileName,
  );
}

async function markSavedStepInProgress(parentChat: SavedChat, taskState: TaskState, step: TaskStep) {
  return persistAndReplaceSavedChat(
    {
      ...parentChat,
      taskState: touchTaskState({
        ...taskState,
        phase: step.phase || taskState.phase,
        currentStepId: step.id,
        isPaused: false,
        expectedAction: `Агент этапа ${step.phase || taskState.phase} выполняет свою часть задачи.`,
        steps: taskState.steps.map((item) =>
          item.id === step.id
            ? {
                ...item,
                status: "in_progress",
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      }),
      updatedAt: new Date().toISOString(),
    },
    parentChat.fileName,
  );
}

async function ensureSavedStepAgentChat(parentChat: SavedChat, taskState: TaskState, step: TaskStep) {
  if (step.agentDialogId) {
    const existingAgentChat = savedChats.find((chat) => chat.id === step.agentDialogId);

    if (existingAgentChat?.agent?.role === "step_agent") {
      return existingAgentChat;
    }
  }

  const now = new Date().toISOString();
  const childChatDraft: SavedChat = {
    id: createChatId(),
    title: `Агент: ${step.title}`,
    messages: [
      {
        role: "user",
        content: createStepAgentPrompt(
          parentChat.title,
          getParentTaskBriefFromMessages(parentChat.messages, parentChat.title),
          taskState,
          step,
        ),
        createdAt: now,
      },
    ],
    metadata: {
      ...parentChat.metadata,
      tokenUsage: createEmptyTokenUsage(),
    },
    agent: {
      role: "step_agent",
      parentChatId: parentChat.id,
      stepId: step.id,
    },
    createdAt: now,
    updatedAt: now,
  };
  const savedChildChat = await persistAndReplaceSavedChat(childChatDraft);
  const updatedTaskState = normalizeTaskState(parentChat.taskState || taskState);
  const nextParentChat = await persistAndReplaceSavedChat(
    {
      ...parentChat,
      taskState: touchTaskState({
        ...updatedTaskState,
        steps: updatedTaskState.steps.map((item) =>
          item.id === step.id
            ? {
                ...item,
                agentDialogId: savedChildChat.id,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      }),
      updatedAt: new Date().toISOString(),
    },
    parentChat.fileName,
  );

  return savedChats.find((chat) => chat.id === savedChildChat.id) || savedChildChat;
}

async function runSavedStepAgent(parentChat: SavedChat, step: TaskStep) {
  const parentTaskState = normalizeTaskState(parentChat.taskState || createInitialTaskState());
  const activeStep = parentTaskState.steps.find((item) => item.id === step.id) || step;
  const agentChat = await ensureSavedStepAgentChat(parentChat, parentTaskState, activeStep);

  if (agentChat.agent?.role !== "step_agent") {
    throw new Error("Не удалось создать дочерний диалог агента.");
  }

  const apiMessages: ChatMessage[] = agentChat.messages.map(({ role, content }) => ({ role, content }));
  const memoryAwareSettings = createMemoryAwareSettings(
    createSettingsForSavedChat(parentChat),
    userProfile,
    longTermMemory,
    projectMemory,
    createStepAgentTaskContext(agentChat.agent, parentTaskState, activeStep),
  );
  const result = await requestChatCompletion(apiMessages, memoryAwareSettings);
  const usage = result.usage;
  const completedAgentMessages = usage
    ? agentChat.messages.map((message, index) =>
        index === agentChat.messages.length - 1 ? { ...message, tokenUsage: createPromptTokenUsage(usage) } : message,
      )
    : agentChat.messages;
  const savedAgentChat = await persistAndReplaceSavedChat(
    addSavedChatTokenUsage(
      {
        ...agentChat,
        messages: [
          ...completedAgentMessages,
          {
            role: "assistant",
            content: result.content,
            createdAt: new Date().toISOString(),
            ...(usage ? { tokenUsage: createCompletionTokenUsage(usage) } : {}),
          },
        ],
        updatedAt: new Date().toISOString(),
      },
      usage,
    ),
    agentChat.fileName,
  );
  await appendSavedChatLog(savedAgentChat, [createExchangeLogEntry(result.exchangeLog)]).catch(() => undefined);

  const artifactFiles = extractArtifactFiles(result.content);
  const persistedArtifacts = await persistArtifactFiles(parentChat.id, artifactFiles);
  const artifactPaths = persistedArtifacts.map((artifact) => artifact.path);
  const summary = result.content.trim() || "Агент завершил шаг без текстового отчета.";
  const currentState = normalizeTaskState(parentChat.taskState || createInitialTaskState());
  const nextParentChat = await persistAndReplaceSavedChat(
    addSavedChatTokenUsage(
      {
        ...parentChat,
        taskState: touchTaskState({
          ...currentState,
          currentStepId: step.id,
          steps: currentState.steps.map((item) =>
            item.id === step.id
              ? {
                  ...item,
                  status: "done" as TaskStepStatus,
                  artifactPaths,
                  resultSummary: summary.length > 700 ? `${summary.slice(0, 700).trim()}...` : summary,
                  agentDialogId: savedAgentChat.id,
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
        }),
        updatedAt: new Date().toISOString(),
      },
      usage,
    ),
    parentChat.fileName,
  );

  return {
    agentChat: savedAgentChat,
    parentChat: nextParentChat,
  };
}

async function flushPendingLogEntries(savedChat: SavedChat) {
  if (pendingLogEntries.length === 0) {
    return true;
  }

  const entries = pendingLogEntries;

  try {
    await appendSavedChatLog(savedChat, entries);
    pendingLogEntries = pendingLogEntries.slice(entries.length);
    return true;
  } catch (error) {
    storageStatus = error instanceof Error ? `Диалог сохранен, но лог не записан: ${error.message}` : "Диалог сохранен, но лог не записан.";
    return false;
  }
}

async function autosaveActiveChat() {
  if (!activeSavedChatId) {
    return;
  }

  try {
    await saveCurrentChat(currentChatTitle);
  } catch (error) {
    storageStatus = error instanceof Error ? error.message : "Не удалось обновить файл диалога.";
    renderSavedChats();
  }
}

async function clearSavedChats() {
  if (savedChats.length === 0) {
    return;
  }

  const shouldClear = confirm("Удалить все сохраненные диалоги?");

  if (!shouldClear) {
    return;
  }

  try {
    await deleteSavedChatFiles(savedChats);
  } catch (error) {
    storageStatus = error instanceof Error ? error.message : "Не удалось удалить файлы диалогов.";
    renderSavedChats();
    return;
  }

  savedChats = [];
  activeSavedChatId = null;
  currentChatTitle = "Новый диалог";
  currentTokenUsage = createEmptyTokenUsage();
  pendingLogEntries = [];
  isDialogsDirectoryConnected = true;
  currentTaskState = createInitialTaskState();
  currentAgentMetadata = { role: "orchestrator" };
  storageStatus = "Файлы диалогов удалены";
  renderSavedChats();
  renderTaskState();
  renderMessages();
  messageInput.focus();
}

function openSavedChat(id: string) {
  const savedChat = savedChats.find((chat) => chat.id === id);

  if (!savedChat) {
    return;
  }

  activeRequest?.abort();
  activeRequest = null;
  activeSavedChatId = savedChat.id;
  currentChatTitle = savedChat.title;
  pendingLogEntries = [];
  messages = savedChat.messages.map((message) => ({ ...message }));
  currentAgentMetadata = savedChat.agent || { role: "orchestrator" };
  currentTaskState = currentAgentMetadata.role === "orchestrator" ? savedChat.taskState || createInitialTaskState() : null;
  applySavedMetadata(savedChat.metadata, savedChat.messages);
  setSending(false);
  renderSavedChats();
  renderTaskState();
  renderMessages();
  messageInput.focus();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMessageContent(message: UiChatMessage) {
  if (message.role !== "assistant") {
    return `<p>${escapeHtml(message.content)}</p>`;
  }

  return renderMarkdown(message.content);
}

function renderMessageUsage(message: UiChatMessage) {
  if (!message.tokenUsage) {
    return "";
  }

  const cost = calculateTokenCost(message.tokenUsage, settings.model);
  const tokens = message.role === "user" ? message.tokenUsage.promptTokens : message.tokenUsage.completionTokens;
  const price = message.role === "user" ? cost.prompt : cost.completion;

  if (tokens === 0) {
    return "";
  }

  return `<span class="message-usage">${formatTokenCount(tokens)} токенов · ${escapeHtml(formatCost(price))}</span>`;
}

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function handleSettingsEvent(event: Event) {
  const target = event.target;

  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
    return;
  }

  if (target.dataset.customModel !== undefined) {
    return;
  }

  if (target.dataset.modelParameterFilter !== undefined) {
    modelParameterFilter = target.value;
    renderModelDialog();
    return;
  }

  if (target.dataset.modelCostFilter !== undefined) {
    modelCostFilter = target.value;
    renderModelDialog();
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.askBetweenStages !== undefined) {
    void setAskBeforeStageTransition(target.checked).catch((error) => {
      storageStatus = error instanceof Error ? error.message : "Не удалось сохранить настройку переходов.";
      renderSavedChats();
      renderTaskState();
    });
    return;
  }

  const settingName = target.dataset.setting;

  if (settingName && isChatSettingsKey(settingName)) {
    updateSetting(settingName, target.value);
    renderCurrentDialogInfo();
  }
}

appRoot.addEventListener("input", handleSettingsEvent);
appRoot.addEventListener("change", handleSettingsEvent);

appRoot.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof Element)) {
    return;
  }

  const button = target.closest("button");

  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  if (button.dataset.action === "save") {
    openSaveDialog();
    return;
  }

  if (button.dataset.action === "create-orchestrator-dialog") {
    void createOrchestratorDialog().catch((error) => {
      storageStatus = error instanceof Error ? error.message : "Не удалось создать диалог оркестратора.";
      renderSavedChats();
    });
    return;
  }

  if (button.dataset.action === "select-dialogs-directory") {
    void selectStorageDirectory();
    return;
  }

  if (button.dataset.action === "open-provider-dialog") {
    providerDialog.showModal();
    return;
  }

  if (button.dataset.action === "open-model-dialog") {
    void openModelDialog();
    return;
  }

  if (button.dataset.action === "open-user-profile") {
    openUserProfileDialog();
    return;
  }

  if (button.dataset.action === "open-project-memory") {
    openMemoryDialog("project");
    return;
  }

  if (button.dataset.action === "open-long-term-memory") {
    openMemoryDialog("longTerm");
    return;
  }

  if (button.dataset.action === "close-provider-dialog") {
    providerDialog.close();
    return;
  }

  if (button.dataset.action === "select-provider" && isProviderId(button.dataset.providerId)) {
    selectProvider(button.dataset.providerId);
    return;
  }

  if (button.dataset.action === "close-model-dialog") {
    modelDialog.close();
    return;
  }

  if (button.dataset.action === "refresh-models") {
    void loadProviderModels();
    return;
  }

  if (button.dataset.action === "select-model" && button.dataset.modelId) {
    selectModel(button.dataset.modelId);
    return;
  }

  if (button.dataset.action === "select-custom-model") {
    const modelId = customModelInput.value.trim();

    if (!modelId) {
      customModelInput.focus();
      return;
    }

    selectModel(modelId);
    return;
  }

  if (button.dataset.action === "cancel-save") {
    saveDialog.close();
    return;
  }

  if (button.dataset.action === "cancel-memory-edit") {
    memoryDialog.close();
    activeMemoryKind = null;
    return;
  }

  if (button.dataset.action === "cancel-profile-edit") {
    profileDialog.close();
    return;
  }

  if (button.dataset.action === "open-saved-dialog" && button.dataset.dialogId) {
    openSavedChat(button.dataset.dialogId);
    return;
  }

  if (button.dataset.action === "clear-saved-dialogs") {
    void clearSavedChats();
    return;
  }

  if (button.dataset.action === "open-parent-dialog") {
    const parentChat = getParentChatForAgent(currentAgentMetadata);

    if (parentChat) {
      openSavedChat(parentChat.id);
    }

    return;
  }

  if (button.dataset.action === "clear") {
    activeRequest?.abort();
    activeRequest = null;
    messages = [];
    activeSavedChatId = null;
    currentChatTitle = "Новый диалог";
    currentTokenUsage = createEmptyTokenUsage();
    pendingLogEntries = [];
    currentTaskState = createInitialTaskState();
    currentAgentMetadata = { role: "orchestrator" };
    setSending(false);
    renderSavedChats();
    renderTaskState();
    renderMessages();
    messageInput.focus();
  }
});

saveDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const title = saveTitleInput.value.trim();

  if (!title) {
    saveTitleInput.focus();
    return;
  }

  void (async () => {
    if (!isFileStorageSupported()) {
      saveDialogStatusElement.textContent = "Этот браузер не умеет сохранять диалоги в папку.";
      return;
    }

    if (!isDialogsDirectoryConnected) {
      saveDialogStatusElement.textContent = "Выберите папку, внутри нее будет создана папка dialogs.";
      const isConnected = await selectStorageDirectory();

      if (!isConnected) {
        saveDialogStatusElement.textContent = "Папка не выбрана, диалог не сохранен.";
        return;
      }
    }

    saveDialogStatusElement.textContent = "Сохраняю файл диалога...";
    await saveCurrentChat(title);
    saveDialog.close();
  })().catch((error) => {
      storageStatus = error instanceof Error ? error.message : "Не удалось сохранить файл диалога.";
      saveDialogStatusElement.textContent = storageStatus;
      renderSavedChats();
  });
});

memoryDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();

  void saveActiveMemoryDocument().catch((error) => {
    memoryDialogStatusElement.textContent = error instanceof Error ? error.message : "Не удалось сохранить память.";
    renderSavedChats();
    renderMemoryControls();
  });
});

profileDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();

  void saveUserProfile().catch((error) => {
    profileDialogStatusElement.textContent = error instanceof Error ? error.message : "Не удалось сохранить профиль.";
    renderSavedChats();
    renderMemoryControls();
  });
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (isSending) {
    return;
  }

  const prompt = messageInput.value.trim();
  const isUserResponseToPausedStepAgent =
    currentAgentMetadata.role === "step_agent" && !!prompt && getStepForAgent(currentAgentMetadata)?.status === "blocked";

  if (!prompt) {
    messageInput.focus();
    return;
  }

  if (currentAgentMetadata.role === "orchestrator") {
    const taskState = ensureCurrentTaskState();
    const isStageApproval = isWaitingForStageApproval(taskState);
    const userApprovedStage = isStageApproval && isUserApproval(prompt);
    messages = [
      ...messages,
      { role: "user", content: prompt, createdAt: new Date().toISOString() },
    ];
    messageInput.value = "";

    if (userApprovedStage) {
      setCurrentTaskState(createStageTransitionState(taskState));
      messages = [
        ...messages,
        {
          role: "assistant",
          content: createStageTransitionConfirmationMessage(taskState),
          createdAt: new Date().toISOString(),
        },
      ];
    } else if (isStageApproval) {
      setCurrentTaskState({
        ...taskState,
        isPaused: true,
        expectedAction: "Получить подтверждение или правки перед передачей следующему агенту.",
      });
      messages = [
        ...messages,
        {
          role: "assistant",
          content: "Понял. Оставляю переход на паузе. Напишите подтверждение, когда можно передавать дальше, или сформулируйте правки для текущего этапа.",
          createdAt: new Date().toISOString(),
        },
      ];
      await saveActiveTaskState();
      renderMessages();
      messageInput.focus();
      return;
    } else if (taskState.isPaused) {
      const currentStep = getCurrentStep(taskState);
      setCurrentTaskState({
        ...taskState,
        isPaused: false,
        expectedAction: currentStep
          ? `Продолжить этап: ${currentStep.title}`
          : "Продолжить оркестрацию после ответа пользователя.",
      });
    } else if (messages.length === 1) {
      messages = [
        ...messages,
        {
          role: "assistant",
          content: getOrchestratorNextActionMessage(taskState),
          createdAt: new Date().toISOString(),
        },
      ];
    }

    setSending(true);
    renderMessages();

    try {
      if (!activeSavedChatId) {
        const isConnected = await ensureStorageDirectoryConnected();

        if (!isConnected) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content:
                storageStatus ||
                "Сначала выберите папку для файлов диалогов, чтобы оркестратор мог сохранить состояние и запустить дочерних агентов.",
              createdAt: new Date().toISOString(),
            },
          ];
          return;
        }

        await saveCurrentChat(getDefaultChatTitle());
      } else {
        await autosaveActiveChat();
      }

      if (activeSavedChatId) {
        startBackgroundWorkflow(activeSavedChatId);
      }
    } catch (error) {
      storageStatus = error instanceof Error ? error.message : "Не удалось запустить агентный workflow.";
      messages = [
        ...messages,
        {
          role: "assistant",
          content: storageStatus,
          createdAt: new Date().toISOString(),
        },
      ];
      renderSavedChats();
    } finally {
      setSending(false);
      renderTaskState();
      renderMessages();
      messageInput.focus();
    }

    return;
  }

  if (!settings.apiKey.trim()) {
    const providerLabel = getProviderConfig(settings.provider).label;
    messages = [
      ...messages,
      {
        role: "assistant",
        content: `Добавьте ${providerLabel} API key в .env.local или во временное поле API key.`,
        createdAt: new Date().toISOString(),
      },
    ];
    renderMessages();
    return;
  }

  if (!activeSavedChatId) {
    const isConnected = await ensureStorageDirectoryConnected();

    if (!isConnected) {
      messageInput.focus();
      return;
    }
  }

  const nextMessages: UiChatMessage[] = [...messages, { role: "user", content: prompt, createdAt: new Date().toISOString() }];
  messages = nextMessages;
  messageInput.value = "";
  setSending(true);
  renderMessages();

  if (!activeSavedChatId) {
    try {
      await saveCurrentChat(getDefaultChatTitle());
    } catch (error) {
      storageStatus = error instanceof Error ? error.message : "Не удалось создать файл текущего диалога.";
      setSending(false);
      renderSavedChats();
      renderMessages();
      messageInput.focus();
      return;
    }
  }

  activeRequest = new AbortController();

  try {
    const apiMessages: ChatMessage[] = nextMessages.map(({ role, content }) => ({ role, content }));
    const memoryAwareSettings = createMemoryAwareSettings(
      settings,
      userProfile,
      longTermMemory,
      projectMemory,
      getPromptTaskContext(),
    );
    const result = await requestChatCompletion(apiMessages, memoryAwareSettings, activeRequest.signal);
    queueExchangeLog(result.exchangeLog);
    let completedMessages = nextMessages;

    const usage = result.usage;

    if (usage) {
      currentTokenUsage = addTokenUsage(currentTokenUsage, usage);
      completedMessages = nextMessages.map((message, index) =>
        index === nextMessages.length - 1 ? { ...message, tokenUsage: createPromptTokenUsage(usage) } : message,
      );
    }

    messages = [
      ...completedMessages,
      {
        role: "assistant",
        content: result.content,
        createdAt: new Date().toISOString(),
        ...(usage ? { tokenUsage: createCompletionTokenUsage(usage) } : {}),
      },
    ];

    const isAssistantWaitingForUser = shouldPauseForAssistantQuestion(result.content);

    if (currentAgentMetadata.role === "step_agent") {
      const agentMetadata = currentAgentMetadata;

      if (isAssistantWaitingForUser) {
        await updateParentTaskStateFromStepAgent(
          agentMetadata,
          "blocked",
          `Ответить в дочернем диалоге "${currentChatTitle}": ${getPauseExpectedActionFromAssistant(result.content)}`,
          true,
        );
      } else if (isUserResponseToPausedStepAgent) {
        await updateParentTaskStateFromStepAgent(
          agentMetadata,
          "in_progress",
          `Дождаться результата агента шага в диалоге "${currentChatTitle}".`,
          false,
        );
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }

    const exchangeLog = getProviderExchangeLog(error);

    if (exchangeLog) {
      queueExchangeLog(exchangeLog, error instanceof Error ? error.message : "Не удалось получить ответ от AI API.");
    }

    messages = [
      ...nextMessages,
      {
        role: "assistant",
        content: error instanceof Error ? error.message : "Не удалось получить ответ от AI API.",
        createdAt: new Date().toISOString(),
      },
    ];
  } finally {
    activeRequest = null;
    setSending(false);
    renderMessages();
    void autosaveActiveChat();
    messageInput.focus();
  }
});

syncSettingsForm();
renderSavedChats();
renderMemoryControls();
renderTaskState();
void hydrateSavedChats();
renderMessages();
