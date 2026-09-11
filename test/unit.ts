import { parseRule, parseRules, decide } from "../src/permissions.js";
import {
  buildContext,
  estimateTokens,
  summarizeToolResult,
} from "../src/context.js";
import type { ChatMessage } from "../src/types.js";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string): void {
  if (cond) pass++;
  else { fail++; console.error("FAIL:", label); }
}

ok(parseRule("allow:read_file")!.tool.test("read_file"), "parse allow read_file");
ok(parseRule("allow:read_*")!.tool.test("read_file"), "wildcard read_*");
ok(!parseRule("allow:read_*")!.tool.test("write_file"), "wildcard negative");
const denyRule = parseRule("deny:run_command(rm -rf)")!;
ok(denyRule.argPattern!.test("rm -rf /"), "deny arg pattern");
ok(parseRules(["allow:read_file;deny:run_command(rm)"]).length === 2, "multi-rule split");

const ctx = { rules: parseRules(["allow:run_command;deny:run_command(rm)"]), defaultDecision: "ask" as const, autoApprove: false };
ok(decide(ctx, "run_command", { command: "rm -rf /" }).decision === "deny", "deny wins over allow");
ok(decide(ctx, "run_command", { command: "ls" }).decision === "allow", "allow when no deny match");

const ctx2 = { rules: parseRules(["ask:write_file"]), defaultDecision: "ask" as const, autoApprove: true };
ok(decide(ctx2, "write_file", { path: "a" }).decision === "allow", "autoApprove ask->allow");
const ctx3 = { ...ctx2, autoApprove: false };
ok(decide(ctx3, "write_file", { path: "a" }).decision === "ask", "ask stays ask");
const ctx4 = { rules: parseRules(["deny:run_command(rm)"]), defaultDecision: "ask" as const, autoApprove: true };
ok(decide(ctx4, "run_command", { command: "rm x" }).decision === "deny", "deny beats autoApprove");

ok(estimateTokens("abcdefgh") === 2, "ascii 4/char");
ok(estimateTokens("你好世界") === 4, "cjk 1/char");

const long = "x".repeat(10000);
ok(summarizeToolResult(long, 1000).includes("已省略"), "summarize long tool result");
ok(summarizeToolResult("short", 1000) === "short", "short unchanged");

const history: ChatMessage[] = [];
for (let i = 0; i < 50; i++) {
  history.push({ role: "user", content: `message ${i} `.repeat(50) });
  history.push({ role: "assistant", content: `reply ${i} `.repeat(50) });
}
const res = buildContext("sys", history, {
  maxContextTokens: 1000,
  reserveForOutput: 200,
  keepRecentMessages: 4,
  toolResultMaxChars: 100,
});
ok(res.messages[0]!.role === "system", "system always kept");
ok(res.trimmed, "history trimmed");
ok(res.messages.length < history.length + 1, "fewer messages than history");
ok(res.messages[res.messages.length - 1]!.content === history[history.length - 1]!.content, "recent kept");

const dangling: ChatMessage[] = [
  { role: "tool", tool_call_id: "x", name: "read_file", content: "orphan" },
  { role: "user", content: "hi" },
];
const res2 = buildContext("sys", dangling, {
  maxContextTokens: 100000,
  reserveForOutput: 0,
  keepRecentMessages: 10,
  toolResultMaxChars: 100,
});
ok(!res2.messages.some((m) => m.role === "tool"), "dangling tool dropped");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
