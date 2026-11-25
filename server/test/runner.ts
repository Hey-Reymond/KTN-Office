/**
 * Testa o expediente (runner) ponta a ponta com IAs simuladas, sem gastar tokens:
 * humano → coordenadora (claude) → tarefa pro antigravity → entrega → claude → resposta pro humano.
 * Também testa o teste automático de modelos. Rode com: npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-runner-"));
const clis = path.join(tmp, "clis.json");
const exe = process.execPath; // qualquer executável que exista, só pra "estar instalado"
writeFileSync(
  clis,
  JSON.stringify({
    claude: { nome: "Claude", executavel: exe, prompt: ["{prompt}"], modelos: { opus: { id: "opus" }, fable: { id: "fable-x", opcional: true } } },
    antigravity: { nome: "Agy", executavel: exe, prompt: ["{prompt}"], modelos: { neon: { id: "n" }, carbon: { id: "c" } } },
  }),
);
Object.assign(process.env, { KTN_CLIS: clis, KTN_CLIS_CUSTOM: path.join(tmp, "custom.json") });

const { abrirBanco, Escritorio } = await import("../src/db.js");
const { Runner } = await import("../src/runner.js");
const { testarModelos, catalogoComEstado } = await import("../src/equipe/modelos.js");
const { carregarRegistro, estadoModelo, definirModelo } = await import("../src/equipe/registro.js");
type Funcionario = import("../src/equipe/funcionario.js").Funcionario;

const esc = new Escritorio(abrirBanco(path.join(tmp, "office.db")));
const chamadas: { id: string; modelo?: string; prompt: string }[] = [];

// IA simulada: faz o que o prompt do runner pede, usando o escritório de verdade.
const fabrica = (id: string): Funcionario => ({
  id,
  tipo: "cli",
  especialidades: [],
  async trabalhar(prompt, opcoes = {}) {
    chamadas.push({ id, modelo: opcoes.modelo, prompt });
    const tarefa = prompt.match(/pegar_tarefa com id (\d+)/);
    if (tarefa) {
      const t = esc.pegarTarefa(id, Number(tarefa[1]));
      esc.entregarTarefa(id, t.id, `pesquisa feita por ${id}`);
      return { ok: true, texto: "entreguei", tokens: { entrada: 100, saida: 50 } };
    }
    for (const m of esc.lerCaixa(id)) {
      if (m.de === "humano") esc.criarTarefa(id, "Pesquisar tokens", m.texto, "antigravity", "carbon");
      else if (m.texto.includes("entregue")) esc.enviarMensagem(id, "humano", `Pronto! ${m.texto}`);
    }
    return { ok: true, texto: "li a caixa" };
  },
});

try {
  const runner = new Runner(esc, fabrica);
  await runner.ciclo();
  assert.equal(chamadas.length, 0, "desligado não faz nada");

  runner.atualizarConfig({ ligado: true, pastaTrabalho: path.join(tmp, "trabalho") });
  esc.enviarMensagem("humano", "claude", "descubra como o agy mostra tokens");

  for (let i = 0; i < 5; i++) await runner.ciclo();

  assert.deepEqual(chamadas.map((c) => c.id), ["claude", "antigravity", "claude"], "ordem do trabalho");
  assert.equal(chamadas[1].modelo, "carbon", "aplica o modelo escolhido pela coordenadora");
  const resposta = esc.mensagensRecentes().filter((m) => m.para === "humano");
  assert.equal(resposta.length, 1);
  assert.match(resposta[0].texto, /Pronto!.*pesquisa feita por antigravity/s);
  assert.equal(esc.listarTarefas()[0].status, "entregue");
  assert.ok(esc.statusEquipe().find((a) => a.agente === "antigravity")!.uso_estimado_tokens === 150, "registra tokens");
  assert.ok(esc.eventosRecentes().some((e: any) => e.tipo === "inicio"));

  // Modelo desmarcado pelo usuário não é usado (roda no padrão do CLI)
  definirModelo("antigravity", "carbon", false);
  esc.criarTarefa("claude", "outra", "", "antigravity", "carbon");
  await runner.ciclo();
  assert.equal(chamadas.at(-1)!.modelo, undefined);

  // IA que não pega a tarefa: depois de N tentativas a tarefa é cancelada e você é avisado
  const preguicosa = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], trabalhar: async () => ({ ok: false, texto: "", erro: "sem login" }) }));
  preguicosa.atualizarConfig({ ligado: true, maxTentativas: 2 });
  const t = esc.criarTarefa("claude", "vai falhar", "", "antigravity");
  esc.lerCaixa("antigravity");
  await preguicosa.ciclo();
  await preguicosa.ciclo();
  assert.equal(esc.tarefa(t.id)!.status, "cancelada");
  assert.ok(esc.mensagensRecentes().some((m) => m.para === "humano" && m.texto.includes(`#${t.id}`)));

  // Trava anti-loop: no máximo N execuções por hora
  const loop = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], trabalhar: async () => ({ ok: true, texto: "" }) }));
  loop.atualizarConfig({ ligado: true, maxPorHora: 3, maxTentativas: 99 });
  esc.enviarMensagem("x", "claude", "spam");
  const antes = esc.eventosRecentes(500).filter((e: any) => e.tipo === "inicio" && e.agente === "claude").length;
  for (let i = 0; i < 6; i++) await loop.ciclo(); // claude nunca lê a caixa => tentaria sempre
  const depois = esc.eventosRecentes(500).filter((e: any) => e.tipo === "inicio" && e.agente === "claude").length;
  assert.equal(depois - antes, 3);
  assert.ok(esc.eventosRecentes().some((e: any) => e.tipo === "limite"));

  // Teste automático de modelos: quem responde fica ligado, quem falha vira indisponível
  definirModelo("antigravity", "carbon", true);
  const p = await testarModelos({
    fabrica: (id) => ({ id, tipo: "cli", especialidades: [], trabalhar: async (_p, o = {}) =>
      o.modelo === "fable" ? { ok: false, texto: "", erro: "model not available on your plan" } : { ok: true, texto: "ok" } }),
  });
  assert.equal(p.total, 4);
  const reg = carregarRegistro();
  assert.equal(estadoModelo(reg.claude, "opus"), "ligado");
  assert.equal(estadoModelo(reg.claude, "fable"), "indisponivel");
  const cat = catalogoComEstado();
  assert.equal(cat.find((c) => c.cli === "claude")!.modelos.find((m) => m.apelido === "fable")!.estado, "indisponivel");
  // Quem tem Fable: o teste passa e ele já entra ligado, sem precisar marcar
  await testarModelos({ fabrica: (id) => ({ id, tipo: "cli", especialidades: [], trabalhar: async () => ({ ok: true, texto: "ok" }) }) });
  assert.equal(estadoModelo(carregarRegistro().claude, "fable"), "ligado");
  // E o usuário pode desmarcar mesmo assim
  definirModelo("claude", "fable", false);
  assert.equal(estadoModelo(carregarRegistro().claude, "fable"), "desligado_usuario");

  console.log("OK: expediente (runner), modelos aplicados, travas e teste automático de modelos.");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
