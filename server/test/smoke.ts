/**
 * Teste de fumaça: sobe o servidor e simula claude e gemini trocando uma tarefa
 * usando um cliente MCP de verdade (mesmo protocolo que os CLIs usam).
 * Rode com: npm test
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORTA = 7799;
const dir = mkdtempSync(path.join(tmpdir(), "ktn-office-"));
const servidor = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  env: { ...process.env, KTN_PORT: String(PORTA), KTN_DB: path.join(dir, "teste.db") },
  stdio: ["ignore", "pipe", "pipe"],
});

await new Promise<void>((ok, falha) => {
  servidor.stdout!.on("data", (d) => String(d).includes("rodando") && ok());
  servidor.stderr!.on("data", (d) => process.stderr.write(d));
  setTimeout(() => falha(new Error("servidor não subiu em 15s")), 15000).unref();
  servidor.on("exit", (c) => falha(new Error(`servidor saiu com código ${c}`)));
});

async function conectar(agente: string) {
  const client = new Client({ name: `teste-${agente}`, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORTA}/mcp?agent=${agente}`)));
  const chamar = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const texto = r.content[0].text;
    return { erro: !!r.isError, dados: r.isError ? texto : JSON.parse(texto) };
  };
  return { client, chamar };
}

try {
  const claude = await conectar("claude");
  const gemini = await conectar("gemini");

  const { tools } = await claude.client.listTools();
  assert.ok(tools.length >= 10, "ferramentas registradas");

  const t = (await claude.chamar("criar_tarefa", { titulo: "Pesquisar uso de tokens", descricao: "Como o Gemini CLI reporta uso?", para: "gemini" })).dados;
  assert.equal(t.status, "aberta");

  // claude não pode pegar tarefa destinada ao gemini
  assert.ok((await claude.chamar("pegar_tarefa", { id: t.id })).erro);

  const caixaGemini = (await gemini.chamar("ler_caixa")).dados;
  assert.equal(caixaGemini.length, 1);

  const pega = (await gemini.chamar("pegar_tarefa")).dados;
  assert.equal(pega.responsavel, "gemini");
  assert.ok((await gemini.chamar("pegar_tarefa", { id: t.id })).erro, "não pega duas vezes");

  await gemini.chamar("registrar_uso", { tokens: 1200, limite: 100000 });
  const status = (await claude.chamar("status_equipe")).dados;
  const g = status.find((a: { agente: string }) => a.agente === "gemini");
  assert.equal(g.situacao, "ocupado");
  assert.equal(g.uso_percentual, 1);

  await gemini.chamar("entregar_tarefa", { id: t.id, resultado: "Use /stats no Gemini CLI." });
  const caixaClaude = (await claude.chamar("ler_caixa")).dados;
  assert.match(caixaClaude[0].texto, /entregue/);

  await claude.chamar("escrever_nota", { chave: "decisoes", conteudo: "Usar SQLite como estado." });
  assert.equal((await gemini.chamar("ler_notas", { chave: "decisoes" })).dados[0].autor, "claude");

  await claude.client.close();
  await gemini.client.close();
  console.log("OK: claude e gemini trocaram tarefa, mensagens, uso e notas.");
} finally {
  servidor.kill();
  rmSync(dir, { recursive: true, force: true });
}
