import { createDatabase } from "./state/database.js";
import { createBuiltinTools, executeTool } from "./agent/tools.js";
import { gitStatus, gitLog } from "./git/tools.js";
import { loadSkills } from "./skills/loader.js";
import { installDefaultSkills } from "./setup/defaults.js";
import { DEFAULT_TREASURY_POLICY } from "./types.js";
import type { Skill, AutomatonTool } from "./types.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  [PASS] ${msg}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${msg}`);
    failed++;
  }
}

async function runTests() {
  console.log("=== AUTOMATON VERIFICATION SUITE ===");

  // 1. Database & Migrations
  console.log("\n1. Testing Database & Migrations:");
  const testDbPath = path.join(os.tmpdir(), `automaton-test-${Date.now()}.db`);
  try {
    const db = createDatabase(testDbPath);
    assert(db.getTurnCount() === 0, "Initial turn count is 0");

    db.setKV("test_key", "test_val");
    assert(db.getKV("test_key") === "test_val", "KV storage works");

    db.insertTurn({
      id: "turn-1",
      timestamp: new Date().toISOString(),
      state: "running",
      input: "test input",
      thinking: "test thinking",
      toolCalls: [],
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      costCents: 0,
    });
    assert(db.getTurnCount() === 1, "Turn insertion and count works");
    db.close();
  } finally {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  // 2. Builtin Tools
  console.log("\n2. Testing Builtin Tools:");
  const dbMem = createDatabase(":memory:");
  const tools = createBuiltinTools();
  const spendTracker = new SpendTracker(dbMem.raw);

  const toolNames = new Set(tools.map((t: AutomatonTool) => t.name));
  assert(toolNames.has("sleep"), "Builtin tool 'sleep' is registered");
  assert(toolNames.has("web_fetch"), "Builtin tool 'web_fetch' is registered");
  assert(toolNames.has("system_synopsis"), "Builtin tool 'system_synopsis' is registered");
  assert(toolNames.has("exec"), "Builtin tool 'exec' is registered");
  assert(toolNames.has("read_file"), "Builtin tool 'read_file' is registered");
  assert(toolNames.has("write_file"), "Builtin tool 'write_file' is registered");

  const mockContext: any = {
    identity: { name: "test-bot", address: "0x1234567890123456789012345678901234567890", account: { address: "0x1234567890123456789012345678901234567890" } },
    config: { name: "test-bot", inferenceModel: "modelstudio/qwen-plus", treasuryPolicy: DEFAULT_TREASURY_POLICY },
    db: dbMem,
    runtime: {
      exec: async (cmd: string) => ({ stdout: "ok", stderr: "", exitCode: 0 }),
      writeFile: async (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      readFile: async (p: string) => fs.readFileSync(p, "utf-8"),
    },
    spendTracker,
  };

  // Test sleep tool
  const sleepRes = await executeTool("sleep", { duration_minutes: 10, reason: "Testing sleep" }, tools, mockContext);
  assert(!sleepRes.error, "sleep tool executes without error");
  assert(!!dbMem.getKV("sleep_until"), "sleep tool sets sleep_until in KV store");

  // Test system_synopsis tool
  const synopsisRes = await executeTool("system_synopsis", {}, tools, mockContext);
  assert(!synopsisRes.error, "system_synopsis tool executes without error");
  const synopsisObj = JSON.parse(synopsisRes.result);
  assert(synopsisObj.name === "test-bot", "system_synopsis returns correct identity name");

  // Test web_fetch tool (fetching a reliable public test endpoint, e.g. github api)
  const webFetchRes = await executeTool("web_fetch", { url: "https://api.github.com/zen" }, tools, mockContext);
  assert(!webFetchRes.error && webFetchRes.result.includes("HTTP 200"), "web_fetch connects and fetches content successfully");

  // 3. Skills Loader (Windows cross-platform check)
  console.log("\n3. Testing Skills Installation & Loader:");
  const testSkillsDir = path.join(os.homedir(), ".automaton", "skills");
  installDefaultSkills(testSkillsDir);
  const loadedSkills = loadSkills(testSkillsDir, dbMem);
  assert(loadedSkills.length >= 3, `Loaded ${loadedSkills.length} skills (expected >= 3)`);
  assert(loadedSkills.some((s: Skill) => s.name === "local-runtime"), "Skill 'local-runtime' loaded successfully");
  assert(loadedSkills.some((s: Skill) => s.name === "payments"), "Skill 'payments' loaded successfully");
  assert(loadedSkills.some((s: Skill) => s.name === "growth"), "Skill 'growth' loaded successfully");

  // 4. Git Tools (git -C)
  console.log("\n4. Testing Git Tools:");
  const gitStatusRes = await gitStatus(mockContext.runtime, process.cwd());
  assert(typeof gitStatusRes.clean === "boolean", "gitStatus returns valid GitStatus object");
  const gitLogRes = await gitLog(mockContext.runtime, process.cwd(), 3);
  assert(gitLogRes.length > 0, `gitLog returns ${gitLogRes.length} recent commits`);

  dbMem.close();

  console.log(`\n========================================`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test execution error:", err);
  process.exit(1);
});
