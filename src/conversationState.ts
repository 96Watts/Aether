export type ConversationMessageState = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  contextExcluded?: boolean;
};

export type ConversationState = {
  id: string;
  messages: ConversationMessageState[];
  updatedAt: number;
};

export type RequestOwnership = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
};

export type OwnedStreamEvent = {
  requestId: string;
  kind: "thinking" | "chunk" | "done" | "error";
  content: string | null;
};

const CONTEXT_SIZE_TOKENS: Record<string, number> = {
  "4k": 4096,
  "8k": 8192,
  "16k": 16384,
  "32k": 32768,
  "64k": 65536,
  "128k": 131072,
};

export function contextSizeToTokens(value: string) {
  return CONTEXT_SIZE_TOKENS[value] ?? CONTEXT_SIZE_TOKENS["8k"];
}

function estimatedMessageTokens(message: ConversationMessageState) {
  return Math.max(1, Math.ceil((message.role.length + message.content.length) / 4) + 4);
}

export function buildContextMessages<M extends ConversationMessageState>(messages: M[], maxTokens: number): M[] {
  const validMessages = messages.filter((message) => message.content.trim().length > 0 && !message.contextExcluded);
  if (!validMessages.length) return [];
  const newestUserIndex = validMessages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  const newestIndex = newestUserIndex >= 0 ? newestUserIndex : validMessages.length - 1;
  const budget = Math.max(1, maxTokens);
  const selected: M[] = [];
  let usedTokens = 0;

  for (let index = newestIndex; index >= 0;) {
    const groupStart = validMessages[index].role === "assistant" && index > 0 && validMessages[index - 1].role === "user" ? index - 1 : index;
    const group = validMessages.slice(groupStart, index + 1);
    const groupTokens = group.reduce((total, message) => total + estimatedMessageTokens(message), 0);
    if (selected.length > 0 && usedTokens + groupTokens > budget) break;
    if (selected.length === 0 && groupTokens > budget) {
      const newestMessage = group[group.length - 1];
      const maxCharacters = Math.max(4, (budget - 4) * 4);
      selected.push({ ...newestMessage, content: newestMessage.content.slice(-maxCharacters) });
      break;
    }
    selected.unshift(...group);
    usedTokens += groupTokens;
    index = groupStart - 1;
  }

  return selected;
}

export function hasActiveRequestForConversation(ownership: ReadonlyMap<string, RequestOwnership>, conversationId: string) {
  for (const request of ownership.values()) {
    if (request.conversationId === conversationId) return true;
  }
  return false;
}

export function shouldHydrateConversation(ownership: ReadonlyMap<string, RequestOwnership>, conversationId: string) {
  return !hasActiveRequestForConversation(ownership, conversationId);
}

export function removeOwnedTurn<C extends ConversationState>(conversations: C[], ownership: RequestOwnership): C[] {
  return conversations.map((conversation) => conversation.id === ownership.conversationId ? {
    ...conversation,
    messages: conversation.messages.filter((message) => message.id !== ownership.userMessageId && message.id !== ownership.assistantMessageId),
  } : conversation) as C[];
}

export function rollbackOwnedTurn<C extends ConversationState>(conversations: C[], ownership: RequestOwnership): C[] {
  return conversations.map((conversation) => conversation.id === ownership.conversationId ? {
    ...conversation,
    messages: conversation.messages.filter((message) => message.id !== ownership.assistantMessageId),
  } : conversation) as C[];
}

export function stopOwnedTurn<C extends ConversationState>(conversations: C[], ownership: RequestOwnership): C[] {
  return conversations.map((conversation) => conversation.id === ownership.conversationId ? {
    ...conversation,
    messages: conversation.messages
      .filter((message) => message.id !== ownership.assistantMessageId)
      .map((message) => message.id === ownership.userMessageId ? { ...message, contextExcluded: true } : message),
  } : conversation) as C[];
}

export function replaceEditedUserBranch<M extends ConversationMessageState>(messages: M[], index: number, content: string): M[] | null {
  const message = messages[index];
  if (!message || message.role !== "user" || !content.trim()) return null;
  return [...messages.slice(0, index), { ...message, content: content.trim() } as M];
}

export function appendAssistantPlaceholder<M extends ConversationMessageState>(messages: M[], assistantMessageId: string, createdAt: number, extra?: Partial<M>): M[] {
  return [...messages, { id: assistantMessageId, role: "assistant", content: "", createdAt, ...extra } as unknown as M];
}

export function applyOwnedStreamEvent<C extends ConversationState>(
  conversations: C[],
  event: OwnedStreamEvent,
  ownership: RequestOwnership | undefined,
  maxReasoningCharacters: number,
): C[] {
  if (!ownership || (event.kind !== "thinking" && event.kind !== "chunk") || !event.content) return conversations;
  return conversations.map((conversation) => conversation.id === ownership.conversationId ? {
    ...conversation,
    messages: conversation.messages.map((message) => {
      if (message.id !== ownership.assistantMessageId || message.role !== "assistant") return message;
      if (event.kind === "thinking") {
        const reasoning = `${message.reasoning ?? ""}${event.content}`;
        return { ...message, reasoning: reasoning.length > maxReasoningCharacters ? reasoning.slice(-maxReasoningCharacters) : reasoning };
      }
      return { ...message, content: `${message.content}${event.content}` };
    }),
  } : conversation) as C[];
}
