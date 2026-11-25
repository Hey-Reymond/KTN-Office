/**
 * Testa detecção, conexão e o CliAgent com CLIs FALSOS num HOME/PATH temporários.
 * Não toca nos seus CLIs reais nem gasta tokens. Rode com: npm test
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-equipe-"));
const bin = path.join(tmp, "bin");
const home = path.join(tmp, "home");
mkdirSync(bin);
mkdirSync(home);

// CLI falso que imita o claude: versão, prompt (texto ou JSON) e "mcp add/get/remove".
const fake = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const mcp = path.join(process.env.HOME, ".fake-mcp");
if (a[0] === "--version") { console.log("9.9.9 (Fake)"); process.exit(0); }
if (a[0] === "mcp" && a[1] === "add") { fs.writeFileSync(mcp, a[a.length - 1]); process.exit(0); }
if (a[0] === "mcp" && a[1] === "get") { if (!fs.existsSync(mcp)) process.exit(1); console.log("url: " + fs.readFileSync(mcp, "utf8")); process.exit(0); }
if (a[0] === "mcp" && a[1] === "remove") { try { fs.unlinkSync(mcp); } catch {} process.exit(0); }
const p = a[a.indexOf("-p") + 1];
const modelo = a.includes("--model") ? a[a.indexOf("--model") + 1] : "padrao";
if (p === "falhe") { console.error("deu ruim"); process.exit(2); }
if (a.includes("json")) console.log(JSON.stringify({ result: "eco(" + modelo + "): " + p, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } }));
else console.log("eco(" + modelo + "): " + p);
`;
// No Windows não existe shebang: cria um .cmd que chama o node (igual o npm faz com os CLIs reais).
const ehWindows = process.platform === "win32";
const fakeJs = path.join(bin, ehWindows ? "fakeclaude.js" : "fakeclaude");
writeFileSync(fakeJs, fake);
let fakeBin = fakeJs;
if (ehWindows) {
  fakeBin = path.join(bin, "fakeclaude.cmd");
  writeFileSync(fakeBin, `@"${process.execPath}" "%~dp0fakeclaude.js" %*\r\n`);
} else chmodSync(fakeBin, 0o755);

const clis = path.join(tmp, "clis.json");
writeFileSync(
  clis,
  JSON.stringify({
    fakeclaude: {
      nome: "Fake Claude", executavel: "fakeclaude", versao: ["--version"], prompt: ["-p", "{prompt}"],
      modelo: ["--model", "{modelo}"], modeloPadrao: "opus", saidaJson: ["--output-format", "json"],
      leitorSaida: "claude-json", pastaConfig: "~/.fakeclaude", conexaoOffice: "claude-mcp",
      instalar: { npm: "fake-pkg" }, especialidades: ["código"],
    },
    fakegemini: {
      nome: "Fake Gemini", executavel: "fakeclaude", prompt: ["-p", "{prompt}"], conexaoOffice: "gemini-settings",
    },
    ausente: { nome: "Ausente", executavel: "nao-existe-xyz", prompt: ["-p", "{prompt}"], instalar: { npm: "x" } },
  }),
);

Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  KTN_CLIS: clis,
  KTN_CLIS_CUSTOM: path.join(tmp, "clis.custom.json"),
});

const { detectarEquipe, detectarUm } = await import("../src/equipe/detectar.js");
const { carregarRegistro, salvarCustom } = await import("../src/equipe/registro.js");
const { conectarAoOffice, planejarInstalacao } = await import("../src/equipe/instalar.js");
const { CliAgent } = await import("../src/equipe/funcionario.js");

try {
  // 1. Detecção
  let equipe = await detectarEquipe();
  const fc = equipe.find((d) => d.id === "fakeclaude")!;
  assert.equal(fc.instalado, true);
  assert.equal(fc.versao, "9.9.9 (Fake)");
  assert.equal(fc.login, "nao", "sem pasta de config = sem login");
  assert.equal(fc.office, "nao");
  const aus = equipe.find((d) => d.id === "ausente")!;
  assert.equal(aus.instalado, false);
  assert.equal(aus.podeInstalar, true);

  mkdirSync(path.join(home, ".fakeclaude"));
  assert.equal((await detectarUm("fakeclaude", carregarRegistro().fakeclaude)).login, "provavel");

  // 2. Conexão ao escritório (claude-mcp e gemini-settings)
  const reg = carregarRegistro();
  await conectarAoOffice("fakeclaude", reg.fakeclaude, fakeBin);
  assert.equal((await detectarUm("fakeclaude", reg.fakeclaude)).office, "conectado");

  const settings = path.join(home, ".gemini", "settings.json");
  mkdirSync(path.dirname(settings));
  writeFileSync(settings, JSON.stringify({ theme: "Dracula", mcpServers: { outro: { command: "x" } } }));
  await conectarAoOffice("fakegemini", reg.fakegemini, fakeBin);
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.theme, "Dracula", "preserva configurações existentes");
  assert.ok(s.mcpServers.outro, "preserva outros servidores MCP");
  assert.match(s.mcpServers.office.httpUrl, /agent=fakegemini/);
  assert.ok(existsSync(settings + ".bak"), "faz backup");
  assert.equal((await detectarUm("fakegemini", reg.fakegemini)).office, "conectado");

  // 3. Plano de instalação não executa nada, só descreve
  const plano = planejarInstalacao(reg.ausente);
  assert.equal(plano.possivel, true);
  assert.equal(plano.descricao, "npm install -g x");

  // 4. Adição manual: caminho absoluto via clis.custom.json
  salvarCustom("ausente", { executavel: fakeBin });
  assert.equal((await detectarUm("ausente", carregarRegistro().ausente)).instalado, true);
  assert.throws(() => salvarCustom("ID Ruim!", {}));

  // 5. CliAgent: prompt com aspas/espaços passa intacto (sem shell), JSON vira tokens
  const agente = new CliAgent("fakeclaude", reg.fakeclaude);
  const r = await agente.trabalhar(`oi "mundo"; rm -rf /`);
  assert.equal(r.ok, true);
  assert.equal(r.texto, `eco(opus): oi "mundo"; rm -rf /`);
  assert.deepEqual(r.tokens, { entrada: 15, saida: 7 });
  assert.equal((await agente.trabalhar("x", { modelo: "sonnet" })).texto, "eco(sonnet): x");

  const falha = await agente.trabalhar("falhe");
  assert.equal(falha.ok, false);
  assert.match(falha.erro!, /deu ruim/);

  equipe = await detectarEquipe();
  console.log("OK: detecção, conexão, instalação (plano), adição manual e CliAgent.");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
