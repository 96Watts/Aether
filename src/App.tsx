import { Component, ErrorInfo, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, createContext, forwardRef, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { IconPicker, IconName, FOLDER_ICONS } from "./components/IconPicker";
import { UIIcons } from "./components/UIIcons";
import { appendAssistantPlaceholder, applyOwnedStreamEvent, buildContextMessages, contextSizeToTokens, hasActiveRequestForConversation, replaceEditedUserBranch, rollbackOwnedTurn, shouldHydrateConversation, stopOwnedTurn, type RequestOwnership } from "./conversationState";
import packageJson from "../package.json";
import "./App.css";

async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch (tauriError) {
    if (typeof navigator.clipboard?.writeText !== "function") throw tauriError;
    await navigator.clipboard.writeText(text);
  }
}

type NotificationKind = "error" | "warning" | "success" | "info";
type Notification = { id: number; kind: NotificationKind; title: string; description: string };
type NotificationInput = Omit<Notification, "id">;
type NotificationApi = { notify: (notification: NotificationInput) => void; dismiss: (id: number) => void };

const NotificationContext = createContext<NotificationApi | null>(null);

function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error("Notification system is unavailable");
  return context;
}

function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const timeoutRefs = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timeoutId = timeoutRefs.current.get(id);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      timeoutRefs.current.delete(id);
    }
    setNotifications((current) => current.filter((notification) => notification.id !== id));
  }, []);

  const notify = useCallback((notification: NotificationInput) => {
    const id = Date.now() + Math.random();
    setNotifications((current) => [...current, { ...notification, id }].slice(-4));
    if (notification.kind !== "error") {
      const timeoutId = window.setTimeout(() => dismiss(id), 5000);
      timeoutRefs.current.set(id, timeoutId);
    }
  }, [dismiss]);

  const api = useMemo(() => ({ notify, dismiss }), [dismiss, notify]);

  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      timeoutRefs.current.clear();
    };
  }, []);

  return <NotificationContext.Provider value={api}>
    {children}
    <div className="notification-stack" aria-live="polite" aria-atomic="false">
      {notifications.map((notification) => <div className={`notification notification-${notification.kind}`} key={notification.id} role={notification.kind === "error" ? "alert" : "status"}>
        <span className="notification-mark" aria-hidden="true">{notification.kind === "error" ? "!" : notification.kind === "success" ? "✓" : "i"}</span>
        <div className="notification-copy"><strong>{notification.title}</strong><p>{notification.description}</p></div>
        <button className="notification-dismiss" onClick={() => dismiss(notification.id)} aria-label={`Dismiss ${notification.title}`}>×</button>
      </div>)}
    </div>
  </NotificationContext.Provider>;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("Unexpected interface error", error, info);
  }

  render() {
    if (this.state.hasError) return <main className="error-screen"><div><span className="error-screen-mark">!</span><h1>Something went wrong</h1><p>The interface could not be displayed. Restart the app to try again.</p><button className="quiet-button" onClick={() => window.location.reload()}>Restart interface</button></div></main>;
    return this.props.children;
  }
}

type Message = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  reasoning?: string;
  modelType?: "Local" | "API";
  contextExcluded?: boolean;
};

type Provider = {
  id: string;
  name: string;
  detail: string;
  baseUrl: string;
  models: ProviderModel[];
  enabled: boolean;
  hasCredentials: boolean;
};

type ProviderModel = {
  id: string;
  name: string;
  providerId: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  capabilities: {
    supportsReasoning: boolean;
    supportsStreaming: boolean;
    supportsCancellation: boolean;
    supportsVision: boolean;
    supportsTools: boolean;
    supportsSystemPrompt: boolean;
    supportsTemperature: boolean;
  };
};

type LocalModel = {
  id: string;
  name: string;
  backend: string;
  sizeBytes: number | null;
  status: string;
  contextLength: number | null;
};

type RuntimeModelInfo = {
  id: string;
  name: string;
  backend: string;
  sizeBytes: number | null;
  path: string | null;
  detail: string;
  contextLength: number | null;
};

type RuntimeStatus = {
  id: string;
  name: string;
  available: boolean;
  detail: string;
  models: RuntimeModelInfo[];
};

type SystemInfoSnapshot = {
  osName: string | null;
  osVersion: string | null;
  kernel: string | null;
  hostName: string | null;
  uptimeSeconds: number;
  cpu: { name: string; brand: string; frequencyMhz: number; usagePercent: number } | null;
  cpuCount: number;
  physicalCores: number | null;
  totalMemoryBytes: number;
  usedMemoryBytes: number;
  totalDiskBytes: number;
  availableDiskBytes: number;
  networkInterfaces: string[];
  gpu: string | null;
};

type LogEntry = {
  timestamp: number;
  level: string;
  message: string;
};

type AiStreamEvent = {
  requestId: string;
  kind: "thinking" | "chunk" | "done" | "error";
  content: string | null;
  detail: string | null;
};

type PathValidationResult = {
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  readable: boolean;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  folderId?: string;
};

type ConversationSummary = Omit<Conversation, "messages">;

type ConversationIndex = {
  conversations: ConversationSummary[];
  folders: ConversationFolder[];
};

type ConversationFolder = {
  id: string;
  name: string;
  isOpen: boolean;
  conversationIds: string[];
  icon?: IconName;
};

type ContextMenuState = {
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
  placement: "up" | "down";
  type: "conversation" | "folder" | "empty";
  id?: string;
};

type ModelOption = {
  id: string;
  name: string;
  type: "Local" | "API";
  detail: string;
  backend?: string;
  providerId?: string;
  contextLength?: number | null;
};

type Theme = "dark" | "light" | "system";

type SettingsState = {
  theme: Theme;
  fontSize: "small" | "medium" | "large";
  density: "comfortable" | "compact";
  accent: "sage" | "blue" | "violet";
  enterToSend: boolean;
  showTimestamps: boolean;
  autoScroll: boolean;
  showReasoning: boolean;
  messageWidth: "narrow" | "wide";
  markdown: "on" | "plain";
  defaultModel: string;
  defaultProvider: string;
  modelParameters: "balanced" | "creative" | "precise";
  localOnly: boolean;
  telemetry: boolean;
  hardware: "auto" | "cpu" | "gpu";
  cpuThreads: string;
  contextSize: "4k" | "8k" | "16k" | "32k" | "64k" | "128k";
  modelLocation: string;
  downloadsLocation: string;
  attachments: "ask" | "allow" | "off";
  newChatShortcut: string;
  sidebarShortcut: string;
  composerShortcut: string;
  sendShortcut: string;
  developerMode: boolean;
  debugLogging: boolean;
  experimental: boolean;
  apiProviders: Provider[];
};

type ConfirmState = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

type DropdownOption = { value: string; label: string; description?: string };

const settingsCategories = ["Appearance", "Chat", "Models", "AI Providers", "Privacy", "Performance", "Files", "Shortcuts", "Advanced", "About"] as const;
type SettingsCategory = typeof settingsCategories[number];

const defaultSettings: SettingsState = {
  theme: "dark",
  fontSize: "medium",
  density: "comfortable",
  accent: "sage",
  enterToSend: true,
  showTimestamps: false,
  autoScroll: true,
  showReasoning: false,
  messageWidth: "wide",
  markdown: "on",
  defaultModel: "Qwen 3",
  defaultProvider: "local",
  modelParameters: "balanced",
  localOnly: false,
  telemetry: false,
  hardware: "auto",
  cpuThreads: "Auto",
  contextSize: "8k",
  modelLocation: "~/Models",
  downloadsLocation: "~/Downloads",
  attachments: "ask",
  newChatShortcut: "Ctrl + N",
  sidebarShortcut: "Ctrl + B",
  composerShortcut: "Ctrl + L",
  sendShortcut: "Enter",
  developerMode: false,
  debugLogging: false,
  experimental: false,
  apiProviders: [],
};

const performanceKeys: (keyof SettingsState)[] = ["hardware", "cpuThreads", "contextSize"];
const filesKeys: (keyof SettingsState)[] = ["modelLocation", "downloadsLocation"];

function identifyProvider(apiKey: string, baseUrl: string) {
  const key = apiKey.toLowerCase();
  const url = baseUrl.toLowerCase();

  if (key.startsWith("sk-ant-") || url.includes("anthropic")) return "Anthropic";
  if (key.startsWith("sk-or-") || url.includes("openrouter")) return "OpenRouter";
  if (key.startsWith("sk-") || key.startsWith("sk-proj-") || url.includes("openai") || url.includes("chatgpt")) return "ChatGPT";
  return "Custom API";
}

