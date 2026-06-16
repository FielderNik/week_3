import type {
  AiExchangeLogEntry,
  MemoryDocument,
  SavedChat,
  SavedChatMetadata,
  TokenUsage,
  UiChatMessage,
  UserProfile,
} from "./types";

const databaseName = "chat-template-file-storage";
const databaseVersion = 1;
const handlesStoreName = "handles";
const dialogsDirectoryHandleKey = "dialogs-directory";
const dialogsDirectoryName = "dialogs";
const projectMemoryFileName = "project-memory.json";
const longTermMemoryFileName = "long-term-memory.json";
const userProfileFileName = "user-profile.json";

type FileStorageWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

type FileStorageDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  values: () => AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
};

export function isFileStorageSupported() {
  return typeof (window as FileStorageWindow).showDirectoryPicker === "function";
}

export async function hasDialogsDirectory() {
  return (await getPersistedDialogsDirectory()) !== null;
}

export async function loadSavedChats() {
  const directory = await getPersistedDialogsDirectory();

  if (!directory) {
    return [];
  }

  return readSavedChatsFromDirectory(directory);
}

export async function selectDialogsDirectory() {
  const picker = (window as FileStorageWindow).showDirectoryPicker;

  if (!picker) {
    throw new Error("Браузер не поддерживает выбор папки для сохранения файлов.");
  }

  const rootDirectory = await picker({ mode: "readwrite" });
  const dialogsDirectory = await rootDirectory.getDirectoryHandle(dialogsDirectoryName, { create: true });
  await persistDialogsDirectory(dialogsDirectory);

  return readSavedChatsFromDirectory(dialogsDirectory, { requestPermission: true });
}

export async function loadProjectMemory() {
  return loadMemoryDocument(projectMemoryFileName);
}

export async function persistProjectMemory(content: string) {
  return persistMemoryDocument(projectMemoryFileName, content);
}

export async function loadLongTermMemory() {
  return loadMemoryDocument(longTermMemoryFileName);
}

export async function persistLongTermMemory(content: string) {
  return persistMemoryDocument(longTermMemoryFileName, content);
}

export async function loadUserProfile() {
  const directory = await getPersistedDialogsDirectory();

  if (!directory) {
    return createEmptyUserProfile();
  }

  try {
    const file = await directory.getFileHandle(userProfileFileName);
    const parsed = JSON.parse(await file.getFile().then((value) => value.text())) as unknown;
    return isUserProfile(parsed) ? parsed : createEmptyUserProfile();
  } catch {
    return createEmptyUserProfile();
  }
}

export async function persistUserProfile(userProfile: Omit<UserProfile, "updatedAt">): Promise<UserProfile> {
  const directory = await getPersistedDialogsDirectory({ requestPermission: true });

  if (!directory) {
    throw new Error("Сначала выберите папку для файлов памяти.");
  }

  const nextUserProfile: UserProfile = {
    ...userProfile,
    updatedAt: new Date().toISOString(),
  };
  const file = await directory.getFileHandle(userProfileFileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(nextUserProfile, null, 2));
  await writable.close();

  return nextUserProfile;
}

export async function persistSavedChat(savedChat: SavedChat, previousFileName?: string) {
  const directory = await getPersistedDialogsDirectory({ requestPermission: true });

  if (!directory) {
    throw new Error("Сначала выберите папку для файлов диалогов.");
  }

  const fileName = createSavedChatFileName(savedChat);
  const nextChat = {
    ...savedChat,
    fileName,
  };

  if (previousFileName && previousFileName !== fileName) {
    await directory.removeEntry(previousFileName).catch(() => undefined);
    await moveSavedChatLog(directory, previousFileName, fileName);
  }

  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(nextChat, null, 2));
  await writable.close();

  return nextChat;
}

