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
if (p === "progresso") console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "pensando" }] } }));
if (a.includes("json")) console.log(JSON.stringify({ result: "eco(" + modelo + "): " + p, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } }));
else console.log("eco(" + modelo + "): " + p);
`;
// No Windows não existe shebang: cria um .cmd que chama o node (igual o npm faz com os CLIs reais).
const ehWindows = process.platform === "win32";
function criarFake(pasta: string, nome: string) {
  mkdirSync(pasta, { recursive: true });
  const js = path.join(pasta, ehWindows ? `${nome}.js` : nome);
  writeFileSync(js, fake);
  if (!ehWindows) {
    chmodSync(js, 0o755);
    return js;
  }
  const cmd = path.join(pasta, `${nome}.cmd`);
  writeFileSync(cmd, `@"${process.execPath}" "%~dp0${nome}.js" %*\r\n`);
  return cmd;
}
const fakeBin = criarFake(bin, "fakeclaude");
// Simula o agy: instalado numa pasta que NÃO está no PATH (igual o instalador do Antigravity).
criarFake(path.join(home, "AppData", "Local", "fakeagy", "bin"), "fakeagy");

const clis = path.join(tmp, "clis.json");
writeFileSync(
  clis,
  JSON.stringify({
    fakeclaude: {
      nome: "Fake Claude", executavel: "fakeclaude", versao: ["--version"], prompt: ["-p", "{prompt}"],
      modelo: ["--model", "{modelo}"], modeloPadrao: "opus", saidaJson: ["--output-format", "json"],
      leitorSaida: "claude-json", pastaConfig: "~/.fakeclaude", conexaoOffice: "claude-mcp",
      modelos: { topo: { id: "modelo-topo-v9" }, premium: { id: "premium-x", opcional: true } },
      instalar: { npm: "fake-pkg" }, especialidades: ["código"],
    },
    fakegemini: {
      nome: "Fake Gemini", executavel: "fakeclaude", prompt: ["-p", "{prompt}"], conexaoOffice: "gemini-settings",
    },
    fakeagy: {
      nome: "Fake Agy", executavel: "fakeagy", prompt: ["-p", "{prompt}"], conexaoOffice: "antigravity-mcp",
      instalar: { windows: "irm https://exemplo/install.ps1 | iex", unix: "curl -fsSL https://exemplo/install.sh | bash",
        caminhosExtras: ["~/AppData/Local/fakeagy/bin"] },
    },
    fakecodex: {
      nome: "Fake Codex", executavel: "fakeclaude", prompt: ["exec", "{prompt}"], conexaoOffice: "codex-mcp",
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
const { carregarRegistro, salvarCustom, definirModelo, modeloDisponivel } = await import("../src/equipe/registro.js");
const { conectarAoOffice, planejarInstalacao, liberarFerramentasOffice } = await import("../src/equipe/instalar.js");
const { CliAgent, resumirProgresso, explicarErro } = await import("../src/equipe/funcionario.js");

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

  // 2a. Codex: codex mcp add office --url ...
  rmSync(path.join(home, ".fake-mcp"), { force: true });
  assert.equal((await detectarUm("fakecodex", reg.fakecodex)).office, "nao");
  await conectarAoOffice("fakecodex", reg.fakecodex, fakeBin);
  assert.equal((await detectarUm("fakecodex", reg.fakecodex)).office, "conectado");

  // 2b. Antigravity: acha fora do PATH e conecta no mcp_config.json global
  const agy = await detectarUm("fakeagy", reg.fakeagy);
  assert.equal(agy.instalado, true, "acha pelo caminhosExtras");
  assert.equal(agy.office, "nao");
  const mcpAgy = path.join(home, ".gemini", "config", "mcp_config.json");
  mkdirSync(path.dirname(mcpAgy), { recursive: true });
  // Arquivo com BOM (comum no Windows): a detecção não pode quebrar.
  writeFileSync(mcpAgy, "\uFEFF" + JSON.stringify({ mcpServers: { docs: { serverUrl: "https://x" } } }));
  assert.equal((await detectarUm("fakeagy", reg.fakeagy)).office, "nao", "BOM não vira 'desconhecido'");
  await conectarAoOffice("fakeagy", reg.fakeagy, agy.caminho!);
  const m = JSON.parse(readFileSync(mcpAgy, "utf8"));
  assert.ok(m.mcpServers.docs, "preserva outros servidores");
  assert.match(m.mcpServers.office.serverUrl, /agent=fakeagy/);
  assert.equal((await detectarUm("fakeagy", reg.fakeagy)).office, "conectado");
  const planoAgy = planejarInstalacao(reg.fakeagy);
  assert.equal(planoAgy.descricao, process.platform === "win32" ? reg.fakeagy.instalar!.windows : reg.fakeagy.instalar!.unix);
  assert.equal(planoAgy.comando, process.platform === "win32" ? "powershell" : "bash");
  const r2 = await new CliAgent("fakeagy", reg.fakeagy).trabalhar("ola");
  assert.equal(r2.texto, "eco(padrao): ola");

  // 2c. Liberar ferramentas do office: preserva regras existentes e não duplica
  const setAgy = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  mkdirSync(path.dirname(setAgy), { recursive: true });
  writeFileSync(setAgy, JSON.stringify({ theme: "x", permissions: { allow: ["mcp(docs/*)"], deny: ["shell(rm *)"] } }));
  liberarFerramentasOffice(reg.fakeagy);
  liberarFerramentasOffice(reg.fakeagy);
  const sa = JSON.parse(readFileSync(setAgy, "utf8"));
  assert.deepEqual(sa.permissions.allow, ["mcp(docs/*)", "mcp(office/*)"]);
  assert.deepEqual(sa.permissions.deny, ["shell(rm *)"], "não mexe nas regras de bloqueio");
  assert.equal(sa.theme, "x");
  liberarFerramentasOffice(reg.fakeclaude);
  const sc = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(sc.permissions.allow, ["mcp__office"]);

  // 2d. Modelos opcionais: desligados até o usuário ligar; dá pra desligar qualquer um
  assert.equal(modeloDisponivel(carregarRegistro().fakeclaude, "premium"), false);
  definirModelo("fakeclaude", "premium", true);
  assert.equal(modeloDisponivel(carregarRegistro().fakeclaude, "premium"), true);
  definirModelo("fakeclaude", "topo", false);
  assert.equal(modeloDisponivel(carregarRegistro().fakeclaude, "topo"), false);
  definirModelo("fakeclaude", "topo", true);
  assert.equal(modeloDisponivel(carregarRegistro().fakeclaude, "topo"), true);
  assert.throws(() => definirModelo("fakeclaude", "naoexiste", true));

  // 2e. Ordem dos argumentos igual à que os CLIs reais aceitam (bugs vistos no Windows)
  const real = JSON.parse(readFileSync(new URL("../../agents/clis.json", import.meta.url), "utf8"));
  assert.deepEqual(new CliAgent("codex", real.codex).montarArgs("oi", "sol"),
    ["exec", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "-m", "gpt-6.2-sol", "oi"], "codex: tudo depois do exec, leitura por padrão");
  assert.deepEqual(new CliAgent("codex", real.codex).montarArgs("oi", "sol", { nivel: "edicao" }).slice(3, 5), ["--sandbox", "workspace-write"]);
  assert.deepEqual(new CliAgent("antigravity", real.antigravity).montarArgs("oi", "neon"),
    ["--model", "gemini-4-neon", "--output-format", "json", "-p", "oi"], "agy usa --model; leitura = modo padrão");
  assert.deepEqual(new CliAgent("antigravity", real.antigravity).montarArgs("oi", "neon", { nivel: "edicao" }).slice(2, 4), ["--mode", "accept-edits"]);
  const argsClaude = new CliAgent("claude", real.claude).montarArgs("oi");
  assert.deepEqual(argsClaude.slice(0, 2), ["--model", "opus"]);
  assert.equal(argsClaude[argsClaude.indexOf("--allowedTools") + 1], "Read,Glob,Grep,WebSearch,WebFetch,TodoWrite,mcp__office");
  assert.equal(argsClaude[argsClaude.indexOf("--permission-prompt-tool") + 1], "mcp__office__pedir_permissao", "o que não está liberado vira pop-up");
  assert.deepEqual(argsClaude.slice(-2), ["-p", "oi"]);
  const cmd = new CliAgent("claude", real.claude).montarArgs("oi", undefined, { nivel: "comandos", ferramentas: ["mcp__github"] });
  assert.ok(cmd[cmd.indexOf("--allowedTools") + 1].endsWith(",Bash"));
  assert.equal(cmd[cmd.lastIndexOf("--allowedTools") + 1], "mcp__github", "ferramentas 'sempre permitir' entram");
  // Erro real do codex vem no stdout (JSON); o aviso do stdin é ruído
  assert.equal(
    explicarErro("Reading additional input from stdin...\n", '{"type":"thread.started"}\n{"type":"error","message":"The model gpt-6.2-sol is not available on your plan"}', 1),
    "The model gpt-6.2-sol is not available on your plan");

  // 2g. Padrão fora do plano: não manda -m, o CLI escolhe o modelo da conta
  const { resolverModelo } = await import("../src/equipe/registro.js");
  const codexFree = { ...real.codex, modelosDetectados: { sol: "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account." } };
  assert.equal(resolverModelo(codexFree), undefined);
  assert.ok(!new CliAgent("codex", codexFree).montarArgs("oi").includes("-m"));
  assert.equal(resolverModelo(real.codex), "gpt-6.2-sol");

  // 2f. Progresso ao vivo: eventos dos CLIs viram frases curtas
  assert.equal(resumirProgresso(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__office__pegar_tarefa" }] } })), "🔧 usando office/pegar_tarefa");
  assert.equal(resumirProgresso(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Lendo o README" }] } })), "💬 Lendo o README");
  assert.equal(resumirProgresso(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test" } })), "⚙️ npm test");
  assert.equal(resumirProgresso(""), null);
  const frases: string[] = [];
  const rp = await new CliAgent("fakeclaude", reg.fakeclaude).trabalhar("progresso", { aoProgredir: (f) => frases.push(f) });
  assert.ok(rp.ok && frases.includes("💬 pensando"), "repassa a saída do CLI como progresso");
  assert.equal(rp.texto, "eco(opus): progresso", "resultado final continua certo com várias linhas");

  // 2h. Ferramentas (navegador): liga em todas as IAs com o navegador escolhido
  {
    process.env.KTN_NAVEGADORES = JSON.stringify({ brave: path.join(tmp, "brave", "brave.exe") });
    const { abrirBanco, Escritorio } = await import("../src/db.js");
    const { aplicarFerramenta, argsFerramenta, catalogoFerramentas, estadoFerramentas: estadoFerr } = await import("../src/ferramentas.js");
    const esc = new Escritorio(abrirBanco(path.join(tmp, "f.db")));
    const cat = catalogoFerramentas();
    assert.deepEqual(argsFerramenta(cat.playwright, "firefox"), ["-y", "@playwright/mcp@latest", "--browser", "firefox"]);
    assert.ok(argsFerramenta(cat["chrome-devtools"], "brave").includes(path.join(tmp, "brave", "brave.exe")));
    assert.throws(() => argsFerramenta(cat["chrome-devtools"], "firefox"), /não funciona com firefox/);
    assert.throws(() => argsFerramenta(cat.playwright, "brave", {}), /Não achei o brave/);

    rmSync(path.join(home, ".fake-mcp"), { force: true });
    const msgs = await aplicarFerramenta(esc, "playwright", { ligada: true, navegador: "brave", semPerguntar: true });
    assert.ok(msgs.some((m) => m.includes("Fake Claude: ligado")), msgs.join(" | "));
    assert.equal(readFileSync(path.join(home, ".fake-mcp"), "utf8"), path.join(tmp, "brave", "brave.exe"), "claude mcp add recebeu o navegador");
    const mcpAgy2 = JSON.parse(readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"));
    assert.deepEqual(mcpAgy2.mcpServers.playwright.command, "npx");
    assert.ok(mcpAgy2.mcpServers.office, "não mexe no office");
    assert.ok(esc.sempreDe("fakeclaude").includes("mcp__playwright"), "sem perguntar no Claude");
    const setAgy2 = JSON.parse(readFileSync(path.join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
    assert.ok(setAgy2.permissions.allow.includes("mcp(playwright/*)"), "sem perguntar no Antigravity");

    await aplicarFerramenta(esc, "playwright", { ligada: false });
    assert.equal(JSON.parse(readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8")).mcpServers.playwright, undefined);
    assert.ok(!esc.sempreDe("fakeclaude").includes("mcp__playwright"), "desligar tira a liberação");
    await assert.rejects(aplicarFerramenta(esc, "chrome-devtools", { ligada: true, navegador: "firefox" }), /não funciona/);

    // Controle da tela: opcional, só Windows, uma IA tipo Claude, nunca "sempre permitir"
    const { exigePerguntar } = await import("../src/ferramentas.js");
    assert.equal(estadoFerr(esc).tela.ligada, false, "desligado por padrão");
    assert.ok(exigePerguntar("mcp__tela__Click-Tool") && exigePerguntar("mcp__tela") && !exigePerguntar("mcp__telas"));
    esc.definirSempre("fakeclaude", ["mcp__tela", "mcp__office"]);
    assert.deepEqual(esc.sempreDe("fakeclaude"), ["mcp__office"], "nunca fica liberado de vez");
    const plat = Object.getOwnPropertyDescriptor(process, "platform")!;
    if (process.platform !== "win32") await assert.rejects(aplicarFerramenta(esc, "tela", { ligada: true, ia: "fakeclaude" }), /só funciona em Windows/);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await assert.rejects(aplicarFerramenta(esc, "tela", { ligada: true }), /Escolha qual IA/);
      await assert.rejects(aplicarFerramenta(esc, "tela", { ligada: true, ia: "fakeagy" }), /pedir permissão a cada ação/);
      const m2 = await aplicarFerramenta(esc, "tela", { ligada: true, ia: "fakeclaude", semPerguntar: true });
      assert.ok(m2.some((m) => m.includes("Fake Claude: ligado")), m2.join(" | "));
      assert.equal(JSON.parse(readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8")).mcpServers.tela, undefined, "não vai pra outras IAs");
      assert.equal(estadoFerr(esc).tela.semPerguntar, false, "semPerguntar ignorado");
      assert.ok(!esc.sempreDe("fakeclaude").includes("mcp__tela"));
      await aplicarFerramenta(esc, "tela", { ligada: false });
    } finally {
      Object.defineProperty(process, "platform", plat);
    }
  }

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
  assert.equal((await agente.trabalhar("x", { modelo: "topo" })).texto, "eco(modelo-topo-v9): x", "apelido vira id");

  const falha = await agente.trabalhar("falhe");
  assert.equal(falha.ok, false);
  assert.match(falha.erro!, /deu ruim/);

  equipe = await detectarEquipe();
  console.log("OK: detecção, conexão, instalação (plano), adição manual e CliAgent.");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
