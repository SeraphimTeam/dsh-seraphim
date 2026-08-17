// Regression: claude-code must not surface an empty "Think" disclosure.
//
// Root cause (verified from a decoded session log): Claude Opus (and
// interleaved thinking) can open a `thinking` content block that carries only
// an encrypted signature or an empty `thinking_delta`, with no visible text.
// The translator used to emit block-start + block-end for that block anyway,
// and the host UI renders a "Think" row for ANY reasoning block — so the user
// saw an empty, expandable Think box with nothing inside.
//
// Fix: reasoning blocks are emitted lazily — block-start is deferred until the
// first non-empty thinking_delta arrives, and the block is dropped entirely if
// none does. Text/tool blocks stay eager so empty-argument tool calls survive.
import assert from "node:assert/strict";
import { translateAnthropicSse } from "../lib/providers/claude-code.js";

const run = async (events) => {
  async function* gen() {
    for (const e of events) yield JSON.stringify(e);
  }
  const out = [];
  for await (const ev of translateAnthropicSse(gen())) out.push(ev);
  return out;
};
const kinds = (o) => o.map((e) => e.type);

// CASE 1: the exact captured bug — reasoning opens with empty thinking, then text.
{
  const o = await run([
    { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi! How can I help?" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  assert.ok(!kinds(o).includes("reasoning-delta"), "no reasoning-delta for empty thinking");
  assert.equal(o.filter((e) => e.type === "block-start" && e.blockType === "reasoning").length, 0, "no reasoning block-start");
  const tStart = o.find((e) => e.type === "block-start" && e.blockType === "text");
  assert.ok(tStart, "text block-start emitted");
  const ends = o.filter((e) => e.type === "block-end");
  assert.equal(ends.length, 1, "exactly one block-end (text only)");
  assert.equal(ends[0].index, tStart.index, "block-end index matches text block-start");
  assert.ok(o.some((e) => e.type === "finish" && e.reason.kind !== "error"), "finish ok");
  console.log("CASE 1 (empty thinking dropped) PASS");
}

// CASE 2: real thinking still streams normally, block-start precedes first delta.
{
  const o = await run([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about it." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_stop" },
  ]);
  const bi = o.findIndex((e) => e.type === "block-start" && e.blockType === "reasoning");
  const di = o.findIndex((e) => e.type === "reasoning-delta");
  assert.ok(bi >= 0 && bi < di, "reasoning block-start precedes first reasoning-delta");
  assert.equal(o.filter((e) => e.type === "reasoning-delta").map((e) => e.text).join(""), "Let me think about it.", "reasoning text intact");
  console.log("CASE 2 (real thinking streams) PASS");
}

// CASE 3: empty-argument tool call must NOT be dropped.
{
  const o = await run([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "now" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]);
  const toolStart = o.find((e) => e.type === "block-start" && e.blockType === "tool-call");
  assert.ok(toolStart, "tool-call block-start emitted even with no args");
  assert.ok(o.some((e) => e.type === "block-end" && e.index === toolStart.index), "tool-call block-end emitted");
  assert.ok(o.some((e) => e.type === "finish" && e.reason.kind === "tool-calls"), "finish reason tool-calls");
  console.log("CASE 3 (empty-arg tool call survives) PASS");
}

// CASE 4: only an empty reasoning block -> empty-completion finish, no phantom Think.
{
  const o = await run([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  assert.ok(!o.some((e) => e.type === "block-start"), "no block-start at all");
  assert.ok(!o.some((e) => e.type === "block-end"), "no block-end at all");
  assert.equal(o.find((e) => e.type === "finish").reason.kind, "error", "empty completion -> error finish");
  console.log("CASE 4 (only-empty-reasoning -> empty finish) PASS");
}

console.log("ALL EMPTY-THINKING REGRESSION CASES PASSED");
