/**
 * Teste de fumaça: sobe o servidor e simula claude e gemini trocando uma tarefa
 * usando um cliente MCP de verdade (mesmo protocolo que os CLIs usam).
 * Rode com: npm test
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORTA = 7799;
const dir = mkdtempSync(path.join(tmpdir(), "ktn-office-"));
// Registro isolado: usa o catálogo real, mas finge que claude e antigravity estão instalados
// (e codex não), pra o teste dar o mesmo resultado em qualquer PC.
const real = JSON.parse(readFileSync(new URL("../../agents/clis.json", import.meta.url), "utf8"));
real.claude.executavel = process.execPath;
real.antigravity.executavel = process.execPath;
real.codex.executavel = path.join(dir, "codex-nao-existe");
writeFileSync(path.join(dir, "clis.json"), JSON.stringify(real));
const servidor = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  env: { ...process.env, KTN_PORT: String(PORTA), KTN_DB: path.join(dir, "teste.db"), KTN_CLIS_CUSTOM: path.join(dir, "nao-existe.json"), KTN_CLIS: path.join(dir, "clis.json"), KTN_DADOS: path.join(dir, "dados"), KTN_ESPERA_PERMISSAO_MS: "2500" },
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

  // Coordenação escolhe o modelo da tarefa
  const comModelo = (await claude.chamar("criar_tarefa", { titulo: "Bug difícil", para: "antigravity", modelo: "carbon" })).dados;
  assert.equal(comModelo.modelo, "carbon");
  const invalido = await claude.chamar("criar_tarefa", { titulo: "x", para: "antigravity", modelo: "turbo" });
  assert.ok(invalido.erro && /Opções: .*carbon/.test(invalido.dados), "recusa modelo que não existe");
  const catalogo = (await claude.chamar("modelos_equipe")).dados;
  assert.ok(catalogo.antigravity.modelos.hydrogen && catalogo.claude.modelos.haiku);
  assert.equal(catalogo.gemini, undefined, "CLI desativado não aparece");
  assert.equal(catalogo.claude.modelos.fable, undefined, "opcional desligado não aparece");
  assert.ok((await claude.chamar("criar_tarefa", { titulo: "x", para: "claude", modelo: "fable" })).erro, "fable desligado é recusado");
  const porId = (await claude.chamar("criar_tarefa", { titulo: "y", para: "codex", modelo: "gpt-6.2-astra" })).dados;
  assert.equal(porId.modelo, "astra", "id completo vira apelido");

  // Projeto: uma parte por IA da equipe, inclusive a coordenadora
  const proj = (await claude.chamar("criar_projeto", { titulo: "Landing page", pedido: "faça uma landing" })).dados;
  assert.deepEqual(proj.equipe.map((x: { ia: string }) => x.ia).sort(), ["antigravity", "claude"]);
  const faltou = await claude.chamar("distribuir_projeto", { projeto_id: proj.projeto.id, partes: [{ para: "antigravity", titulo: "pesquisa" }] });
  assert.ok(faltou.erro && /Faltou: claude/.test(faltou.dados), "coordenadora também precisa de uma parte");
  const intruso = await claude.chamar("distribuir_projeto", { projeto_id: proj.projeto.id, partes: [
    { para: "claude", titulo: "a" }, { para: "antigravity", titulo: "b" }, { para: "codex", titulo: "c" }] });
  assert.ok(intruso.erro && /Não estão na equipe: codex/.test(intruso.dados), "não manda parte pra quem não está instalado");
  const outra = await gemini.chamar("distribuir_projeto", { projeto_id: proj.projeto.id, partes: [{ para: "claude", titulo: "a" }] });
  assert.ok(outra.erro, "só a coordenadora distribui");
  const partes = (await claude.chamar("distribuir_projeto", { projeto_id: proj.projeto.id, partes: [
    { para: "claude", titulo: "código", modelo: "opus" }, { para: "antigravity", titulo: "pesquisa de referências", modelo: "neon" }] })).dados;
  assert.equal(partes.length, 2);
  assert.ok((await claude.chamar("concluir_projeto", { projeto_id: proj.projeto.id, resultado: "x" })).erro, "não conclui com partes pendentes");

  // Chats: histórico e memória que as IAs podem ler
  const { abrirBanco, Escritorio } = await import("../src/db.js");
  const direto = new Escritorio(abrirBanco(path.join(dir, "teste.db")));
  const chatA = direto.criarConversa("Landing");
  direto.enviarMensagem("humano", "claude", "quero tons de azul", null, chatA.id);
  const hist = (await claude.chamar("historico_conversa", { conversa_id: chatA.id })).dados;
  assert.equal(hist.mensagens[0].texto, "quero tons de azul");
  await claude.chamar("escrever_memoria", { conversa_id: chatA.id, texto: "humano prefere azul" });
  const mem = (await gemini.chamar("ler_memoria", { conversa_id: chatA.id })).dados;
  assert.match(mem.memoria, /humano prefere azul \(claude\)/);
  assert.ok(mem.arquivo.includes(path.join("dados", "conversas", String(chatA.id))), "memória fica numa pasta do PC");
  const resp = (await claude.chamar("mandar_mensagem", { para: "humano", texto: "ok, azul" })).dados;
  assert.equal(resp.conversa_id, chatA.id, "resposta cai no chat certo mesmo sem informar");
  assert.ok((await claude.chamar("ler_memoria", { conversa_id: 999 })).erro);

  // Permissões: o Claude espera a resposta do pop-up (via --permission-prompt-tool)
  const esperando = claude.chamar("pedir_permissao", { tool_name: "Bash", input: { command: "npm test" } });
  let pendente;
  for (let i = 0; i < 20 && !(pendente = direto.pedidosPendentes()[0]); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(pendente!.detalhe, "npm test", "pop-up mostra o comando exato");
  direto.responderPermissao(pendente!.id, true, true);
  assert.deepEqual((await esperando).dados, { behavior: "allow", updatedInput: { command: "npm test" } }, "Claude recebe 'allow' e continua");
  assert.deepEqual(direto.sempreDe("claude"), ["Bash"], "'sempre permitir' fica salvo");
  const semResposta = (await claude.chamar("pedir_permissao", { tool_name: "Write", input: { file_path: "a.txt" } })).dados;
  assert.equal(semResposta.behavior, "deny", "sem resposta a tempo = negado");
  // Outras IAs deixam um recado e são acordadas com a resposta
  const rec = (await gemini.chamar("solicitar_permissao", { nivel: "edicao", motivo: "criar index.html" })).dados;
  direto.responderPermissao(rec.pedido, true, false);
  assert.equal(direto.tomarUmaVez("gemini"), "edicao", "'uma vez' vale só pra próxima execução");
  assert.equal(direto.tomarUmaVez("gemini"), null);
  assert.ok(direto.mensagensRecentes().some((m) => m.para === "gemini" && m.texto.includes("PERMITIU")));

  await claude.chamar("escrever_nota", { chave: "decisoes", conteudo: "Usar SQLite como estado." });
  assert.equal((await gemini.chamar("ler_notas", { chave: "decisoes" })).dados[0].autor, "claude");

  await claude.client.close();
  await gemini.client.close();
  console.log("OK: claude e gemini trocaram tarefa, mensagens, uso e notas.");
} finally {
  // No Windows o arquivo do banco fica travado até o processo realmente sair.
  const saiu = new Promise((ok) => servidor.once("exit", ok));
  servidor.kill();
  await saiu;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows: o banco aberto neste processo fica travado; a pasta temporária pode ficar */ }
}
