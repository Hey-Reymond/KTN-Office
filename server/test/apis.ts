/**
 * IA por API: conversa com ferramentas (tool loop) usando o MCP do escritório e arquivos da pasta,
 * contra um servidor falso compatível com OpenAI e outro com a API da Anthropic.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-api-"));
process.env.KTN_DADOS = path.join(tmp, "dados");
const { abrirBanco, Escritorio } = await import("../src/db.js");
const { criarServidor } = await import("../src/tools.js");
const { ApiAgent, chaveDe, ferramentasDeArquivo, listarModelosApi, salvarChave } = await import("../src/equipe/apis.js");
const esc = new Escritorio(abrirBanco(path.join(tmp, "o.db")));

// Servidor MCP do escritório, no mesmo processo
const app = express();
app.use(express.json());
app.post("/mcp", async (req, res) => {
  const s = criarServidor(esc, String(req.query.agent));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { t.close(); s.close(); });
  await s.connect(t);
  await t.handleRequest(req, res, req.body);
});

// API falsa: na 1ª volta pede ferramentas, na 2ª responde texto
const chamadas: any[] = [];
app.get("/v1/models", (req, res) => res.json({ data: [{ id: "modelo-b" }, { id: "modelo-a" }], auth: req.headers.authorization }));
app.post("/v1/chat/completions", (req, res) => {
  chamadas.push({ tipo: "openai", corpo: req.body, auth: req.headers.authorization });
  const msgs = req.body.messages;
  if (req.body.model === "sem-cota") return res.status(429).json({ error: { message: "Rate limit exceeded" } });
  if (!msgs.some((m: any) => m.role === "tool")) {
    return res.json({ usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "pegar_tarefa", arguments: JSON.stringify({ id: tarefaId }) } },
      { id: "c2", type: "function", function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "dados.txt" }) } },
      { id: "c3", type: "function", function: { name: "escrever_arquivo", arguments: JSON.stringify({ caminho: "saida/r.txt", conteudo: "feito" }) } },
      { id: "c4", type: "function", function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "../fora.txt" }) } },
    ] } }] });
  }
  const lido = msgs.find((m: any) => m.tool_call_id === "c2").content;
  return res.json({ usage: { prompt_tokens: 200, completion_tokens: 20 }, choices: [{ message: { content: `Li: ${lido}` } }] });
});
app.post("/v1/messages", (req, res) => {
  chamadas.push({ tipo: "anthropic", corpo: req.body, chave: req.headers["x-api-key"] });
  const ultima = req.body.messages.at(-1);
  if (ultima.role === "user" && typeof ultima.content === "string") {
    return res.json({ usage: { input_tokens: 50, output_tokens: 5 }, content: [{ type: "tool_use", id: "u1", name: "status_equipe", input: {} }] });
  }
  return res.json({ usage: { input_tokens: 60, output_tokens: 6 }, content: [{ type: "text", text: "equipe ok" }] });
});
const srv = http.createServer(app);
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const tarefa = esc.criarTarefa("claude", "ler dados", "leia dados.txt", "ollama");
const tarefaId = tarefa.id;

try {
  const pasta = path.join(tmp, "trabalho");
  (await import("node:fs")).mkdirSync(pasta);
  writeFileSync(path.join(pasta, "dados.txt"), "conteúdo secreto 42");
  writeFileSync(path.join(tmp, "fora.txt"), "não deveria ler");

  // OpenAI-compatível (ex.: Ollama, sem chave)
  const cfg = { nome: "Ollama", executavel: "", versao: [], prompt: [], tipo: "api" as const, api: { provedor: "ollama", tipo: "openai" as const, baseUrl: `${base}/v1` }, modelos: { "modelo-a": { id: "modelo-a" } }, modeloPadrao: "modelo-a" };
  const passos: string[] = [];
  const r = await new ApiAgent("ollama", cfg, `${base}/mcp?agent=ollama`).trabalhar("trabalhe", { cwd: pasta, nivel: "edicao", aoProgredir: (f) => passos.push(f) });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.texto, "Li: conteúdo secreto 42");
  assert.deepEqual(r.tokens, { entrada: 300, saida: 30 });
  assert.equal(esc.tarefa(tarefaId)!.status, "em_andamento", "usou a ferramenta MCP do escritório como 'ollama'");
  assert.equal(esc.tarefa(tarefaId)!.responsavel, "ollama");
  assert.equal(readFileSync(path.join(pasta, "saida/r.txt"), "utf8"), "feito");
  const segunda = chamadas.filter((c) => c.tipo === "openai")[1].corpo.messages;
  assert.match(segunda.find((m: any) => m.tool_call_id === "c4").content, /Fora da pasta/, "não sai da pasta de trabalho");
  const nomes = chamadas[0].corpo.tools.map((t: any) => t.function.name);
  assert.ok(nomes.includes("entregar_tarefa") && !nomes.includes("pedir_permissao"));
  assert.ok(!JSON.stringify(chamadas[0].corpo.tools).includes("$schema"));
  assert.equal(chamadas[0].auth, undefined, "sem chave, sem Authorization");
  assert.deepEqual(passos.slice(0, 2), ["usando pegar_tarefa", "usando ler_arquivo"]);

  // Leitura: sem escrever_arquivo
  assert.ok(!ferramentasDeArquivo(pasta, false).some((f) => f.name === "escrever_arquivo"));

  // Cota estourada vira semCota
  const r429 = await new ApiAgent("ollama", { ...cfg, modeloPadrao: "sem-cota", modelos: { "sem-cota": { id: "sem-cota" } } }, `${base}/mcp?agent=ollama`).trabalhar("x");
  assert.equal(r429.ok, false); assert.equal(r429.semCota, true);

  // Provedor que exige chave
  const semChave = await new ApiAgent("orouter", { ...cfg, api: { provedor: "openrouter", tipo: "openai", baseUrl: `${base}/v1` } }).trabalhar("x");
  assert.match(semChave.erro!, /falta a chave/);

  // Anthropic, com chave salva fora do projeto
  salvarChave("anth", "sk-teste");
  assert.equal(chaveDe("anth"), "sk-teste");
  assert.ok(existsSync(path.join(tmp, "dados", "chaves-api.json")));
  const ra = await new ApiAgent("anth", { ...cfg, api: { provedor: "anthropic", tipo: "anthropic", baseUrl: base } }, `${base}/mcp?agent=anth`).trabalhar("status?");
  assert.equal(ra.ok, true, ra.erro);
  assert.equal(ra.texto, "equipe ok");
  const ca = chamadas.filter((c) => c.tipo === "anthropic");
  assert.equal(ca[0].chave, "sk-teste");
  assert.equal(ca[1].corpo.messages.at(-1).content[0].type, "tool_result");
  salvarChave("anth", null);
  assert.equal(chaveDe("anth"), undefined);

  // Listar modelos (detecção automática)
  assert.deepEqual(await listarModelosApi("openai", `${base}/v1`), ["modelo-a", "modelo-b"]);
  console.log("OK: IAs por API (OpenAI-compatível e Anthropic, ferramentas do escritório e de arquivos, chave local, cota).");
} finally {
  srv.close();
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10 }); } catch { /* Windows: o banco aberto neste processo fica travado; a pasta temporária pode ficar */ }
}