function titleFromPrompt(prompt: string) {
  const cleaned = prompt.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
  if (!cleaned) return "New conversation";
  const lower = cleaned.toLowerCase();
  const subject = cleaned.length > 43 ? `${cleaned.slice(0, 40).trim()}...` : cleaned;
  if (lower.startsWith("how do i ")) return `How to ${subject.slice(9)}`;
  if (lower.startsWith("how can i ")) return `How to ${subject.slice(10)}`;
  if (lower.startsWith("what is ")) return `About ${subject.slice(8)}`;
  if (lower.startsWith("can you ")) return subject.slice(8);
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${bytes} B`;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getFolderIconComponent(iconName?: IconName) {
  const iconData = FOLDER_ICONS.find((item) => item.name === iconName);
  return iconData?.icon || FOLDER_ICONS[0].icon;
}

function splitDirectories(value: string) {
  return value.split(";").map((part) => part.trim()).filter(Boolean);
}

function SettingsSection({ title, children, activeCategory, searchQuery, keywords = "" }: { title: SettingsCategory; children: ReactNode; activeCategory: SettingsCategory; searchQuery: string; keywords?: string }) {
  const matchesSearch = `${title} ${keywords}`.toLowerCase().includes(searchQuery.toLowerCase());
  if (searchQuery ? !matchesSearch : title !== activeCategory) return null;
  return <section className="settings-section"><h3>{title}</h3>{children}</section>;
}

function SettingsRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="setting-row"><span><strong>{label}</strong>{description && <small>{description}</small>}</span><div className="setting-control">{children}</div></div>;
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <button className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} aria-pressed={checked} aria-label={label} disabled={disabled}>{checked ? "On" : "Off"}</button>;
}

function Dropdown({ value, onChange, options, label, ariaLabel, disabled = false, align = "start", triggerClassName = "", triggerChildren, menuWidth = 224, onOpen }: {
  value: string | null;
  onChange: (value: string) => void;
  options: DropdownOption[];
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  align?: "start" | "end";
  triggerClassName?: string;
  triggerChildren?: ReactNode;
  menuWidth?: number;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; left: number; visible: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const margin = 8;
    const panelWidth = menu.offsetWidth || menuWidth;
    const panelHeight = menu.offsetHeight;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const fitsBelow = spaceBelow >= panelHeight;
    const fitsAbove = spaceAbove >= panelHeight;
    let placeUp = false;
    let top = rect.bottom + 6;
    if (!fitsBelow && fitsAbove) { placeUp = true; top = rect.top - 6 - panelHeight; }
    else if (!fitsBelow && !fitsAbove) { top = Math.max(margin, window.innerHeight - panelHeight - margin); placeUp = spaceBelow < spaceAbove; }
    if (placeUp) top = Math.max(margin, rect.top - 6 - panelHeight);
    const leftRaw = align === "end" ? rect.right - panelWidth : rect.left;
    const left = Math.max(margin, Math.min(leftRaw, window.innerWidth - panelWidth - margin));
    setPlacement({ top: Math.max(margin, top), left, visible: true });
  }, [open, options, value, align, menuWidth]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => { window.removeEventListener("pointerdown", handlePointerDown); window.removeEventListener("keydown", handleKeyDown); };
  }, [open]);

  const moveActive = (direction: -1 | 1) => {
    if (options.length === 0) return;
    const current = optionRefs.current.findIndex((element) => element === document.activeElement);
    const next = (current + direction + options.length) % options.length;
    optionRefs.current[next]?.focus();
  };

  const selectedLabel = options.find((option) => option.value === value)?.label ?? value ?? "";

  return (
    <div className="dropdown-root" ref={rootRef}>
      <button ref={triggerRef} type="button" className={`dropdown-trigger ${triggerClassName} ${disabled ? "is-disabled" : ""}`} disabled={disabled} onClick={() => setOpen((current) => { if (!current) onOpen?.(); return !current; })} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
        {triggerChildren ?? <span className="dropdown-trigger-label">{selectedLabel}</span>}
        <span className="dropdown-chevron" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="dropdown-menu" role="listbox" aria-label={label} style={{ top: placement?.top ?? 0, left: placement?.left ?? 0, visibility: placement?.visible ? "visible" : "hidden", width: menuWidth }} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
          if (event.key === "ArrowDown") { event.preventDefault(); moveActive(1); }
          if (event.key === "ArrowUp") { event.preventDefault(); moveActive(-1); }
          if (event.key === "Home") { event.preventDefault(); optionRefs.current[0]?.focus(); }
          if (event.key === "End") { event.preventDefault(); optionRefs.current[options.length - 1]?.focus(); }
          if (event.key === "Tab") { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
        }}>
          {options.length === 0 ? (
            <p className="dropdown-empty">No options available</p>
          ) : options.map((option, index) => (
            <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={`dropdown-option ${option.value === value ? "selected" : ""}`} tabIndex={-1} ref={(element) => { optionRefs.current[index] = element; }} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onChange(option.value); setOpen(false); triggerRef.current?.focus(); }}>
              <span className="dropdown-option-label"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {option.value === value && <span className="dropdown-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

const MAX_VISIBLE_REASONING_CHARS = 1800;

function ReasoningPanel({ content, isGenerating }: { content: string; isGenerating: boolean }) {
  const [expanded, setExpanded] = useState(isGenerating);
  useEffect(() => {
    if (!isGenerating) setExpanded(false);
  }, [isGenerating]);
  const visible = content.length > MAX_VISIBLE_REASONING_CHARS ? `...${content.slice(-MAX_VISIBLE_REASONING_CHARS)}` : content;
  return <div className={`reasoning-panel ${expanded ? "expanded" : "collapsed"}`}>
    <button className="reasoning-toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <UIIcons.thinking className={`thinking-star ${isGenerating ? "is-active" : ""}`} size={12} strokeWidth={1.8} aria-hidden="true" />
      <span>Thinking</span>
      {expanded ? <UIIcons.collapse className="reasoning-chevron" size={10} strokeWidth={1.5} aria-hidden="true" /> : <UIIcons.expand className="reasoning-chevron" size={10} strokeWidth={1.5} aria-hidden="true" />}
    </button>
    {expanded && <p className="reasoning-content">{visible}</p>}
  </div>;
}

function MessageAction({ label, onClick, children, active = false }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return <button className={`message-action ${active ? "active" : ""}`} type="button" onClick={onClick} aria-label={label} title={label}>{children}<span>{label}</span></button>;
}

function UserMessageContent({ content, onSave, notify, showCopy = true }: { content: string; onSave: (content: string) => void; notify: (notification: NotificationInput) => void; showCopy?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyToClipboard(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      notify({ kind: "warning", title: "Copy failed", description: "The question could not be copied." });
    }
  };

  if (editing) {
    return <div className="user-message-entry">
      <textarea className="message-edit-input" value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus aria-label="Edit question" />
      <div className="message-actions user-actions edit-actions">
        <MessageAction label="Cancel" onClick={() => { setDraft(content); setEditing(false); }}><UIIcons.close size={13} strokeWidth={1.7} /></MessageAction>
        <MessageAction label="Save" onClick={() => { const next = draft.trim(); if (!next) return; onSave(next); setEditing(false); }}><UIIcons.check size={13} strokeWidth={1.7} /></MessageAction>
      </div>
    </div>;
  }

  return <div className="user-message-entry">
    <p>{content}</p>
    <div className="message-actions user-actions">
      <MessageAction label="Edit" onClick={() => { setDraft(content); setEditing(true); }}><UIIcons.edit size={13} strokeWidth={1.7} /></MessageAction>
      {showCopy && <MessageAction label={copied ? "Copied" : "Copy question"} onClick={() => void copy()} active={copied}><UIIcons.copy size={13} strokeWidth={1.7} /></MessageAction>}
    </div>
  </div>;
}

function AssistantMessageActions({ content, isApiModel, onRetry, notify }: { content: string; isApiModel: boolean; onRetry: () => void; notify: (notification: NotificationInput) => void }) {
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState<"shared" | "copied" | null>(null);
  const [feedback, setFeedback] = useState<"positive" | "negative" | null>(null);

  const copy = async () => {
    try {
      await copyToClipboard(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      notify({ kind: "warning", title: "Copy failed", description: "The response could not be copied." });
    }
  };

  const share = async () => {
    if (!content.trim()) {
      notify({ kind: "warning", title: "Nothing to share", description: "The response is empty." });
      return;
    }
    try {
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ text: content });
          setShared("shared");
          window.setTimeout(() => setShared(null), 1600);
          return;
        } catch (error) {
          if ((error as DOMException).name === "AbortError") return;
        }
      }
      await copyToClipboard(content);
      setShared("copied");
      window.setTimeout(() => setShared(null), 1600);
    } catch {
      notify({ kind: "warning", title: "Couldn't share this response", description: "Native sharing and clipboard copy were unavailable." });
    }
  };

  return <div className="message-actions assistant-actions">
    <MessageAction label={copied ? "Copied" : "Copy response"} onClick={() => void copy()} active={copied}><UIIcons.copy size={13} strokeWidth={1.7} /></MessageAction>
    <MessageAction label={shared === "shared" ? "Shared" : shared === "copied" ? "Copied" : "Share response"} onClick={() => void share()} active={shared != null}><UIIcons.share size={13} strokeWidth={1.7} /></MessageAction>
    <MessageAction label="Retry" onClick={onRetry}><UIIcons.retry size={13} strokeWidth={1.7} /></MessageAction>
    {isApiModel && <>
      <MessageAction label="Helpful" onClick={() => setFeedback((current) => current === "positive" ? null : "positive")} active={feedback === "positive"}><UIIcons.positive size={13} strokeWidth={1.7} /></MessageAction>
      <MessageAction label="Not helpful" onClick={() => setFeedback((current) => current === "negative" ? null : "negative")} active={feedback === "negative"}><UIIcons.negative size={13} strokeWidth={1.7} /></MessageAction>
    </>}
  </div>;
}

const MessageList = memo(forwardRef<HTMLDivElement, { messages: Message[]; modelName: string; messageWidth: SettingsState["messageWidth"]; markdown: SettingsState["markdown"]; showTimestamps: boolean; showReasoning: boolean; isGenerating: boolean; notify: (notification: NotificationInput) => void; onSaveEdit: (index: number, content: string) => void; onRetry: (index: number) => void }>(function MessageList({ messages, modelName, messageWidth, markdown, showTimestamps, showReasoning, isGenerating, notify, onSaveEdit, onRetry }, ref) {
  const groups: Array<Array<{ message: Message; index: number }>> = [];
  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    const canGroup = message.role === "user" && !message.contextExcluded && previous?.role === "user" && !previous.contextExcluded;
    if (canGroup && groups[groups.length - 1]?.[0].message.role === "user") groups[groups.length - 1].push({ message, index });
    else groups.push([{ message, index }]);
  });

  return <div className={`message-list message-width-${messageWidth}`} ref={ref}>
    {groups.map((group) => {
      const first = group[0];
      const last = group[group.length - 1];
      const isUserGroup = first.message.role === "user";
      return <article className={`message ${first.message.role} ${isUserGroup && group.length > 1 ? "message-group" : ""}`} key={first.message.id ?? `${first.message.role}-${first.index}`}>
        <div className="message-body">
          <span className="message-role">{isUserGroup ? "ME" : modelName}{showTimestamps && <time>{new Date(last.message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>}</span>
          {group.map(({ message, index }) => message.role === "user" ? <UserMessageContent key={message.id ?? `user-${index}`} content={message.content} onSave={(content) => onSaveEdit(index, content)} notify={notify} showCopy={index === last.index} /> : <div key={message.id ?? `assistant-${index}`}>
            {message.reasoning && showReasoning && <ReasoningPanel content={message.reasoning} isGenerating={isGenerating && index === messages.length - 1} />}
            {!message.content && isGenerating && (!message.reasoning || !showReasoning) && <div className="thinking-dots" aria-label="Thinking"><span>•</span><span>•</span><span>•</span></div>}
            <p className={markdown === "plain" ? "plain-text" : ""}>{message.content}</p>
            {message.content && <AssistantMessageActions content={message.content} isApiModel={message.modelType === "API"} onRetry={() => onRetry(index)} notify={notify} />}
          </div>)}
        </div>
      </article>;
    })}
  </div>;
}));

const Composer = memo(function Composer({ selectedModel, enterToSend, onSend, onStop, isGenerating }: { selectedModel: ModelOption | null; enterToSend: boolean; onSend: (content: string) => boolean; onStop: () => void; isGenerating: boolean }) {
  const [draft, setDraft] = useState("");
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (onSend(draft)) setDraft("");
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && enterToSend) {
      event.preventDefault();
      submit();
    }
  };

  return <div className="composer-area">
    <form className="composer" onSubmit={submit}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} placeholder={selectedModel ? "Ask anything..." : "Connect a model to start chatting"} rows={1} aria-label="Message" />
      <button className={`send-button ${isGenerating ? "is-generating" : ""}`} type={isGenerating ? "button" : "submit"} onClick={isGenerating ? onStop : undefined} disabled={isGenerating ? false : !draft.trim() || !selectedModel} aria-label={isGenerating ? "Stop generation" : "Send message"}>
        <span className={`send-button-icon ${isGenerating ? "is-visible" : ""}`} aria-hidden="true">■</span>
        <span className={`send-button-icon ${isGenerating ? "" : "is-visible"}`} aria-hidden="true">↑</span>
      </button>
    </form>
    <p className="composer-meta"><span>{selectedModel ? `${selectedModel.name} · ${selectedModel.detail}` : "No model connected"}</span><span>Enter to send · Shift + Enter for newline</span></p>
  </div>;
});

function SelectControl({ value, onChange, options, label, disabled = false }: { value: string; onChange: (value: string) => void; options: string[]; label: string; disabled?: boolean }) {
  return <Dropdown value={value} onChange={onChange} options={options.map((option) => ({ value: option, label: option }))} label={label} ariaLabel={label} disabled={disabled} />;
}

function SettingsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="settings-search"><span>⌕</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Search settings" aria-label="Search settings" /><kbd>⌘ K</kbd></label>;
}

function describeBackendError(operation: string): NotificationInput {
  const messages: Record<string, NotificationInput> = {
    load: { kind: "warning", title: "Settings unavailable", description: "Saved settings could not be loaded. Your current changes will remain temporary." },
    save: { kind: "warning", title: "Settings not saved", description: "Your changes could not be saved. Check app permissions and try again." },
    sources: { kind: "info", title: "Model discovery unavailable", description: "Local runtimes are not connected yet, so no models are available." },
    credentials: { kind: "error", title: "Credentials not stored", description: "The operating system secure store could not be reached." },
    systeminfo: { kind: "warning", title: "System information unavailable", description: "Hardware details could not be read." },
    logs: { kind: "warning", title: "Logs unavailable", description: "The application log store could not be reached." },
    devtools: { kind: "warning", title: "Developer tools unavailable", description: "The window rejected the request to toggle developer tools." },
  };
  return messages[operation] ?? { kind: "error", title: "Unexpected error", description: "The requested operation could not be completed." };
}

function AppContent() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<ConversationFolder[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("new");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  const [activeSettingsCategory, setActiveSettingsCategory] = useState<SettingsCategory>("Appearance");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [installedModels, setInstalledModels] = useState<LocalModel[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [appVersion, setAppVersion] = useState(packageJson.version);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [organizationLoaded, setOrganizationLoaded] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfoSnapshot | null>(null);
  const [systemInfoStatus, setSystemInfoStatus] = useState<"loading" | "ready" | "error">("loading");
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pathStatus, setPathStatus] = useState<{ modelDirectory: PathValidationResult | null; downloads: PathValidationResult | null }>({ modelDirectory: null, downloads: null });
  const messageListRef = useRef<HTMLDivElement>(null);
  const { notify } = useNotifications();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draggedConversationId, setDraggedConversationId] = useState<string | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconPickerFolderId, setIconPickerFolderId] = useState<string | null>(null);
  const [iconPickerPosition, setIconPickerPosition] = useState({ x: 0, y: 0 });
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const settingsLoadStartedRef = useRef(false);
  const conversationsLoadStartedRef = useRef(false);
  const systemInfoLoadStartedRef = useRef(false);
  const discoveryKeyRef = useRef<string | null>(null);
  const skipSettingsSaveRef = useRef(false);
  const skipConversationsSaveRef = useRef(false);
  const persistedConversationsRef = useRef<Map<string, Conversation>>(new Map());
  const pathValidationSequenceRef = useRef(0);
  const streamListenerReadyRef = useRef<Promise<void>>(Promise.resolve());
  const requestOwnershipRef = useRef<Map<string, RequestOwnership>>(new Map());
  const cancelledRequestIdsRef = useRef<Set<string>>(new Set());
  const cancelledTurnSnapshotsRef = useRef<Map<string, Conversation>>(new Map());
  const conversationMutationVersionsRef = useRef<Map<string, number>>(new Map());
  const [generatingConversationIds, setGeneratingConversationIds] = useState<Set<string>>(new Set());
  const followScrollRef = useRef(true);
  const pendingLogRef = useRef<{ level: string; message: string }[]>([]);
  const logFlushTimerRef = useRef<number | null>(null);
  const updateCheckStartedRef = useRef(false);

  const messages = useMemo(() => conversations.find((conversation) => conversation.id === activeConversationId)?.messages ?? [], [conversations, activeConversationId]);
  const isGenerating = generatingConversationIds.has(activeConversationId);

  const rootConversations = useMemo(() => conversations.filter((conversation) => !conversation.folderId), [conversations]);
  const conversationsById = useMemo(() => new Map(conversations.map((conversation) => [conversation.id, conversation])), [conversations]);
  const folderConversationsMap = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    folders.forEach((folder) => {
      const conversationsInFolder = folder.conversationIds
        .map((id) => conversationsById.get(id))
        .filter((conversation): conversation is Conversation => Boolean(conversation));
      map.set(folder.id, conversationsInFolder);
    });
    return map;
  }, [folders, conversationsById]);

  const folderConversations = useCallback((folderId: string) => {
    return folderConversationsMap.get(folderId) ?? [];
  }, [folderConversationsMap]);

  const availableModels: ModelOption[] = useMemo(() => {
    const localModels = installedModels.map((model) => ({ id: model.id, name: model.name, type: "Local" as const, detail: model.status, backend: model.backend, contextLength: model.contextLength }));
    if (settings.localOnly) return localModels;
    const apiModels = providers
      .filter((provider) => provider.enabled)
      .flatMap((provider) => provider.models.map((model) => ({ id: `${provider.id}:${model.id}`, name: model.name, type: "API" as const, detail: provider.name, providerId: provider.id, contextLength: model.contextLength })));
    return [...localModels, ...apiModels];
  }, [installedModels, providers, settings.localOnly]);
  const modelOptions = useMemo(() => availableModels.map((model) => ({ name: model.name, value: model.name, label: model.name, description: model.detail })), [availableModels]);
  const modelNames = useMemo(() => availableModels.map((model) => model.name), [availableModels]);

  const updateSetting = useCallback(<Key extends keyof SettingsState>(key: Key, value: SettingsState[Key]) => {
    setSettings((current) => {
      if (current[key] === value) return current;
      return { ...current, [key]: value };
    });
  }, []);

  const markConversationChanged = useCallback((conversationId: string) => {
    const version = conversationMutationVersionsRef.current.get(conversationId) ?? 0;
    conversationMutationVersionsRef.current.set(conversationId, version + 1);
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    if (!shouldHydrateConversation(requestOwnershipRef.current, id)) return;
    const loadVersion = conversationMutationVersionsRef.current.get(id) ?? 0;
    try {
      const stored = await invoke<Conversation | null>("load_conversation", { id });
      if (!stored) return;
      setConversations((current) => shouldHydrateConversation(requestOwnershipRef.current, id) && (conversationMutationVersionsRef.current.get(id) ?? 0) === loadVersion
        ? current.map((conversation) => conversation.id === id ? stored : conversation)
        : current);
    } catch {
      notify({ kind: "warning", title: "Conversation unavailable", description: "The selected conversation could not be loaded." });
    }
  }, [notify]);

  const [systemTheme, setSystemTheme] = useState<"dark" | "light">("dark");
  const activeTheme = settings.theme === "light" || (settings.theme === "system" && systemTheme === "light") ? "theme-light" : "";

  useEffect(() => {
    document.documentElement.classList.toggle("theme-light", Boolean(activeTheme));
    document.documentElement.classList.remove("accent-sage", "accent-blue", "accent-violet");
    document.documentElement.classList.add(`accent-${settings.accent}`);
    void invoke("set_window_theme", { dark: !activeTheme }).catch(() => undefined);
    return () => {
      document.documentElement.classList.remove("theme-light", "accent-sage", "accent-blue", "accent-violet");
    };
  }, [activeTheme, settings.accent]);

  useEffect(() => {
    if (confirmState) confirmCancelRef.current?.focus();
  }, [confirmState]);

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) {
        drag.active = true;
        setDraggedConversationId(drag.id);
      }
      if (!drag.active) return;
      event.preventDefault();
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      if (sidebar) {
        if (event.clientY < 72) sidebar.scrollBy({ top: -8 });
        if (event.clientY > window.innerHeight - 72) sidebar.scrollBy({ top: 8 });
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-folder-id], [data-conversation-id], .conversation-list");
      const newTarget = target?.dataset.folderId ? `folder:${target.dataset.folderId}` : target?.dataset.conversationId ? `conversation:${target.dataset.conversationId}` : target?.classList.contains("conversation-list") ? "root" : null;
      setDragTarget((current) => current === newTarget ? current : newTarget);
    };
    const handlePointerUp = (event: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      if (!drag?.active) { setDraggedConversationId(null); setDragTarget(null); return; }
      suppressClickRef.current = true;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-folder-id], [data-conversation-id], .conversation-list");
      if (target?.dataset.folderId) moveConversation(drag.id, target.dataset.folderId);
      else if (target?.dataset.conversationId) reorderConversation(drag.id, target.dataset.conversationId);
      else if (target?.classList.contains("conversation-list")) moveConversation(drag.id);
      setDraggedConversationId(null);
      setDragTarget(null);
    };
    const handlePointerCancel = () => {
      pointerDragRef.current = null;
      setDraggedConversationId(null);
      setDragTarget(null);
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => { window.removeEventListener("pointermove", handlePointerMove); window.removeEventListener("pointerup", handlePointerUp); window.removeEventListener("pointercancel", handlePointerCancel); };
  }, [conversations, folders]);

  useEffect(() => {
    if (settingsLoadStartedRef.current) return;
    settingsLoadStartedRef.current = true;
    invoke<Partial<SettingsState> | null>("load_settings")
      .then((stored) => {
        if (stored) {
          const next = { ...defaultSettings, ...stored };
          setSettings(next);
          setProviders((next.apiProviders ?? []).map((provider) => ({ ...provider, baseUrl: provider.baseUrl || "https://api.openai.com/v1" })));
        }
      })
      .catch(() => notify(describeBackendError("load")))
      .finally(() => { skipSettingsSaveRef.current = true; setSettingsLoaded(true); });
  }, [notify]);

  useEffect(() => {
    if (conversationsLoadStartedRef.current) return;
    conversationsLoadStartedRef.current = true;
    invoke<ConversationIndex | null>("load_conversation_index")
      .then((stored) => {
        if (stored) {
          const summaries = stored.conversations ?? [];
          setConversations(summaries.map((conversation) => ({ ...conversation, messages: [] })));
          setFolders(stored.folders ?? []);
          if (summaries[0]) {
            setActiveConversationId(summaries[0].id);
            void loadConversation(summaries[0].id);
          }
        }
      })
      .catch(() => notify({ kind: "warning", title: "Chats unavailable", description: "Saved conversations could not be loaded. New changes will remain temporary." }))
        .finally(() => { skipConversationsSaveRef.current = true; setOrganizationLoaded(true); });
  }, [loadConversation, notify]);

  useEffect(() => {
    let disposed = false;
    const listener = listen<AiStreamEvent>("ai://stream", ({ payload }) => {
      if (disposed) return;
      const ownership = requestOwnershipRef.current.get(payload.requestId);
      if (!ownership) return;
      if ((payload.kind === "thinking" || payload.kind === "chunk") && payload.content) {
        setConversations((current) => applyOwnedStreamEvent(current, payload, ownership, MAX_VISIBLE_REASONING_CHARS));
        return;
      }

      requestOwnershipRef.current.delete(payload.requestId);
      const wasCancelled = cancelledRequestIdsRef.current.delete(payload.requestId);
      cancelledTurnSnapshotsRef.current.delete(payload.requestId);
      setGeneratingConversationIds((current) => {
        const next = new Set(current);
        next.delete(ownership.conversationId);
        return next;
      });
      if (payload.kind === "error" && !wasCancelled) {
        setConversations((current) => rollbackOwnedTurn(current, ownership).map((conversation) => conversation.id === ownership.conversationId ? { ...conversation, updatedAt: Date.now() } : conversation));
        notify({ kind: "error", title: "Generation failed", description: payload.detail ?? "The AI runtime could not complete the request." });
      } else {
        setConversations((current) => current.map((conversation) => conversation.id === ownership.conversationId ? { ...conversation, updatedAt: Date.now() } : conversation));
      }
    });
    streamListenerReadyRef.current = listener.then(() => undefined, () => undefined);
    return () => {
      disposed = true;
      void listener.then((cleanup) => cleanup?.(), () => undefined);
    };
  }, [notify]);

  useEffect(() => {
    if (!organizationLoaded) return;
    if (requestOwnershipRef.current.size > 0) return;
    const current = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    if (skipConversationsSaveRef.current) {
      skipConversationsSaveRef.current = false;
      persistedConversationsRef.current = current;
      return;
    }
    const timer = window.setTimeout(() => {
      const summaries = conversations.map(({ messages: _messages, ...summary }) => summary);
      invoke("save_conversation_index", { data: { conversations: summaries, folders } }).catch(() => notify({ kind: "warning", title: "Chat index not saved", description: "Your conversation organization could not be saved." }));
      const previous = persistedConversationsRef.current;
      const changed = conversations.filter((conversation) => {
        const old = previous.get(conversation.id);
        return !old || old.messages !== conversation.messages;
      });
      const deleted = [...previous.keys()].filter((id) => !current.has(id));
      void Promise.all(changed.map((conversation) => invoke("save_conversation", { id: conversation.id, data: conversation }))).catch(() => notify({ kind: "warning", title: "Conversation not saved", description: "A conversation could not be saved." }));
      void Promise.all(deleted.map((id) => invoke("delete_conversation", { id }))).catch(() => notify({ kind: "warning", title: "Conversation cleanup failed", description: "Some deleted conversation data could not be removed." }));
      persistedConversationsRef.current = current;
    }, 250);
    return () => window.clearTimeout(timer);
  }, [conversations, folders, organizationLoaded, notify]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { setContextMenu(null); setRenamingId(null); setConfirmState(null); }
    };
    const suppressNativeMenu = (event: globalThis.MouseEvent) => event.preventDefault();
    window.addEventListener("click", closeContextMenu);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("contextmenu", suppressNativeMenu);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("contextmenu", suppressNativeMenu);
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (skipSettingsSaveRef.current) {
      skipSettingsSaveRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      invoke("save_settings", { settings }).catch(() => notify(describeBackendError("save")));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settings, settingsLoaded, notify]);

  const discoverModels = useCallback(async () => {
    setDiscoveringModels(true);
    try {
      const directories = splitDirectories(settings.modelLocation);
      const sources = await invoke<{ providers: Provider[]; runtimes: RuntimeStatus[] }>("get_ai_sources", { modelDirectories: directories });
      setInstalledModels(sources.runtimes.flatMap((runtime) => runtime.models.map((model) => ({
        id: model.id,
        name: model.name,
        backend: model.backend,
        sizeBytes: model.sizeBytes,
        status: model.detail,
        contextLength: model.contextLength,
      }))));
      setRuntimes(sources.runtimes);
    } catch {
      notify(describeBackendError("sources"));
    } finally {
      setDiscoveringModels(false);
    }
  }, [settings.modelLocation, notify]);

  const discoverProviderModels = useCallback(async (provider: Provider) => {
    try {
      const models = await invoke<ProviderModel[]>("discover_provider_models", { providerId: provider.id, baseUrl: provider.baseUrl });
      setProviders((current) => {
        const updated = current.map((item) => item.id === provider.id ? { ...item, models } : item);
        updateSetting("apiProviders", updated);
        return updated;
      });
      notify({ kind: "success", title: "Connection verified", description: `${provider.name} returned ${models.length} available models.` });
    } catch {
      notify({ kind: "warning", title: "Connection failed", description: "The provider could not be reached or the API key was rejected." });
    }
  }, [notify, updateSetting]);

  useEffect(() => {
    if (availableModels.length > 0 && !selectedModel) {
      setSelectedModel(availableModels[0]);
    }
  }, [availableModels, selectedModel]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const discoveryKey = settings.modelLocation;
    if (discoveryKeyRef.current === discoveryKey) return;
    discoveryKeyRef.current = discoveryKey;
    void discoverModels();
  }, [settingsLoaded, settings.modelLocation, discoverModels]);

  useEffect(() => {
    if (systemInfoLoadStartedRef.current) return;
    systemInfoLoadStartedRef.current = true;
    const timer = window.setTimeout(() => {
      void invoke<SystemInfoSnapshot>("get_system_info")
        .then((snapshot) => { setSystemInfo(snapshot); setSystemInfoStatus("ready"); })
        .catch(() => { setSystemInfoStatus("error"); notify(describeBackendError("systeminfo")); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [notify]);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (checkingUpdates) return;
    setCheckingUpdates(true);
    try {
      const update = await check();
      setAvailableUpdate(update);
      if (update && !manual) notify({ kind: "info", title: "Aether update available", description: `Version ${update.version} is ready. Open Settings → About to install it.` });
      if (manual) {
        notify(update
          ? { kind: "info", title: "Update available", description: `Aether ${update.version} is ready to install.` }
          : { kind: "success", title: "Aether is up to date", description: `You are running version ${appVersion}.` });
      }
    } catch {
      if (manual) notify({ kind: "warning", title: "Update check unavailable", description: "Aether could not reach the signed update service. Try again later." });
    } finally {
      setCheckingUpdates(false);
    }
  }, [appVersion, checkingUpdates, notify]);

  const installUpdate = useCallback(async () => {
    if (!availableUpdate || installingUpdate) return;
    setInstallingUpdate(true);
    try {
      await availableUpdate.downloadAndInstall();
      await relaunch();
    } catch {
      setInstallingUpdate(false);
      notify({ kind: "error", title: "Update failed", description: "The signed update could not be installed. Your current version is unchanged." });
    }
  }, [availableUpdate, installingUpdate, notify]);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => undefined);
    if (updateCheckStartedRef.current) return;
    updateCheckStartedRef.current = true;
    const timer = window.setTimeout(() => { void checkForUpdates(); }, 1500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  useEffect(() => {
    if (settings.debugLogging) {
      invoke<LogEntry[]>("get_logs").then(setLogs).catch(() => notify(describeBackendError("logs")));
    }
  }, [settings.debugLogging, notify]);

  useEffect(() => {
    if (!settings.debugLogging) return;
    const flushLogs = () => {
      if (logFlushTimerRef.current != null) {
        window.clearTimeout(logFlushTimerRef.current);
        logFlushTimerRef.current = null;
      }
      const inputs = pendingLogRef.current.splice(0);
      if (inputs.length > 0) invoke("append_logs", { inputs }).catch(() => {});
    };
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    const forward = (level: string, args: unknown[]) => {
      pendingLogRef.current.push({ level, message: args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ") });
      if (pendingLogRef.current.length >= 20) flushLogs();
      else if (logFlushTimerRef.current == null) logFlushTimerRef.current = window.setTimeout(flushLogs, 50);
    };
    console.log = (...args) => { original.log(...args); forward("info", args); };
    console.info = (...args) => { original.info(...args); forward("info", args); };
    console.warn = (...args) => { original.warn(...args); forward("warn", args); };
    console.error = (...args) => { original.error(...args); forward("error", args); };
    return () => {
      flushLogs();
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    };
  }, [settings.debugLogging]);

  useEffect(() => {
    const requestId = ++pathValidationSequenceRef.current;
    const validate = async () => {
      const [modelDirectory, downloads] = await Promise.all([
        invoke<PathValidationResult>("validate_path", { input: { path: settings.modelLocation } }).catch(() => null),
        invoke<PathValidationResult>("validate_path", { input: { path: settings.downloadsLocation } }).catch(() => null),
      ]);
      if (requestId === pathValidationSequenceRef.current) setPathStatus({ modelDirectory, downloads });
    };
    const timer = window.setTimeout(() => { void validate(); }, 300);
    return () => window.clearTimeout(timer);
  }, [settings.modelLocation, settings.downloadsLocation]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) {
      followScrollRef.current = true;
      return;
    }
    followScrollRef.current = true;
    const updateScrollIntent = () => {
      followScrollRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
    };
    list.addEventListener("scroll", updateScrollIntent, { passive: true });
    return () => list.removeEventListener("scroll", updateScrollIntent);
  }, [activeConversationId, messages.length > 0, isGenerating]);

  const latestMessage = messages[messages.length - 1];
  useEffect(() => {
    if (!settings.autoScroll || !followScrollRef.current || !latestMessage) return;
    const frame = window.requestAnimationFrame(() => {
      messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: isGenerating ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, latestMessage?.content, latestMessage?.reasoning, messages.length, settings.autoScroll, isGenerating]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let hideTimeoutId: number | null = null;
    const handleScroll = () => {
      list.classList.add("is-scrolling");
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
      hideTimeoutId = window.setTimeout(() => {
        list.classList.remove("is-scrolling");
        hideTimeoutId = null;
      }, prefersReducedMotion ? 300 : 1000);
    };
    list.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      list.removeEventListener("scroll", handleScroll);
      if (hideTimeoutId !== null) window.clearTimeout(hideTimeoutId);
    };
  }, [activeConversationId, messages.length > 0]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "n") { event.preventDefault(); createConversation(); }
      if (event.key.toLowerCase() === "b") { event.preventDefault(); setIsSidebarOpen((open) => !open); }
      if (event.key.toLowerCase() === "l") { event.preventDefault(); document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const updateSystemTheme = () => setSystemTheme(mediaQuery.matches ? "light" : "dark");
    updateSystemTheme();
    mediaQuery.addEventListener("change", updateSystemTheme);
    return () => mediaQuery.removeEventListener("change", updateSystemTheme);
  }, []);

  const createConversation = useCallback((folderId?: string) => {
    const id = `conversation-${Date.now()}`;
    const now = Date.now();
    setConversations((current) => [{ id, title: "New conversation", messages: [], createdAt: now, updatedAt: now, folderId }, ...current]);
    if (folderId) setFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, isOpen: true, conversationIds: [...folder.conversationIds, id] } : folder));
    setActiveConversationId(id);
  }, []);

  const selectConversation = useCallback((id: string) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    if (activeConversationId === id) return;
    setActiveConversationId(id);
    void loadConversation(id);
    setIsSidebarOpen(false);
  }, [activeConversationId, loadConversation]);

  const beginRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id);
    setRenameDraft(currentName);
  }, []);

  const createFolder = useCallback(() => {
    const id = `folder-${Date.now()}`;
    setFolders((current) => [...current, { id, name: "New folder", isOpen: true, conversationIds: [] }]);
    beginRename(id, "New folder");
    setContextMenu(null);
  }, [beginRename]);

  const finishRename = useCallback(() => {
    const name = renameDraft.trim();
    if (!renamingId || !name) { setRenamingId(null); return; }
    if (renamingId.startsWith("folder-")) {
      setFolders((current) => {
        const folder = current.find((f) => f.id === renamingId);
        if (folder?.name === name) { setRenamingId(null); return current; }
        return current.map((folder) => folder.id === renamingId ? { ...folder, name } : folder);
      });
    } else {
      setConversations((current) => {
        const conversation = current.find((c) => c.id === renamingId);
        if (conversation?.title === name) { setRenamingId(null); return current; }
        return current.map((conversation) => conversation.id === renamingId ? { ...conversation, title: name, updatedAt: Date.now() } : conversation);
      });
    }
    setRenamingId(null);
  }, [renameDraft, renamingId]);

  const updateFolderIcon = useCallback((folderId: string, iconName: IconName) => {
    setFolders((current) => current.map((folder) => 
      folder.id === folderId ? { ...folder, icon: iconName } : folder
    ));
  }, []);

  const openIconPicker = useCallback((folderId: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    setIconPickerFolderId(folderId);
    setIconPickerPosition({ x: event.clientX, y: event.clientY });
    setIconPickerOpen(true);
    setContextMenu(null);
  }, []);

  const closeIconPicker = useCallback(() => {
    setIconPickerOpen(false);
    setIconPickerFolderId(null);
  }, []);

  const moveConversation = useCallback((conversationId: string, folderId?: string) => {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, folderId, updatedAt: Date.now() } : conversation));
    setFolders((current) => current.map((folder) => ({ ...folder, conversationIds: folder.id === folderId ? [...folder.conversationIds.filter((id) => id !== conversationId), conversationId] : folder.conversationIds.filter((id) => id !== conversationId) })));
  }, []);

  function reorderConversation(conversationId: string, targetId: string) {
    if (conversationId === targetId) return;
    const dragged = conversations.find((conversation) => conversation.id === conversationId);
    const target = conversations.find((conversation) => conversation.id === targetId);
    if (!dragged || !target || dragged.folderId !== target.folderId) {
      if (dragged && target) moveConversation(conversationId, target.folderId);
      return;
    }
    setConversations((current) => {
      const withoutDragged = current.filter((conversation) => conversation.id !== conversationId);
      const targetIndex = withoutDragged.findIndex((conversation) => conversation.id === targetId);
      withoutDragged.splice(targetIndex, 0, dragged);
      return withoutDragged;
    });
    if (dragged.folderId) setFolders((current) => current.map((folder) => {
      if (folder.id !== dragged.folderId) return folder;
      const ids = folder.conversationIds.filter((id) => id !== conversationId);
      ids.splice(ids.indexOf(targetId), 0, conversationId);
      return { ...folder, conversationIds: ids };
    }));
  }

  function cancelConversationRequests(conversationIds: Set<string>) {
    for (const [requestId, ownership] of requestOwnershipRef.current) {
      if (!conversationIds.has(ownership.conversationId)) continue;
      cancelledRequestIdsRef.current.delete(requestId);
      cancelledTurnSnapshotsRef.current.delete(requestId);
      requestOwnershipRef.current.delete(requestId);
      void invoke<boolean>("cancel_message", { requestId }).catch(() => undefined);
    }
    setGeneratingConversationIds((current) => {
      const next = new Set(current);
      for (const conversationId of conversationIds) next.delete(conversationId);
      return next;
    });
  }

  function deleteConversation(conversationId: string) {
    cancelConversationRequests(new Set([conversationId]));
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
    setFolders((current) => current.map((folder) => ({ ...folder, conversationIds: folder.conversationIds.filter((id) => id !== conversationId) })));
    if (activeConversationId === conversationId) setActiveConversationId(conversations.find((conversation) => conversation.id !== conversationId)?.id ?? "");
  }

  function requestDeleteConversation(conversationId: string) {
    const conversation = conversations.find((item) => item.id === conversationId);
    setConfirmState({
      title: "Delete conversation?",
      body: <p><strong>"{conversation?.title ?? "This conversation"}"</strong> and its messages will be permanently deleted. This cannot be undone.</p>,
      confirmLabel: "Delete conversation",
      danger: true,
      onConfirm: () => { deleteConversation(conversationId); setConfirmState(null); },
    });
  }

  function removeFolderPermanently(folderId: string) {
    const deletedIds = conversations.filter((conversation) => conversation.folderId === folderId).map((conversation) => conversation.id);
    cancelConversationRequests(new Set(deletedIds));
    setFolders((current) => current.filter((folder) => folder.id !== folderId));
    setConversations((current) => current.filter((conversation) => conversation.folderId !== folderId));
    if (deletedIds.includes(activeConversationId)) {
      const remaining = conversations.filter((conversation) => !deletedIds.includes(conversation.id));
      setActiveConversationId(remaining[0]?.id ?? "");
    }
    setConfirmState(null);
  }

  function requestDeleteFolder(folderId: string) {
    const folder = folders.find((item) => item.id === folderId);
    const conversationCount = folder?.conversationIds.length ?? 0;
    setConfirmState({
      title: "Delete folder?",
      body: <p><strong>"{folder?.name ?? "This folder"}"</strong> and all {conversationCount} conversation{conversationCount === 1 ? "" : "s"} inside it will be permanently deleted. This cannot be undone.</p>,
      confirmLabel: "Delete folder",
      danger: true,
      onConfirm: () => removeFolderPermanently(folderId),
    });
  }

  function duplicateConversation(conversationId: string) {
    const original = conversations.find((conversation) => conversation.id === conversationId);
    if (!original) return;
    const id = `conversation-${Date.now()}`;
    const now = Date.now();
    const duplicate = { ...original, id, title: `${original.title} copy`, createdAt: now, updatedAt: now };
    setConversations((current) => [...current, duplicate]);
    if (original.folderId) setFolders((current) => current.map((folder) => folder.id === original.folderId ? { ...folder, conversationIds: [...folder.conversationIds, id] } : folder));
  }

  const openContextMenu = useCallback((event: ReactMouseEvent, type: ContextMenuState["type"], id?: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ anchorX: event.clientX, anchorY: event.clientY, x: event.clientX + 6, y: event.clientY + 6, placement: "down", type, id });
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const margin = 8;
    const gap = 6;
    const menu = contextMenuRef.current;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const x = Math.max(margin, Math.min(contextMenu.anchorX + gap, window.innerWidth - width - margin));
    const roomBelow = window.innerHeight - contextMenu.anchorY - gap - margin;
    const roomAbove = contextMenu.anchorY - gap - margin;
    const placement = roomBelow >= height || roomBelow >= roomAbove ? "down" : "up";
    const preferredY = placement === "down" ? contextMenu.anchorY + gap : contextMenu.anchorY - height - gap;
    const y = Math.max(margin, Math.min(preferredY, window.innerHeight - height - margin));
    if (x !== contextMenu.x || y !== contextMenu.y || placement !== contextMenu.placement) {
      setContextMenu((current) => current ? { ...current, x, y, placement } : null);
    }
  }, [contextMenu]);

  const startConversationDrag = useCallback((event: ReactPointerEvent, conversationId: string) => {
    if (event.button !== 0) return;
    pointerDragRef.current = { id: conversationId, x: event.clientX, y: event.clientY, active: false };
  }, []);

  const toggleProvider = useCallback((providerId: string) => {
    setProviders((current) => {
      const provider = current.find((item) => item.id === providerId);
      if (!provider) return current;
      const updated = current.map((p) => p.id === providerId ? { ...p, enabled: !p.enabled } : p);
      updateSetting("apiProviders", updated);
      if (provider.enabled && selectedModel?.providerId === providerId) {
        setSelectedModel(availableModels.find((model) => model.type === "Local") ?? null);
      }
      return updated;
    });
  }, [selectedModel, availableModels, updateSetting]);

  const removeProvider = useCallback(async (providerId: string) => {
    try {
      await invoke("clear_provider_credential", { providerId });
    } catch {
      notify({ kind: "warning", title: "Credentials not removed", description: "The provider was removed from this session, but its secure credential could not be cleared." });
    }
    setProviders((current) => {
      const updated = current.filter((provider) => provider.id !== providerId);
      updateSetting("apiProviders", updated);
      return updated;
    });
    if (selectedModel?.providerId === providerId) {
      setSelectedModel(availableModels.find((model) => model.type === "Local") ?? null);
    }
    if (settings.defaultProvider === providerId) updateSetting("defaultProvider", "local");
    setConfirmState(null);
  }, [selectedModel, availableModels, settings.defaultProvider, updateSetting, notify]);

  const requestRemoveProvider = useCallback((provider: Provider) => {
    setConfirmState({
      title: `Remove ${provider.name}?`,
      body: <p>The provider will be removed from this session{provider.hasCredentials ? " and its secured credential will be removed from the operating system store" : ""}. This cannot be undone.</p>,
      confirmLabel: "Remove provider",
      danger: true,
      onConfirm: () => removeProvider(provider.id),
    });
  }, [removeProvider]);

  async function clearStoredCredentials() {
    const results = await Promise.all(providers.map((provider) => invoke("clear_provider_credential", { providerId: provider.id }).then(() => true).catch(() => false)));
    setProviders([]);
    updateSetting("apiProviders", []);
    setSelectedModel(availableModels.find((model) => model.type === "Local") ?? null);
    if (results.some((result) => !result)) notify({ kind: "warning", title: "Some credentials remain", description: "Some secure credentials could not be cleared from the operating system store." });
    setConfirmState(null);
  }

  function requestClearStoredCredentials() {
    setConfirmState({
      title: "Clear stored credentials?",
      body: <p>All saved API keys will be permanently removed from the operating system secure store.</p>,
      confirmLabel: "Clear credentials",
      danger: true,
      onConfirm: () => clearStoredCredentials(),
    });
  }

  function requestClearAllConversations() {
    setConfirmState({
      title: "Clear all conversations?",
      body: <p>Every conversation and folder will be permanently deleted from this device. This cannot be undone.</p>,
      confirmLabel: "Clear all",
      danger: true,
      onConfirm: () => { setConversations([]); setFolders([]); setActiveConversationId(""); setConfirmState(null); },
    });
  }

  const addApiProvider = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const apiKey = String(formData.get("apiKey") ?? "").trim();
    const baseUrl = String(formData.get("baseUrl") ?? "").trim();
    if (!apiKey) {
      notify({ kind: "error", title: "API key required", description: "Enter an API key to add a provider." });
      return;
    }
    if (baseUrl) {
      try {
        new URL(baseUrl);
      } catch {
        notify({ kind: "error", title: "Invalid base URL", description: "Enter a complete provider URL or leave the field empty." });
        return;
      }
    }

    const providerName = identifyProvider(apiKey, baseUrl);
    if (!["ChatGPT", "OpenRouter"].includes(providerName) && !baseUrl.toLowerCase().includes("openai")) {
      notify({ kind: "info", title: "Provider adapter not available", description: "OpenAI and OpenAI-compatible endpoints are supported first. Other providers are not connected yet." });
      return;
    }
    const providerId = providerName === "OpenRouter" ? "openrouter" : "openai";
    const normalizedBaseUrl = baseUrl || (providerId === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
    try {
      await invoke("store_provider_credential", { providerId, apiKey });
    } catch {
      notify(describeBackendError("credentials"));
      return;
    }

    const provider: Provider = {
      id: providerId,
      name: providerName === "ChatGPT" ? "OpenAI" : providerName,
      detail: normalizedBaseUrl,
      baseUrl: normalizedBaseUrl,
      models: [],
      enabled: true,
      hasCredentials: true,
    };
    setProviders((current) => {
      const updated = [...current.filter((item) => item.id !== provider.id), provider];
      updateSetting("apiProviders", updated);
      return updated;
    });
    notify({ kind: "success", title: `${provider.name} added`, description: "Credentials are stored securely. Discover models from the Models settings." });
    form.reset();
  }, [notify, updateSetting]);

  const startGeneration = useCallback((requestMessages: Message[], conversationId: string, title?: string) => {
    if (!selectedModel) {
      notify({ kind: "warning", title: "No model available", description: "Connect a provider or local runtime in Settings to start chatting." });
      return false;
    }
    if (selectedModel.type === "Local" && selectedModel.backend !== "ollama") {
      notify({ kind: "info", title: "Provider not connected", description: "Only an already-running Ollama runtime is connected currently." });
      return false;
    }
    const provider = selectedModel.type === "API" ? providers.find((item) => item.id === selectedModel.providerId) : undefined;
    if (selectedModel.type === "API" && !provider) {
      notify({ kind: "warning", title: "Provider unavailable", description: "Configure the selected API provider before sending a message." });
      return false;
    }
    if (hasActiveRequestForConversation(requestOwnershipRef.current, conversationId)) return false;
    const requestId = `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const assistantMessageId = `message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let userMessageIndex = -1;
    for (let index = requestMessages.length - 1; index >= 0; index -= 1) {
      if (requestMessages[index].role === "user") {
        userMessageIndex = index;
        break;
      }
    }
    if (userMessageIndex < 0) return false;
    const userMessageId = requestMessages[userMessageIndex].id ?? `message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const generationMessages = requestMessages.map((message, index) => index === userMessageIndex ? { ...message, id: userMessageId } : message);
    const configuredContextSize = contextSizeToTokens(settings.contextSize);
    const contextLimit = selectedModel.contextLength ? Math.min(configuredContextSize, selectedModel.contextLength) : configuredContextSize;
    const contextMessages = buildContextMessages(generationMessages, contextLimit);
    const createdAt = Date.now();
    markConversationChanged(conversationId);
    requestOwnershipRef.current.set(requestId, { conversationId, userMessageId, assistantMessageId });
    followScrollRef.current = true;
    setGeneratingConversationIds((current) => new Set(current).add(conversationId));

    setConversations((current) => {
      const nextConversation = {
        id: conversationId,
        title: title ?? "New conversation",
        messages: appendAssistantPlaceholder(generationMessages, assistantMessageId, createdAt, { modelType: selectedModel.type }),
        createdAt,
        updatedAt: createdAt,
      };
      return current.some((conversation) => conversation.id === conversationId)
        ? current.map((conversation) => conversation.id === conversationId ? { ...conversation, ...nextConversation, folderId: conversation.folderId } : conversation)
        : [nextConversation, ...current];
    });

    void (async () => {
      try {
        await streamListenerReadyRef.current;
        await invoke("stream_message", {
          request: {
            requestId,
            provider: selectedModel.type === "API" ? (selectedModel.providerId ?? provider?.id ?? "openai") : "ollama",
            model: selectedModel.id,
            providerConfig: provider ? { id: provider.id, baseUrl: provider.baseUrl } : undefined,
            contextSize: contextLimit,
            messages: contextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
          },
        });
      } catch {
      const ownership = requestOwnershipRef.current.get(requestId);
      if (!ownership) return;
      requestOwnershipRef.current.delete(requestId);
      setGeneratingConversationIds((current) => {
        const next = new Set(current);
        next.delete(ownership.conversationId);
        return next;
      });
      setConversations((current) => rollbackOwnedTurn(current, ownership));
      notify({ kind: "error", title: "Generation failed", description: "The selected AI provider could not complete the request." });
      }
    })();
    return true;
  }, [markConversationChanged, selectedModel, settings.contextSize, notify, providers]);

  const sendMessage = useCallback((draftContent: string) => {
    const content = draftContent.trim();
    if (!content) return false;
    const conversation = conversations.find((item) => item.id === activeConversationId);
    const createdAt = Date.now();
    const userMessage = { id: `message-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: "user" as const, content, createdAt };
    if (conversation) return startGeneration([...conversation.messages, userMessage], activeConversationId, conversation.messages.length === 0 ? titleFromPrompt(content) : conversation.title);
    const conversationId = `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const started = startGeneration([userMessage], conversationId, titleFromPrompt(content));
    if (started) setActiveConversationId(conversationId);
    return started;
  }, [activeConversationId, conversations, startGeneration]);

  const saveEditedQuestion = useCallback((index: number, content: string) => {
    const conversation = conversations.find((item) => item.id === activeConversationId);
    if (!conversation || hasActiveRequestForConversation(requestOwnershipRef.current, activeConversationId)) return;
    const editedMessages = replaceEditedUserBranch(conversation.messages, index, content);
    if (!editedMessages) return;
    markConversationChanged(activeConversationId);
    setConversations((current) => current.map((item) => item.id === activeConversationId ? {
      ...item,
      updatedAt: Date.now(),
      messages: editedMessages,
    } : item));
    startGeneration(editedMessages, activeConversationId, conversation.title);
  }, [activeConversationId, conversations, markConversationChanged, startGeneration]);

  const retryMessage = useCallback((index: number) => {
    const conversation = conversations.find((item) => item.id === activeConversationId);
    if (!conversation) return;
    let questionIndex = index;
    if (conversation.messages[questionIndex]?.role !== "user") questionIndex -= 1;
    const question = conversation.messages[questionIndex];
    if (!question || question.role !== "user") return;
    startGeneration(conversation.messages.slice(0, questionIndex + 1), activeConversationId);
  }, [activeConversationId, conversations, startGeneration]);

  const stopGeneration = useCallback(() => {
    const requestEntry = [...requestOwnershipRef.current.entries()].find(([, ownership]) => ownership.conversationId === activeConversationId);
    if (!requestEntry) return;
    const [requestId, ownership] = requestEntry;
    const snapshot = conversations.find((conversation) => conversation.id === ownership.conversationId);
    if (!snapshot) return;
    cancelledTurnSnapshotsRef.current.set(requestId, snapshot);
    cancelledRequestIdsRef.current.add(requestId);
    setGeneratingConversationIds((current) => {
      const next = new Set(current);
      next.delete(ownership.conversationId);
      return next;
    });
    setConversations((current) => stopOwnedTurn(current, ownership));
    const restoreIfCancellationFails = () => {
      if (!requestOwnershipRef.current.has(requestId)) return;
      const cancelledSnapshot = cancelledTurnSnapshotsRef.current.get(requestId);
      if (!cancelledSnapshot) return;
      setConversations((current) => current.map((conversation) => conversation.id === cancelledSnapshot.id ? cancelledSnapshot : conversation));
      cancelledTurnSnapshotsRef.current.delete(requestId);
    };
    void invoke<boolean>("cancel_message", { requestId }).then((cancelled) => {
      if (cancelled) {
        requestOwnershipRef.current.delete(requestId);
        cancelledRequestIdsRef.current.delete(requestId);
        cancelledTurnSnapshotsRef.current.delete(requestId);
        setConversations((current) => current.map((conversation) => conversation.id === ownership.conversationId ? { ...conversation, updatedAt: Date.now() } : conversation));
        return;
      }
      if (!requestOwnershipRef.current.has(requestId)) return;
      cancelledRequestIdsRef.current.delete(requestId);
      restoreIfCancellationFails();
      setGeneratingConversationIds((current) => new Set(current).add(ownership.conversationId));
    }).catch(() => {
      if (!requestOwnershipRef.current.has(requestId)) return;
      cancelledRequestIdsRef.current.delete(requestId);
      restoreIfCancellationFails();
      setGeneratingConversationIds((current) => new Set(current).add(ownership.conversationId));
    });
  }, [activeConversationId, conversations]);

  function resetSection(keys: (keyof SettingsState)[]) {
    setSettings((current) => {
      const next = { ...current };
      const defaults = defaultSettings as Record<string, unknown>;
      for (const key of keys) (next as Record<string, unknown>)[key] = defaults[key];
      return next;
    });
    notify({ kind: "success", title: "Settings reset", description: "The selected settings were restored to their defaults." });
  }

  function resetAllSettings() {
    setSettings((current) => ({ ...current, ...defaultSettings }));
    notify({ kind: "success", title: "Settings reset", description: "All settings were restored to their defaults." });
  }

  const pickDirectory = useCallback(async (target: "modelLocation" | "downloadsLocation") => {
    try {
      const result = await invoke<{ path: string | null; canceled: boolean }>("pick_folder", { title: target === "modelLocation" ? "Select model storage folder" : "Select downloads folder" });
      if (!result.canceled && result.path) {
        updateSetting(target, result.path);
        notify({ kind: "success", title: "Folder selected", description: result.path });
      }
    } catch {
      notify({ kind: "warning", title: "Folder picker unavailable", description: "The operating system folder dialog could not be opened." });
    }
  }, [updateSetting, notify]);

  const toggleDevtools = useCallback(() => {
    invoke<boolean>("toggle_devtools").catch(() => notify(describeBackendError("devtools")));
  }, [notify]);

  const exportLogs = useCallback(() => {
    const text = logs.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.level.toUpperCase()}: ${entry.message}`).join("\n");
    copyToClipboard(text).then(() => notify({ kind: "success", title: "Logs copied", description: "The application log was copied to the clipboard." })).catch(() => notify({ kind: "warning", title: "Copy failed", description: "The log could not be copied to the clipboard." }));
  }, [logs, notify]);

  const describePath = useCallback((status: PathValidationResult | null) => {
    if (!status) return "Checking…";
    if (!status.exists) return "Not found";
    if (!status.readable) return "Not accessible";
    return status.isDir ? "Folder ready" : "File ready";
  }, []);

  const infoRow = useCallback((label: string, value: string | null | undefined) => {
    const fallback = systemInfoStatus === "loading" ? "Loading..." : "Unavailable";
    return <div className="info-row"><span>{label}</span><strong>{value || fallback}</strong></div>;
  }, [systemInfoStatus]);

  return (
    <main className={`app-shell ${activeTheme} density-${settings.density} font-${settings.fontSize} accent-${settings.accent}`}>
      {isSidebarOpen && <button className="sidebar-backdrop" aria-label="Close conversations" onClick={() => setIsSidebarOpen(false)} />}
      <aside className={`sidebar ${isSidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-content">
          <div className="sidebar-heading">
            <span>Chats</span>
            <div className="sidebar-heading-actions">
              <button className="icon-button" aria-label="New folder" onClick={() => createFolder()}>
                <UIIcons.newFolder size={18} strokeWidth={1.5} />
              </button>
              <button className="icon-button" aria-label="New conversation" onClick={() => createConversation()}>
                <UIIcons.newConversation size={18} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          <button className="new-chat-button" onClick={() => createConversation()}>New chat <span>⌘ N</span></button>
          <div className="conversation-list" onContextMenu={(event) => openContextMenu(event, "empty")}>
            {rootConversations.map((conversation) => <div className={`conversation-entry ${draggedConversationId === conversation.id ? "dragging" : ""} ${dragTarget === `conversation:${conversation.id}` ? "drop-target" : ""}`} data-conversation-id={conversation.id} key={conversation.id} onPointerDown={(event) => startConversationDrag(event, conversation.id)} onContextMenu={(event) => openContextMenu(event, "conversation", conversation.id)}>
              {renamingId === conversation.id ? <input ref={renameInputRef} className="inline-rename" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onBlur={finishRename} onKeyDown={(event) => { if (event.key === "Enter") finishRename(); if (event.key === "Escape") setRenamingId(null); }} aria-label="Conversation name" /> : <button className={`conversation-item-button ${conversation.id === activeConversationId ? "active" : ""}`} onClick={() => selectConversation(conversation.id)}>{conversation.title}</button>}
            </div>)}
            {folders.map((folder) => {
              const FolderIconComponent = getFolderIconComponent(folder.icon);
              const conversationsInFolder = folderConversations(folder.id);
              return (
                <div className={`folder-entry ${folder.isOpen ? "folder-open" : ""} ${dragTarget === `folder:${folder.id}` ? "drop-target" : ""}`} data-folder-id={folder.id} key={folder.id} onContextMenu={(event) => openContextMenu(event, "folder", folder.id)}>
                  <div className="folder-row">
                    <button
                      type="button"
                      className="folder-icon"
                      onClick={(event) => openIconPicker(folder.id, event)}
                      aria-label={`Change icon for ${folder.name}`}
                    >
                      <FolderIconComponent size={16} strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      className="folder-toggle" 
                      onClick={(event) => { event.stopPropagation(); setFolders((current) => current.map((item) => item.id === folder.id ? { ...item, isOpen: !item.isOpen } : item)); }} 
                      aria-label={`${folder.isOpen ? "Collapse" : "Expand"} ${folder.name}`} 
                      aria-expanded={folder.isOpen}
                    >
                      <span className={`folder-chevron ${folder.isOpen ? "open" : ""}`} aria-hidden="true" />
                      {renamingId === folder.id ? (
                        <input 
                          ref={renameInputRef} 
                          className="inline-rename" 
                          value={renameDraft} 
                          onClick={(event) => event.stopPropagation()} 
                          onChange={(event) => setRenameDraft(event.target.value)} 
                          onBlur={finishRename} 
                          onKeyDown={(event) => { if (event.key === "Enter") finishRename(); if (event.key === "Escape") setRenamingId(null); }} 
                          aria-label="Folder name" 
                        />
                      ) : (
                        <span className="folder-name">{folder.name}</span>
                      )}
                      <span className="folder-count">{folder.conversationIds.length}</span>
                    </button>
                  </div>
                  <div className={`folder-children ${folder.isOpen ? "open" : "closed"}`}>
                    <div className="folder-children-inner">
                      {conversationsInFolder.length ? (
                        conversationsInFolder.map((conversation) => (
                          <div 
                            className={`conversation-entry nested ${draggedConversationId === conversation.id ? "dragging" : ""} ${dragTarget === `conversation:${conversation.id}` ? "drop-target" : ""}`} 
                            data-conversation-id={conversation.id} 
                            key={conversation.id} 
                            onPointerDown={(event) => startConversationDrag(event, conversation.id)} 
                            onContextMenu={(event) => openContextMenu(event, "conversation", conversation.id)}
                          >
                            <button 
                              className={`conversation-item-button ${conversation.id === activeConversationId ? "active" : ""}`} 
                              onClick={() => selectConversation(conversation.id)}
                            >
                              {conversation.title}
                            </button>
                          </div>
                        ))
                      ) : (
                        <span className="folder-empty">Empty folder</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {!rootConversations.length && !folders.length && <div className="sidebar-empty">No conversations yet</div>}
          </div>
          <div className="sidebar-footer">
            <button className="sidebar-link" onClick={() => { setActiveSettingsCategory("Models"); setIsSettingsOpen(true); setIsSidebarOpen(false); }}>
              <span className="status-dot" /> Local models
            </button>
            <button className="sidebar-link" onClick={() => { setIsSettingsOpen(true); setIsSidebarOpen(false); }}>
              <UIIcons.settings size={14} strokeWidth={1.5} /> Settings
            </button>
          </div>
        </div>
      </aside>

      <section className="chat-window">
        <header className="topbar">
          <div className="topbar-leading">
            <button className="icon-button menu-button" aria-label="Toggle conversations" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
              <UIIcons.menu size={20} strokeWidth={1.5} />
            </button>
            <span className="brand-mark" aria-hidden="true">
              <UIIcons.brand size={18} strokeWidth={1.5} />
            </span>
            <span className="brand-name">Aether</span>
          </div>
          <div className="topbar-spacer" />
          <Dropdown 
            value={selectedModel?.name ?? null} 
            onChange={(name) => { const model = availableModels.find((item) => item.name === name); if (model) setSelectedModel(model); }} 
            options={modelOptions}
            label="Choose a model" 
            ariaLabel="Choose a model" 
            align="end" 
            triggerClassName="model-selector" 
            onOpen={() => {
              const discoveryKey = settings.modelLocation;
              if (discoveryKeyRef.current !== discoveryKey) {
                discoveryKeyRef.current = discoveryKey;
                void discoverModels();
              }
            }}
            triggerChildren={
              <>
                <span className="model-glyph">
                  <UIIcons.brand size={16} strokeWidth={1.5} />
                </span>
                <span>
                  {selectedModel ? (
                    <>
                      {selectedModel.name} <span className="model-type">· {selectedModel.type}</span>
                    </>
                  ) : "No model available"}
                </span>
              </>
            } 
          />
        </header>

        <div className="conversation-area">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-mark">
                <UIIcons.brand size={32} strokeWidth={1.5} />
              </div>
              <h1>What can I help with?</h1>
              <p>Private, focused, and ready when you are.</p>
            </div>
          ) : (
            <MessageList ref={messageListRef} messages={messages} modelName={selectedModel?.name ?? "Assistant"} messageWidth={settings.messageWidth} markdown={settings.markdown} showTimestamps={settings.showTimestamps} showReasoning={settings.showReasoning} isGenerating={isGenerating} notify={notify} onSaveEdit={saveEditedQuestion} onRetry={retryMessage} />
          )}

          <Composer key={activeConversationId} selectedModel={selectedModel} enterToSend={settings.enterToSend} onSend={sendMessage} onStop={stopGeneration} isGenerating={isGenerating} />
        </div>
      </section>

      {contextMenu && createPortal(<div ref={contextMenuRef} className={`context-menu context-menu-${contextMenu.placement}`} style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()} role="menu">
        {contextMenu.type === "empty" && (
          <button onClick={createFolder}>
            <UIIcons.newFolder size={16} strokeWidth={1.5} /> New folder
          </button>
        )}
        {contextMenu.type === "conversation" && contextMenu.id && <>
          <button onClick={() => { const conversation = conversations.find((item) => item.id === contextMenu.id); if (conversation) beginRename(conversation.id, conversation.title); setContextMenu(null); }}>
            <UIIcons.rename size={16} strokeWidth={1.5} /> Rename
          </button>
          <div className="context-divider" />
          <span className="context-label">Move to</span>
          <button onClick={() => { moveConversation(contextMenu.id!, undefined); setContextMenu(null); }}>
            <UIIcons.move size={16} strokeWidth={1.5} /> Unfiled
          </button>
          {folders.map((folder) => (
            <button key={folder.id} onClick={() => { moveConversation(contextMenu.id!, folder.id); setContextMenu(null); }}>
              {folder.name}
            </button>
          ))}
          <div className="context-divider" />
          <button onClick={() => { duplicateConversation(contextMenu.id!); setContextMenu(null); }}>
            <UIIcons.newConversation size={16} strokeWidth={1.5} /> Duplicate
          </button>
          <button className="context-danger" onClick={() => { requestDeleteConversation(contextMenu.id!); setContextMenu(null); }}>
            <UIIcons.delete size={16} strokeWidth={1.5} /> Delete
          </button>
        </>}
        {contextMenu.type === "folder" && contextMenu.id && <>
          <button onClick={() => { const folder = folders.find((item) => item.id === contextMenu.id); if (folder) beginRename(folder.id, folder.name); setContextMenu(null); }}>
            <UIIcons.rename size={16} strokeWidth={1.5} /> Rename
          </button>
          <button onClick={(event) => openIconPicker(contextMenu.id!, event)}>
            <UIIcons.settings size={16} strokeWidth={1.5} /> Change icon
          </button>
          <button onClick={() => { createConversation(contextMenu.id); setContextMenu(null); }}>
            <UIIcons.newConversation size={16} strokeWidth={1.5} /> New conversation
          </button>
          <button onClick={() => { setFolders((current) => current.map((folder) => folder.id === contextMenu.id ? { ...folder, isOpen: !folder.isOpen } : folder)); setContextMenu(null); }}>
            {folders.find((folder) => folder.id === contextMenu.id)?.isOpen ? (
              <><UIIcons.collapse size={16} strokeWidth={1.5} /> Collapse</>
            ) : (
              <><UIIcons.expand size={16} strokeWidth={1.5} /> Expand</>
            )}
          </button>
          <div className="context-divider" />
          <button className="context-danger" onClick={() => { requestDeleteFolder(contextMenu.id!); setContextMenu(null); }}>
            <UIIcons.delete size={16} strokeWidth={1.5} /> Delete folder
          </button>
        </>}
      </div>, document.body)}

      {confirmState && (
        <div className="confirm-backdrop" role="presentation" onClick={() => setConfirmState(null)}>
          <div className={`confirm-dialog ${confirmState.danger ? "confirm-danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="confirm-title">{confirmState.title}</h2>
            <div className="confirm-body">{confirmState.body}</div>
            <div className="confirm-actions">
              <button ref={confirmCancelRef} className="quiet-button" onClick={() => setConfirmState(null)}>Cancel</button>
              <button className={`confirm-button ${confirmState.danger ? "confirm-button-danger" : ""}`} onClick={confirmState.onConfirm}>{confirmState.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="settings-backdrop" role="presentation" onClick={() => setIsSettingsOpen(false)}>
          <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
            <header className="settings-header">
              <div><p className="eyebrow">Preferences</p><h2 id="settings-title">Settings</h2></div>
              <button className="icon-button" aria-label="Close settings" onClick={() => setIsSettingsOpen(false)}>
                <UIIcons.close size={20} strokeWidth={1.5} />
              </button>
            </header>
            <div className="settings-layout">
              <nav className="settings-nav" aria-label="Settings categories">
                <SettingsSearch value={settingsSearch} onChange={setSettingsSearch} />
                <div className="settings-category-list">
                  {settingsCategories.map((category) => <button className={activeSettingsCategory === category ? "active" : ""} key={category} onClick={() => setActiveSettingsCategory(category)}>{category}</button>)}
                </div>
              </nav>
              <div className="settings-content">
                <SettingsSection title="Appearance" keywords="theme font size density accent color" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="Theme" description="Choose the appearance of the app"><SelectControl value={settings.theme} onChange={(value) => updateSetting("theme", value as Theme)} options={["dark", "light", "system"]} label="Theme" /></SettingsRow>
                  <SettingsRow label="Font size" description="Adjust the interface scale"><SelectControl value={settings.fontSize} onChange={(value) => updateSetting("fontSize", value as SettingsState["fontSize"])} options={["small", "medium", "large"]} label="Font size" /></SettingsRow>
                  <SettingsRow label="Chat density" description="Control the space between messages"><SelectControl value={settings.density} onChange={(value) => updateSetting("density", value as SettingsState["density"])} options={["comfortable", "compact"]} label="Chat density" /></SettingsRow>
                  <SettingsRow label="Accent color" description="A restrained highlight for controls"><SelectControl value={settings.accent} onChange={(value) => updateSetting("accent", value as SettingsState["accent"])} options={["sage", "blue", "violet"]} label="Accent color" /></SettingsRow>
                </SettingsSection>
                <SettingsSection title="Chat" keywords="enter send timestamps auto-scroll reasoning thinking width markdown code" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="Enter to send" description="Send messages with Enter"><Toggle checked={settings.enterToSend} onChange={(value) => updateSetting("enterToSend", value)} label="Enter to send" /></SettingsRow>
                  <SettingsRow label="Show timestamps" description="Display message times"><Toggle checked={settings.showTimestamps} onChange={(value) => updateSetting("showTimestamps", value)} label="Show timestamps" /></SettingsRow>
                  <SettingsRow label="Auto-scroll" description="Keep the latest response in view"><Toggle checked={settings.autoScroll} onChange={(value) => updateSetting("autoScroll", value)} label="Auto-scroll" /></SettingsRow>
                  <SettingsRow label="Show AI reasoning" description="Show thinking output provided by supported local models"><Toggle checked={settings.showReasoning} onChange={(value) => updateSetting("showReasoning", value)} label="Show AI reasoning" /></SettingsRow>
                  <SettingsRow label="Message width" description="Set the reading width of the chat"><SelectControl value={settings.messageWidth} onChange={(value) => updateSetting("messageWidth", value as SettingsState["messageWidth"])} options={["narrow", "wide"]} label="Message width" /></SettingsRow>
                  <SettingsRow label="Markdown and code" description="Render formatted responses"><SelectControl value={settings.markdown} onChange={(value) => updateSetting("markdown", value as SettingsState["markdown"])} options={["on", "plain"]} label="Markdown and code rendering" /></SettingsRow>
                </SettingsSection>
                <SettingsSection title="Models" keywords="installed local discover runtime ollama lm studio llama gguf refresh management status" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <div className="section-heading">
                    <h4>Local runtimes</h4>
                    <button className="quiet-button" disabled={discoveringModels} onClick={() => discoverModels()}>{discoveringModels ? "Scanning…" : "Refresh"}</button>
                  </div>
                  <div className="runtime-list">
                    {runtimes.length === 0 && <p className="empty-setting-state">Scanning for local runtimes…</p>}
                    {runtimes.map((runtime) => <div className="runtime-card" key={runtime.id}>
                      <div className="runtime-header">
                        <span className={`runtime-dot ${runtime.available ? "available" : ""}`} />
                        <strong>{runtime.name}</strong>
                        <span className={`runtime-badge ${runtime.available ? "available" : ""}`}>{runtime.available ? "Available" : "Unavailable"}</span>
                      </div>
                      <p className="runtime-detail">{runtime.detail}</p>
                      {runtime.models.length > 0 && <div className="runtime-models">{runtime.models.map((model) => <div className="runtime-model-row" key={model.id}><span><strong>{model.name}</strong><small>{model.backend}{model.path ? ` · ${model.path}` : ""}</small></span><span className="model-status">{model.detail}</span></div>)}</div>}
                    </div>)}
                  </div>
                  <SettingsRow label="Default model" description="Select the model used for new chats"><SelectControl value={availableModels.some((model) => model.name === settings.defaultModel) ? settings.defaultModel : "Unavailable"} onChange={(value) => { updateSetting("defaultModel", value); const model = availableModels.find((item) => item.name === value); if (model) setSelectedModel(model); }} options={availableModels.length ? modelNames : ["Unavailable"]} label="Default model" disabled={!availableModels.length} /></SettingsRow>
                  <div className="section-heading"><h4>Discovered models</h4><span className="placeholder-label">From local runtimes</span></div>
                  <div className="local-model-list">{installedModels.length ? installedModels.map((model) => <div className="local-model-row" key={model.id}><span><strong>{model.name}</strong><small>{model.backend} · {formatBytes(model.sizeBytes)}</small></span><span className="model-status">{model.status}</span></div>) : <p className="empty-setting-state">No local models detected.</p>}</div>
                  <SettingsRow label="Model parameters" description="Applied once the local inference engine is available"><SelectControl value={settings.modelParameters} onChange={(value) => updateSetting("modelParameters", value as SettingsState["modelParameters"])} options={["balanced", "creative", "precise"]} label="Model parameters" disabled /></SettingsRow>
                </SettingsSection>
                <SettingsSection title="AI Providers" keywords="api add remove enable disable test connection default provider" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <p className="section-note">Provider metadata is persisted without keys; credentials use secure desktop storage.</p>
                  <form className="add-api-form" onSubmit={addApiProvider}><div className="api-form-fields"><input name="apiKey" type="password" placeholder="API key" aria-label="API key" autoComplete="off" /><input name="baseUrl" type="text" inputMode="url" placeholder="Base URL (optional)" aria-label="Optional base URL" /></div><button className="text-button add-api-button" type="submit">+ Add API</button></form>
                  <div className="provider-list">{providers.length ? providers.map((provider) => <div className="provider-row" key={provider.id}><div className="provider-info"><span className={`provider-status ${provider.enabled ? "enabled" : ""}`} /><span><strong>{provider.name}</strong><small>{provider.detail}</small></span></div><div className="provider-controls"><span className="key-status">Credentials stored securely</span><button className="quiet-button" onClick={() => void discoverProviderModels(provider)}>Test connection</button><Toggle checked={provider.enabled} onChange={() => toggleProvider(provider.id)} label={`${provider.name} enabled`} /><button className="remove-button" onClick={() => requestRemoveProvider(provider)}><UIIcons.delete size={14} strokeWidth={1.5} /></button></div></div>) : <p className="empty-setting-state">No API providers added.</p>}</div>
                  <SettingsRow label="Default provider" description="Used for future chats"><SelectControl value={settings.defaultProvider} onChange={(value) => updateSetting("defaultProvider", value)} options={["local", ...providers.filter((provider) => provider.enabled).map((provider) => provider.id)]} label="Default provider" /></SettingsRow>
                </SettingsSection>
                <SettingsSection title="Privacy" keywords="local-only clear conversations credentials telemetry" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="Local-only mode" description="Keep chat requests on this device"><Toggle checked={settings.localOnly} onChange={(value) => updateSetting("localOnly", value)} label="Local-only mode" /></SettingsRow>
                  <SettingsRow label="Clear conversations" description="Remove all conversations from this session"><button className="quiet-button" onClick={requestClearAllConversations}>Clear</button></SettingsRow>
                  <SettingsRow label="Clear stored credentials" description="Remove credentials from OS secure storage"><button className="quiet-button" onClick={requestClearStoredCredentials}>Clear</button></SettingsRow>
                  <SettingsRow label="Telemetry" description="Telemetry is not implemented"><Toggle checked={settings.telemetry} onChange={(value) => updateSetting("telemetry", value)} label="Telemetry" disabled /></SettingsRow>
                </SettingsSection>
                <SettingsSection title="Performance" keywords="cpu gpu threads context memory system information hardware" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="CPU/GPU preference" description="Preference for the future local inference engine"><SelectControl value={settings.hardware} onChange={(value) => updateSetting("hardware", value as SettingsState["hardware"])} options={["auto", "cpu", "gpu"]} label="CPU/GPU preference" /></SettingsRow>
                  <SettingsRow label="CPU thread count" description="Applied when the local runtime is available"><SelectControl value={settings.cpuThreads} onChange={(value) => updateSetting("cpuThreads", value)} options={["Auto", "2", "4", "8"]} label="CPU thread count" /></SettingsRow>
                  <SettingsRow label="Context size" description="Capped by the selected model when its limit is known"><SelectControl value={settings.contextSize} onChange={(value) => updateSetting("contextSize", value as SettingsState["contextSize"])} options={["4k", "8k", "16k", "32k", "64k", "128k"]} label="Context size" /></SettingsRow>
                  <div className="section-heading"><h4>System information</h4><span className="placeholder-label">Live from the OS</span></div>
                  <div className="info-list">
                    {infoRow("Operating system", systemInfo ? `${systemInfo.osName ?? ""} ${systemInfo.osVersion ?? ""}`.trim() : null)}
                    {infoRow("Processor", systemInfo?.cpu ? `${systemInfo.cpu.name || systemInfo.cpu.brand || "Unavailable"} · ${systemInfo.cpuCount} threads` : null)}
                    {infoRow("Physical cores", systemInfo?.physicalCores != null ? String(systemInfo.physicalCores) : null)}
                    {infoRow("Memory", systemInfo ? `${formatBytes(systemInfo.usedMemoryBytes)} / ${formatBytes(systemInfo.totalMemoryBytes)}` : null)}
                    {infoRow("Disk", systemInfo ? `${formatBytes(systemInfo.totalDiskBytes - systemInfo.availableDiskBytes)} used of ${formatBytes(systemInfo.totalDiskBytes)}` : null)}
                    {infoRow("Graphics", systemInfo?.gpu ?? null)}
                    {infoRow("Uptime", systemInfo ? formatDuration(systemInfo.uptimeSeconds) : null)}
                  </div>
                  <SettingsRow label="Reset performance" description="Restore performance preferences to defaults"><button className="quiet-button" onClick={() => resetSection(performanceKeys)}>Reset</button></SettingsRow>
                </SettingsSection>
                <SettingsSection title="Files" keywords="model storage downloads folder picker paths attachments" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="Model storage location" description="Used to discover GGUF models; separate multiple folders with a semicolon">
                    <div className="path-control">
                      <input className="setting-input" value={settings.modelLocation} onChange={(event) => updateSetting("modelLocation", event.target.value)} aria-label="Model storage location" />
                      <button className="quiet-button" onClick={() => pickDirectory("modelLocation")}>Browse…</button>
                    </div>
                  </SettingsRow>
                  <p className={`path-status ${pathStatus.modelDirectory?.exists && pathStatus.modelDirectory.readable ? "ok" : ""}`}>{describePath(pathStatus.modelDirectory)}</p>
                  <SettingsRow label="Downloads location" description="Folder used for downloads">
                    <div className="path-control">
                      <input className="setting-input" value={settings.downloadsLocation} onChange={(event) => updateSetting("downloadsLocation", event.target.value)} aria-label="Downloads location" />
                      <button className="quiet-button" onClick={() => pickDirectory("downloadsLocation")}>Browse…</button>
                    </div>
                  </SettingsRow>
                  <p className={`path-status ${pathStatus.downloads?.exists && pathStatus.downloads.readable ? "ok" : ""}`}>{describePath(pathStatus.downloads)}</p>
                  <SettingsRow label="Attachments" description="Attachment handling is not implemented"><SelectControl value={settings.attachments} onChange={(value) => updateSetting("attachments", value as SettingsState["attachments"])} options={["ask", "allow", "off"]} label="Attachment preferences" disabled /></SettingsRow>
                  <SettingsRow label="Reset paths" description="Restore storage paths to defaults"><button className="quiet-button" onClick={() => resetSection(filesKeys)}>Reset</button></SettingsRow>
                </SettingsSection>
                <SettingsSection title="Shortcuts" keywords="new chat sidebar composer send message keyboard" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="New chat"><kbd>{settings.newChatShortcut}</kbd></SettingsRow><SettingsRow label="Open sidebar"><kbd>{settings.sidebarShortcut}</kbd></SettingsRow><SettingsRow label="Focus composer"><kbd>{settings.composerShortcut}</kbd></SettingsRow><SettingsRow label="Send message"><kbd>{settings.sendShortcut}</kbd></SettingsRow>
                </SettingsSection>
                <SettingsSection title="Advanced" keywords="developer debug logging experimental reset tools console logs" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="Developer mode" description="Enables the developer tools toggle"><Toggle checked={settings.developerMode} onChange={(value) => updateSetting("developerMode", value)} label="Developer mode" /></SettingsRow>
                  <SettingsRow label="Developer tools" description={settings.developerMode ? "Open the webview developer tools window" : "Enable Developer mode to use this"}><button className="quiet-button" disabled={!settings.developerMode} onClick={toggleDevtools}>Toggle devtools</button></SettingsRow>
                  <SettingsRow label="Debug and logging" description="Forward console messages to the application log"><Toggle checked={settings.debugLogging} onChange={(value) => updateSetting("debugLogging", value)} label="Debug and logging" /></SettingsRow>
                  {settings.debugLogging && (
                    <div className="log-viewer">
                      <div className="log-toolbar"><span>Application log</span><span><button className="quiet-button" onClick={() => { invoke("clear_logs").then(() => setLogs([])).catch(() => notify(describeBackendError("logs"))); }}>Clear</button><button className="quiet-button" onClick={exportLogs}>Copy</button></span></div>
                      <div className="log-entry-list">{logs.length ? logs.slice().reverse().map((entry, index) => <div className={`log-entry log-${entry.level}`} key={`${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span>{entry.message}</span></div>) : <p className="empty-setting-state">No log entries yet.</p>}</div>
                    </div>
                  )}
                  <SettingsRow label="Experimental features" description="No experimental features are available yet"><Toggle checked={settings.experimental} onChange={(value) => updateSetting("experimental", value)} label="Experimental features" disabled /></SettingsRow>
                  <SettingsRow label="Reset settings" description="Restore all settings to their defaults"><button className="quiet-button" onClick={resetAllSettings}>Reset all</button></SettingsRow>
                </SettingsSection>
                <SettingsSection title="About" keywords="version update documentation github licenses" activeCategory={activeSettingsCategory} searchQuery={settingsSearch}>
                  <SettingsRow label="Aether" description="AI workspace"><span className="key-status">Version {appVersion}</span></SettingsRow>
                  <SettingsRow label="Updates" description={availableUpdate ? `Version ${availableUpdate.version} is available` : "Check the official signed release channel"}>
                    <span className="about-update-actions">
                      {availableUpdate && <button className="quiet-button" disabled={installingUpdate} onClick={() => void installUpdate()}>{installingUpdate ? "Installing…" : "Update now"}</button>}
                      {availableUpdate && <button className="quiet-button" disabled={installingUpdate} onClick={() => setAvailableUpdate(null)}>Later</button>}
                      <button className="quiet-button" disabled={checkingUpdates || installingUpdate} onClick={() => void checkForUpdates(true)}>{checkingUpdates ? "Checking…" : "Check for updates"}</button>
                    </span>
                  </SettingsRow>
                  <SettingsRow label="Resources" description="Project links and notices"><span className="about-links"><a href="#docs">Documentation</a><a href="#github">GitHub</a><a href="#licenses">Licenses</a></span></SettingsRow>
                </SettingsSection>
              </div>
            </div>
          </section>
        </div>
      )}

      {iconPickerOpen && (
        <IconPicker
          isOpen={iconPickerOpen}
          onClose={closeIconPicker}
          onSelect={(iconName) => {
            if (iconPickerFolderId) {
              updateFolderIcon(iconPickerFolderId, iconName);
            }
          }}
          selectedIcon={iconPickerFolderId ? folders.find((f) => f.id === iconPickerFolderId)?.icon : undefined}
          anchorX={iconPickerPosition.x}
          anchorY={iconPickerPosition.y}
        />
      )}
    </main>
  );
}

function App() {
  return <NotificationProvider><AppErrorBoundary><AppContent /></AppErrorBoundary></NotificationProvider>;
}

export default App;