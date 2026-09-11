import { UserRegistry } from "../src/users.js";
import { loadConfig } from "../src/config.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const cfg = loadConfig({
  workdir: process.cwd(),
  users: [
    { name: "alice", token: "tok-a", quotaUsd: 1, allowedTools: ["read_file", "search"] },
    { name: "bob", token: "tok-b", quotaUsd: 0.001 },
  ],
});

const reg = new UserRegistry(cfg);
const alice = reg.identify("tok-a", "admin-token");
const bob = reg.identify("tok-b", "admin-token");
const admin = reg.identify("admin-token", "admin-token");
const unknown = reg.identify("nope", "admin-token");

ok(alice?.name === "alice", "identify alice");
ok(bob?.name === "bob", "identify bob");
ok(admin?.isAdmin === true, "identify admin");
ok(unknown === null, "unknown token rejected");

// 工具白名单
ok(reg.toolAllowed(alice, "read_file"), "alice allowed read_file");
ok(!reg.toolAllowed(alice, "run_command"), "alice denied run_command");
ok(reg.toolAllowed(bob, "anything"), "bob unrestricted");

// 通配
const cfg2 = loadConfig({ workdir: process.cwd(), users: [{ name: "c", token: "t", allowedTools: ["git_*"] }] });
const reg2 = new UserRegistry(cfg2);
const c = reg2.identify("t", undefined);
ok(reg2.toolAllowed(c, "git_status"), "wildcard git_*");
ok(!reg2.toolAllowed(c, "run_command"), "wildcard excludes others");

// 配额
ok(!reg.charge("alice", 0.5, 1), "alice under quota");
ok(reg.charge("alice", 0.6, 1), "alice exceeds quota");
ok(reg.spent("alice") === 1.1, "spent accumulates");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
