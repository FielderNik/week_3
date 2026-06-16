import "./styles.css";
import { createMemoryAwareSettings, emptyMemoryDocument, emptyUserProfile } from "./memory";
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
  persistLongTermMemory,
  persistProjectMemory,
  persistUserProfile,
  persistSavedChat,
  selectDialogsDirectory,
} from "./storage";
import type {
  AiExchangeLogEntry,
  ChatMessage,
  ChatSettings,
  MemoryDocument,
  ProviderId,
  ProviderModel,
  SavedChat,
  SavedChatMetadata,
  TokenUsage,
  UiChatMessage,
  UserProfile,
} from "./types";

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

type MemoryKind = "project" | "longTerm";

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

  savedDialogsContainer.innerHTML = savedChats
    .map((chat) => {
      const isActive = chat.id === activeSavedChatId;
      const messagesCount = chat.messages.length;
      const tokenUsage = getSavedTokenUsage(chat.metadata, chat.messages);

      return `
        <button
          class="saved-dialog-item${isActive ? " is-active" : ""}"
          data-action="open-saved-dialog"
          data-dialog-id="${escapeHtml(chat.id)}"
          type="button"
        >
          <strong>${escapeHtml(chat.title)}</strong>
          <span>${formatSavedChatDate(chat.updatedAt)} · ${messagesCount} ${getMessagesWord(messagesCount)}</span>
          <small>${escapeHtml(getSavedProviderLabel(chat.metadata))} · ${escapeHtml(chat.metadata.model)} · ${formatTokenCount(tokenUsage.totalTokens)} токенов</small>
        </button>
      `;
    })
    .join("");
}

function renderMemoryControls() {
  userProfileStatusElement.textContent = formatUserProfileStatus(userProfile);
  projectMemoryStatusElement.textContent = formatMemoryStatus(projectMemory);
  longTermMemoryStatusElement.textContent = formatMemoryStatus(longTermMemory);
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

  if (messages.length === 0) {
    messagesContainer.innerHTML = `
      <div class="empty-state">
        <h2>С чего начнем?</h2>
        <p>Шаблон готов отправлять сообщения через выбранный AI-провайдер.</p>
      </div>
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

  messagesContainer.innerHTML = renderedMessages + typingIndicator;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function setSending(nextValue: boolean) {
  isSending = nextValue;
  sendButton.textContent = nextValue ? "Отправка..." : "Отправить";
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
  pendingLogEntries = [
    ...pendingLogEntries,
    {
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
    },
  ];
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
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return false;
    }

    isDialogsDirectoryConnected = false;
    storageStatus = error instanceof Error ? error.message : "Не удалось выбрать папку.";
    renderSavedChats();
    renderMemoryControls();
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
  const savedChatDraft: SavedChat = {
    id: existingChat?.id || createChatId(),
    title,
    messages: messages.map((message) => ({ ...message })),
    metadata: getSettingsMetadata(),
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
  renderMessages();
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
  storageStatus = "Файлы диалогов удалены";
  renderSavedChats();
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
  applySavedMetadata(savedChat.metadata, savedChat.messages);
  setSending(false);
  renderSavedChats();
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

  if (button.dataset.action === "clear") {
    activeRequest?.abort();
    activeRequest = null;
    messages = [];
    activeSavedChatId = null;
    currentChatTitle = "Новый диалог";
    currentTokenUsage = createEmptyTokenUsage();
    pendingLogEntries = [];
    setSending(false);
    renderSavedChats();
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

  if (!prompt) {
    messageInput.focus();
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

  const nextMessages: UiChatMessage[] = [
    ...messages,
    { role: "user", content: prompt, createdAt: new Date().toISOString() },
  ];
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
    const memoryAwareSettings = createMemoryAwareSettings(settings, userProfile, longTermMemory, projectMemory);
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
void hydrateSavedChats();
renderMessages();