export async function appendSavedChatLog(savedChat: SavedChat, logEntries: AiExchangeLogEntry[]) {
  if (logEntries.length === 0) {
    return;
  }

  const directory = await getPersistedDialogsDirectory({ requestPermission: true });

  if (!directory) {
    throw new Error("Сначала выберите папку для файлов диалогов.");
  }

  const logFileName = createSavedChatLogFileName(savedChat.fileName || createSavedChatFileName(savedChat));
  const file = await directory.getFileHandle(logFileName, { create: true });
  const currentContent = await file
    .getFile()
    .then((value) => value.text())
    .catch(() => "");
  const nextContent = `${currentContent}${logEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const writable = await file.createWritable();
  await writable.write(nextContent);
  await writable.close();
}

export async function deleteSavedChatFiles(savedChats: SavedChat[]) {
  const directory = await getPersistedDialogsDirectory({ requestPermission: true });

  if (!directory) {
    return;
  }

  await Promise.all(
    savedChats.flatMap((chat) => {
      const fileName = chat.fileName || createSavedChatFileName(chat);
      return [
        directory.removeEntry(fileName).catch(() => undefined),
        directory.removeEntry(createSavedChatLogFileName(fileName)).catch(() => undefined),
      ];
    }),
  );
}

async function readSavedChatsFromDirectory(
  directory: FileSystemDirectoryHandle,
  options: { requestPermission?: boolean } = {},
) {
  await ensureReadWritePermission(directory, options);

  const savedChats: SavedChat[] = [];

  for await (const entry of toFileStorageDirectory(directory).values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) {
      continue;
    }

    if (entry.name === projectMemoryFileName || entry.name === longTermMemoryFileName || entry.name === userProfileFileName) {
      continue;
    }

    try {
      const file = await entry.getFile();
      const parsed = JSON.parse(await file.text()) as unknown;

      if (isSavedChat(parsed)) {
        savedChats.push({
          ...parsed,
          fileName: parsed.fileName || entry.name,
        });
      }
    } catch {
      // Один поврежденный JSON не должен ломать загрузку всей истории.
    }
  }

  return savedChats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function loadMemoryDocument(fileName: string): Promise<MemoryDocument> {
  const directory = await getPersistedDialogsDirectory();

  if (!directory) {
    return createEmptyMemoryDocument();
  }

  try {
    const file = await directory.getFileHandle(fileName);
    const parsed = JSON.parse(await file.getFile().then((value) => value.text())) as unknown;
    return isMemoryDocument(parsed) ? parsed : createEmptyMemoryDocument();
  } catch {
    return createEmptyMemoryDocument();
  }
}

async function persistMemoryDocument(fileName: string, content: string): Promise<MemoryDocument> {
  const directory = await getPersistedDialogsDirectory({ requestPermission: true });

  if (!directory) {
    throw new Error("Сначала выберите папку для файлов памяти.");
  }

  const memoryDocument: MemoryDocument = {
    content,
    updatedAt: new Date().toISOString(),
  };
  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(memoryDocument, null, 2));
  await writable.close();

  return memoryDocument;
}

function createEmptyMemoryDocument(): MemoryDocument {
  return {
    content: "",
    updatedAt: "",
  };
}

function createEmptyUserProfile(): UserProfile {
  return {
    displayName: "",
    context: "",
    stylePreferences: "",
    formatPreferences: "",
    restrictions: "",
    updatedAt: "",
  };
}

async function getPersistedDialogsDirectory(options: { requestPermission?: boolean } = {}) {
  if (!isFileStorageSupported()) {
    return null;
  }

  const directory = await readPersistedDialogsDirectory();

  if (!directory) {
    return null;
  }

  const hasPermission = await hasReadWritePermission(directory, options);
  return hasPermission ? directory : null;
}

async function hasReadWritePermission(
  directory: FileSystemDirectoryHandle,
  options: { requestPermission?: boolean } = {},
) {
  const handle = toFileStorageDirectory(directory);
  const queryResult = await handle.queryPermission({ mode: "readwrite" });

  if (queryResult === "granted") {
    return true;
  }

  if (!options.requestPermission) {
    return false;
  }

  const requestResult = await handle.requestPermission({ mode: "readwrite" });
  return requestResult === "granted";
}

async function ensureReadWritePermission(
  directory: FileSystemDirectoryHandle,
  options: { requestPermission?: boolean } = {},
) {
  const isAllowed = await hasReadWritePermission(directory, options);

  if (!isAllowed) {
    throw new Error("Нет доступа к папке с файлами диалогов.");
  }
}

function createSavedChatFileName(savedChat: SavedChat) {
  const baseName = slugifyFileName(savedChat.title || savedChat.id);
  const shortId = savedChat.id.slice(0, 8);
  return `${baseName}-${shortId}.json`;
}

function createSavedChatLogFileName(fileName: string) {
  return fileName.endsWith(".json") ? fileName.replace(/\.json$/, ".logs.jsonl") : `${fileName}.logs.jsonl`;
}

async function moveSavedChatLog(directory: FileSystemDirectoryHandle, previousFileName: string, nextFileName: string) {
  const previousLogFileName = createSavedChatLogFileName(previousFileName);
  const nextLogFileName = createSavedChatLogFileName(nextFileName);

  if (previousLogFileName === nextLogFileName) {
    return;
  }

  try {
    const previousFile = await directory.getFileHandle(previousLogFileName);
    const content = await previousFile.getFile().then((file) => file.text());
    const nextFile = await directory.getFileHandle(nextLogFileName, { create: true });
    const writable = await nextFile.createWritable();
    await writable.write(content);
    await writable.close();
    await directory.removeEntry(previousLogFileName).catch(() => undefined);
  } catch {
    // Лога у старого файла могло еще не быть.
  }
}

function slugifyFileName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[/\\?%*:|"<>]/g, "")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  return normalized.slice(0, 64) || "dialog";
}

function toFileStorageDirectory(directory: FileSystemDirectoryHandle) {
  return directory as FileStorageDirectoryHandle;
}

async function readPersistedDialogsDirectory() {
  const database = await openStorageDatabase();

  return new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    const transaction = database.transaction(handlesStoreName, "readonly");
    const store = transaction.objectStore(handlesStoreName);
    const request = store.get(dialogsDirectoryHandleKey);

    request.addEventListener("success", () => {
      resolve((request.result as FileSystemDirectoryHandle | undefined) || null);
      database.close();
    });
    request.addEventListener("error", () => {
      reject(request.error);
      database.close();
    });
  });
}

async function persistDialogsDirectory(directory: FileSystemDirectoryHandle) {
  const database = await openStorageDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(handlesStoreName, "readwrite");
    const store = transaction.objectStore(handlesStoreName);
    const request = store.put(directory, dialogsDirectoryHandleKey);

    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  });

  database.close();
}

function openStorageDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(handlesStoreName);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function isSavedChat(value: unknown): value is SavedChat {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SavedChat>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    (candidate.fileName === undefined || typeof candidate.fileName === "string") &&
    Array.isArray(candidate.messages) &&
    candidate.messages.every(isUiChatMessage) &&
    isSavedChatMetadata(candidate.metadata) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function isUiChatMessage(value: unknown): value is UiChatMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<UiChatMessage>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    typeof candidate.createdAt === "string" &&
    (candidate.tokenUsage === undefined || isTokenUsage(candidate.tokenUsage))
  );
}

function isSavedChatMetadata(value: unknown): value is SavedChatMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SavedChatMetadata>;
  return (
    typeof candidate.provider === "string" &&
    typeof candidate.baseUrl === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.systemPrompt === "string" &&
    typeof candidate.temperature === "number" &&
    typeof candidate.topP === "number" &&
    typeof candidate.maxTokens === "number" &&
    (candidate.responseFormat === "text" || candidate.responseFormat === "json_object") &&
    typeof candidate.stopSequences === "string" &&
    (candidate.thinkingMode === "enabled" || candidate.thinkingMode === "disabled") &&
    (candidate.reasoningEffort === "high" || candidate.reasoningEffort === "max") &&
    (candidate.tokenUsage === undefined || isTokenUsage(candidate.tokenUsage))
  );
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TokenUsage>;
  return (
    typeof candidate.promptTokens === "number" &&
    typeof candidate.completionTokens === "number" &&
    typeof candidate.totalTokens === "number"
  );
}

function isMemoryDocument(value: unknown): value is MemoryDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<MemoryDocument>;
  return typeof candidate.content === "string" && typeof candidate.updatedAt === "string";
}

function isUserProfile(value: unknown): value is UserProfile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<UserProfile>;
  return (
    typeof candidate.displayName === "string" &&
    typeof candidate.context === "string" &&
    typeof candidate.stylePreferences === "string" &&
    typeof candidate.formatPreferences === "string" &&
    typeof candidate.restrictions === "string" &&
    typeof candidate.updatedAt === "string"
  );
}
