import assert from "node:assert/strict";
import test from "node:test";
import { DefaultContextManager } from "../../src/agent/context-manager.ts";
import type { Message } from "../../src/agent/types.ts";

test("keeps system prompt, current request, and recent turns while summarizing old history", async () => {
  const manager = new DefaultContextManager({ summarize: async () => "历史工作摘要" });
  const messages: Message[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "old request ".repeat(20) },
    { role: "assistant", content: "old answer ".repeat(20) },
    { role: "user", content: "current request" },
    { role: "assistant", content: "current answer" },
  ];
  const result = await manager.compact(messages, { maxInputTokens: 60, recentTurns: 1 });
  assert.ok(result.messages.some((message) => message.role === "system" && message.content === "rules"));
  assert.ok(result.messages.some((message) => message.role === "user" && message.content === "current request"));
  assert.equal(result.summaries.length, 1);
  assert.equal(result.summaries[0].content, "历史工作摘要");
  assert.equal(messages[1].content, "old request ".repeat(20));
});

test("truncates oversized tool output without mutating the source", async () => {
  const tool: Message = { role: "tool", content: "a".repeat(10_000), toolCallId: "1", toolName: "read_file" };
  const messages: Message[] = [{ role: "user", content: "inspect" }, tool];
  const result = await new DefaultContextManager().compact(messages, { maxInputTokens: 10_000, maxToolOutputTokens: 20 });
  assert.match(result.messages[1].content, /tool output truncated/);
  assert.equal(tool.content.length, 10_000);
  assert.equal(result.degradation, "tool_output_truncated");
});

test("uses deterministic summary when the summarizer fails", async () => {
  const manager = new DefaultContextManager({ summarize: async () => { throw new Error("unavailable"); } });
  const result = await manager.compact([
    { role: "user", content: "old ".repeat(20) },
    { role: "assistant", content: "answer ".repeat(20) },
    { role: "user", content: "new" },
    { role: "assistant", content: "answer ".repeat(20) },
  ], { maxInputTokens: 60, recentTurns: 1 });
  assert.match(result.summaries[0].content, /user: old/);
});

test("reuses an existing summary for an unchanged historical prefix", async () => {
  let calls = 0;
  const manager = new DefaultContextManager({ summarize: async () => { calls += 1; return "cached history"; } });
  const messages: Message[] = [
    { role: "user", content: "old ".repeat(20) },
    { role: "assistant", content: "answer ".repeat(20) },
    { role: "user", content: "new" },
    { role: "assistant", content: "recent" },
  ];
  await manager.compact(messages, { maxInputTokens: 60, recentTurns: 1 });
  await manager.compact(messages, { maxInputTokens: 60, recentTurns: 1 });
  assert.equal(calls, 1);
});

test("restores persisted summary segments without calling the summarizer", async () => {
  let firstCalls = 0;
  const messages: Message[] = [{ role: "user", content: "old ".repeat(20) }, { role: "assistant", content: "answer ".repeat(20) }, { role: "user", content: "new" }];
  const first = new DefaultContextManager({ summarize: async () => { firstCalls += 1; return "persisted"; } });
  const checkpoint = await first.exportCheckpoint("session", messages, { maxInputTokens: 60, recentTurns: 1 });
  assert.ok(checkpoint);
  assert.equal(firstCalls, 1);
  let restoredCalls = 0;
  const restored = new DefaultContextManager({ summarize: async () => { restoredCalls += 1; return "unexpected"; } });
  assert.equal(restored.restoreCheckpoint(checkpoint, messages), true);
  await restored.compact(messages, { maxInputTokens: 60, recentTurns: 1 });
  assert.equal(restoredCalls, 0);
});

test("records original indexes and keeps the current tool pair intact", async () => {
  const manager = new DefaultContextManager({ summarize: async () => "old summary" });
  const messages: Message[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "old request ".repeat(20) },
    { role: "assistant", content: "old call", toolCalls: [{ id: "old-call", name: "read_file", input: { path: "a" } }] },
    { role: "tool", content: "old result ".repeat(20), toolCallId: "old-call", toolName: "read_file" },
    { role: "user", content: "current" },
    { role: "assistant", content: "current call", toolCalls: [{ id: "current-call", name: "read_file", input: { path: "b" } }] },
    { role: "tool", content: "current result", toolCallId: "current-call", toolName: "read_file" },
  ];
  const result = await manager.compact(messages, { maxInputTokens: 55, recentTurns: 1 });
  assert.deepEqual(result.summaries[0].sourceMessageIndexes, [1, 2, 3]);
  const currentAssistant = result.messages.find((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "current-call");
  const currentTool = result.messages.find((message) => message.role === "tool" && message.toolCallId === "current-call");
  assert.ok(currentAssistant);
  assert.ok(currentTool);
});

test("collapses a complete historical multi-tool batch", async () => {
  const manager = new DefaultContextManager();
  const result = await manager.compact([
    { role: "user", content: "old" },
    { role: "assistant", content: "calls", toolCalls: [{ id: "a", name: "read_file", input: {} }, { id: "b", name: "search_text", input: {} }] },
    { role: "tool", content: "one", toolCallId: "a", toolName: "read_file" },
    { role: "tool", content: "two", toolCallId: "b", toolName: "search_text" },
    { role: "user", content: "new" },
  ], { maxInputTokens: 25, recentTurns: 1 });
  assert.ok(result.degradation === "context_collapsed" || result.degradation === "old_messages_summarized");
  assert.ok(result.messages.some((message) => message.role === "assistant" && message.content.includes("连续工具批次")) || result.summaries.length > 0);
});

test("calibrates subsequent estimates from provider input usage", async () => {
  const manager = new DefaultContextManager();
  const messages: Message[] = [{ role: "user", content: "inspect this source file" }];
  const first = await manager.compact(messages, 1_000);
  const actualInputTokens = Math.ceil(first.rawEstimatedTokens * 1.4);
  manager.observeUsage(first, {
    inputTokens: actualInputTokens,
    outputTokens: 10,
    totalTokens: actualInputTokens + 10,
  });
  const second = await manager.compact(messages, 1_000);
  assert.ok(second.calibrationFactor > 1);
  assert.ok(second.estimatedTokens >= actualInputTokens);
  assert.equal(second.rawEstimatedTokens, first.rawEstimatedTokens);
});
