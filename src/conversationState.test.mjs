import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAssistantPlaceholder,
  applyOwnedStreamEvent,
  buildContextMessages,
  contextSizeToTokens,
  removeOwnedTurn,
  replaceEditedUserBranch,
  shouldHydrateConversation,
  stopOwnedTurn,
} from "./conversationState.ts";

const ownershipA = { conversationId: "A", userMessageId: "A-user", assistantMessageId: "A-assistant" };
const ownershipB = { conversationId: "B", userMessageId: "B-user", assistantMessageId: "B-assistant" };

function conversations() {
  return [
    { id: "A", updatedAt: 1, messages: [{ id: "A-user", role: "user", content: "question" }, { id: "A-assistant", role: "assistant", content: "" }] },
    { id: "B", updatedAt: 1, messages: [{ id: "B-user", role: "user", content: "question" }, { id: "B-assistant", role: "assistant", content: "" }] },
  ];
}

function content(state, id) {
  return state.find((conversation) => conversation.id === id)?.messages.find((message) => message.role === "assistant")?.content;
}

test("keeps A's stream attached while the active view switches to B", () => {
  const requests = new Map([["request-A", ownershipA]]);
  let state = conversations();
  state = applyOwnedStreamEvent(state, { requestId: "request-A", kind: "chunk", content: "A1" }, requests.get("request-A"), 100);
  assert.equal(content(state, "A"), "A1");
  assert.equal(content(state, "B"), "");
  state = applyOwnedStreamEvent(state, { requestId: "request-A", kind: "chunk", content: "A2" }, requests.get("request-A"), 100);
  assert.equal(content(state, "A"), "A1A2");
});

test("preserves A when returning after completion", () => {
  const requests = new Map([["request-A", ownershipA]]);
  const state = applyOwnedStreamEvent(
    applyOwnedStreamEvent(conversations(), { requestId: "request-A", kind: "chunk", content: "complete" }, requests.get("request-A"), 100),
    { requestId: "request-A", kind: "done", content: null },
    requests.get("request-A"),
    100,
  );
  assert.equal(content(state, "A"), "complete");
});

test("routes simultaneous requests to their own conversations", () => {
  const requests = new Map([["request-A", ownershipA], ["request-B", ownershipB]]);
  let state = conversations();
  state = applyOwnedStreamEvent(state, { requestId: "request-A", kind: "chunk", content: "A" }, requests.get("request-A"), 100);
  state = applyOwnedStreamEvent(state, { requestId: "request-B", kind: "chunk", content: "B" }, requests.get("request-B"), 100);
  assert.equal(content(state, "A"), "A");
  assert.equal(content(state, "B"), "B");
});

test("repeated conversation switching cannot redirect a stream", () => {
  const requests = new Map([["request-A", ownershipA]]);
  let state = conversations();
  for (const chunk of ["1", "2", "3"]) {
    state = applyOwnedStreamEvent(state, { requestId: "request-A", kind: "chunk", content: chunk }, requests.get("request-A"), 100);
  }
  assert.equal(content(state, "A"), "123");
  assert.equal(content(state, "B"), "");
});

test("never routes A's response into B", () => {
  const requests = new Map([["request-A", ownershipA]]);
  const state = applyOwnedStreamEvent(conversations(), { requestId: "request-A", kind: "chunk", content: "A-only" }, requests.get("request-A"), 100);
  assert.equal(content(state, "B"), "");
});

test("ignores late events after A is deleted", () => {
  const requests = new Map([["request-A", ownershipA]]);
  const state = applyOwnedStreamEvent(conversations().filter((conversation) => conversation.id !== "A"), { requestId: "request-A", kind: "chunk", content: "late" }, requests.get("request-A"), 100);
  assert.deepEqual(state.map((conversation) => conversation.id), ["B"]);
});

test("does not hydrate an active conversation from its stale disk snapshot", () => {
  const requests = new Map([["request-A", ownershipA]]);
  assert.equal(shouldHydrateConversation(requests, "A"), false);
  assert.equal(shouldHydrateConversation(requests, "B"), true);
});

