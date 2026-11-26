import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-clis-"));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;
const { carregarRegistro } = await import("../src/equipe/registro.js");
const { CliAgent } = await import("../src/equipe/funcionario.js");
const { conectarAoOffice, trocarUrl } = await import("../src/equipe/instalar.js");
try {
  const reg = carregarRegistro();
  for (const id of ["copilot", "qwen", "opencode", "kimi"]) assert.ok(reg[id], `${id} no catálogo`);
  // Argumentos
  assert.deepEqual(new CliAgent("copilot", reg.copilot).montarArgs("oi", undefined, { nivel: "leitura" }),
    ["--allow-all-tools", "--deny-tool", "write", "--deny-tool", "shell", "-p", "oi", "-s", "--no-ask-user"]);
  assert.deepEqual(new CliAgent("qwen", reg.qwen).montarArgs("oi", "qwen3-coder-plus", { nivel: "edicao" }),
    ["-m", "qwen3-coder-plus", "--approval-mode", "auto-edit", "--output-format", "json", "-p", "oi"]);
  assert.deepEqual(new CliAgent("opencode", reg.opencode).montarArgs("oi", "ollama/qwen3", { nivel: "leitura" }),
    ["run", "--format", "json", "--agent", "plan", "--model", "ollama/qwen3", "oi"]);
  assert.deepEqual(new CliAgent("kimi", reg.kimi).montarArgs("oi"), ["-p", "oi"]);
  // Conexão por arquivo JSON (preserva o que já existe)
  const url = "http://127.0.0.1:7777/mcp?agent=opencode";
  assert.deepEqual(trocarUrl({ a: ["{url}"], b: { url: "{url}" }, c: true }, "U"), { a: ["U"], b: { url: "U" }, c: true });
  await conectarAoOffice("opencode", reg.opencode, "opencode");
  const oc = JSON.parse(readFileSync(path.join(tmp, ".config/opencode/opencode.json"), "utf8"));
  assert.deepEqual(oc.mcp.office, { type: "remote", url, enabled: true });
  await conectarAoOffice("copilot", reg.copilot, "copilot");
  const cp = JSON.parse(readFileSync(path.join(tmp, ".copilot/mcp-config.json"), "utf8"));
  assert.equal(cp.mcpServers.office.type, "http");
  await conectarAoOffice("qwen", reg.qwen, "qwen");
  assert.equal(JSON.parse(readFileSync(path.join(tmp, ".qwen/settings.json"), "utf8")).mcpServers.office.trust, true);
  console.log("OK: novos CLIs (Copilot, Qwen Code, OpenCode, Kimi): argumentos e conexão ao escritório.");
} finally {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10 }); } catch { /* Windows: o banco aberto neste processo fica travado; a pasta temporária pode ficar */ }
}