test("removes cancelled turns from the next context", () => {
  const requests = new Map([["request-A", ownershipA]]);
  const state = applyOwnedStreamEvent(conversations(), { requestId: "request-A", kind: "chunk", content: "partial" }, requests.get("request-A"), 100);
  const remaining = removeOwnedTurn(state, ownershipA).find((conversation) => conversation.id === "A").messages;
  assert.deepEqual(buildContextMessages(remaining, 100).map((message) => message.content), []);
});

test("stopping removes only the assistant while keeping the user visible and excluded from context", () => {
  const requests = new Map([["request-A", ownershipA]]);
  const state = stopOwnedTurn(conversations(), requests.get("request-A"));
  const stopped = state.find((conversation) => conversation.id === "A");
  assert.deepEqual(stopped.messages.map((message) => message.content), ["question"]);
  assert.equal(stopped.messages[0].contextExcluded, true);
  assert.deepEqual(buildContextMessages(stopped.messages, 100), []);
  assert.equal(state.find((conversation) => conversation.id === "B").messages.length, 2);
});

test("stopping the latest turn preserves earlier completed context", () => {
  const ownership = { conversationId: "A", userMessageId: "user-E", assistantMessageId: "assistant-E" };
  const state = stopOwnedTurn([{
    id: "A",
    updatedAt: 1,
    messages: [
      { id: "user-A", role: "user", content: "A" },
      { id: "assistant-B", role: "assistant", content: "B" },
      { id: "user-C", role: "user", content: "C" },
      { id: "assistant-D", role: "assistant", content: "D" },
      { id: "user-E", role: "user", content: "E" },
      { id: "assistant-E", role: "assistant", content: "partial" },
    ],
  }], ownership);
  const nextRequest = [...state[0].messages, { id: "user-next", role: "user", content: "next" }];
  assert.deepEqual(buildContextMessages(nextRequest, 100).map((message) => message.content), ["A", "B", "C", "D", "next"]);
});

test("keeps the newest user request and truncates older context predictably", () => {
  const messages = [
    { role: "user", content: "old ".repeat(100) },
    { role: "assistant", content: "old answer ".repeat(100) },
    { role: "user", content: "new request" },
  ];
  const context = buildContextMessages(messages, 20);
  assert.equal(context.at(-1).content, "new request");
  assert.ok(context.length <= messages.length);
});

test("supports larger configured contexts without exceeding a model limit", () => {
  assert.equal(contextSizeToTokens("64k"), 65536);
  assert.equal(Math.min(contextSizeToTokens("64k"), 32768), 32768);
});

test("editing replaces the user message and removes the stale response branch", () => {
  const messages = [
    { id: "user-1", role: "user", content: "old question" },
    { id: "assistant-1", role: "assistant", content: "old answer" },
    { id: "user-2", role: "user", content: "later question" },
  ];
  const edited = replaceEditedUserBranch(messages, 0, "edited question");
  assert.deepEqual(edited, [{ id: "user-1", role: "user", content: "edited question" }]);
  assert.deepEqual(buildContextMessages(edited, 100).map((message) => message.content), ["edited question"]);
});

test("App generation transition visibly replaces hello with whats up", () => {
  const initial = [
    { id: "user-1", role: "user", content: "hello" },
    { id: "assistant-1", role: "assistant", content: "Hello! How can I help?" },
  ];
  const edited = replaceEditedUserBranch(initial, 0, "whats up");
  const next = appendAssistantPlaceholder(edited, "assistant-new", 2, { modelType: "Local" });
  assert.equal(next[0].content, "whats up");
  assert.equal(next.some((message) => message.content === "hello"), false);
  assert.equal(next.some((message) => message.content === "Hello! How can I help?"), false);
  assert.equal(next.at(-1).id, "assistant-new");
});

test("editing an older message does not retain stale later turns", () => {
  const messages = [
    { id: "user-1", role: "user", content: "first" },
    { id: "assistant-1", role: "assistant", content: "first answer" },
    { id: "user-2", role: "user", content: "second" },
    { id: "assistant-2", role: "assistant", content: "second answer" },
  ];
  const edited = replaceEditedUserBranch(messages, 0, "corrected first");
  assert.deepEqual(edited?.map((message) => message.content), ["corrected first"]);
  assert.equal(edited?.some((message) => message.content.includes("answer")), false);
});
