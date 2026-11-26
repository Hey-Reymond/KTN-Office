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
  { await runner.ciclo(); await runner.aguardarOcioso(); }
  assert.equal(chamadas.length, 0, "desligado não faz nada");

  runner.atualizarConfig({ ligado: true, pastaTrabalho: path.join(tmp, "trabalho") });
  esc.enviarMensagem("humano", "claude", "descubra como o agy mostra tokens");

  for (let i = 0; i < 5; i++) { await runner.ciclo(); await runner.aguardarOcioso(); }

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
  { await runner.ciclo(); await runner.aguardarOcioso(); }
  assert.equal(chamadas.at(-1)!.modelo, undefined);

  // IA que não pega a tarefa: depois de N tentativas a tarefa é cancelada e você é avisado
  const preguicosa = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], trabalhar: async () => ({ ok: false, texto: "", erro: "sem login" }) }));
  preguicosa.atualizarConfig({ ligado: true, maxTentativas: 2 });
  const t = esc.criarTarefa("claude", "vai falhar", "", "antigravity");
  esc.lerCaixa("antigravity");
  { await preguicosa.ciclo(); await preguicosa.aguardarOcioso(); }
  { await preguicosa.ciclo(); await preguicosa.aguardarOcioso(); }
  assert.equal(esc.tarefa(t.id)!.status, "cancelada");
  assert.ok(esc.mensagensRecentes().some((m) => m.para === "humano" && m.texto.includes(`#${t.id}`)));

  // Trava anti-loop: no máximo N execuções por hora
  const loop = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], trabalhar: async () => ({ ok: true, texto: "" }) }));
  loop.atualizarConfig({ ligado: true, maxPorHora: 3, maxTentativas: 99 });
  esc.enviarMensagem("x", "claude", "spam");
  const antes = esc.eventosRecentes(500).filter((e: any) => e.tipo === "inicio" && e.agente === "claude").length;
  for (let i = 0; i < 6; i++) { await loop.ciclo(); await loop.aguardarOcioso(); } // claude nunca lê a caixa => tentaria sempre
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

  // ---------- Paralelismo: uma IA lenta não segura as outras ----------
  {
    let liberarLenta!: () => void;
    const lenta = new Promise<void>((r) => (liberarLenta = r));
    const ordem: string[] = [];
    const par = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], async trabalhar(prompt) {
      const t = prompt.match(/pegar_tarefa com id (\d+)/);
      if (id === "claude") await lenta;
      if (t) { const x = esc.pegarTarefa(id, Number(t[1])); esc.entregarTarefa(id, x.id, "ok"); }
      else esc.lerCaixa(id);
      ordem.push(id);
      return { ok: true, texto: "" };
    } }));
    par.atualizarConfig({ ligado: true, maxPorHora: 50 });
    esc.lerCaixa("claude"); esc.lerCaixa("antigravity");
    esc.criarTarefa("x", "lenta", "", "claude");
    const rapida = esc.criarTarefa("x", "rápida", "", "antigravity");
    await par.ciclo(); // acorda os dois; claude fica preso
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(esc.tarefa(rapida.id)!.status, "entregue", "antigravity terminou sem esperar o claude");
    assert.deepEqual(ordem, ["antigravity"]);
    liberarLenta();
    await par.aguardarOcioso();
    assert.deepEqual(ordem, ["antigravity", "claude"]);
    par.atualizarConfig({ ligado: false });
  }

  // ---------- Projeto completo: coordenadora divide, todos fazem, coordenadora faz o merge ----------
  const { equipeAtiva } = await import("../src/equipe/detectar.js");
  const fazProjeto = (id: string): Funcionario => ({
    id, tipo: "cli", especialidades: [],
    async trabalhar(prompt, o = {}) {
      chamadas.push({ id, modelo: o.modelo, prompt });
      const tarefa = prompt.match(/pegar_tarefa com id (\d+)/);
      if (tarefa) {
        const t = esc.pegarTarefa(id, Number(tarefa[1]));
        esc.entregarTarefa(id, t.id, `parte de ${id}: ${t.titulo}`);
        return { ok: true, texto: "ok" };
      }
      for (const m of esc.lerCaixa(id)) {
        if (m.de === "humano") {
          const p = esc.criarProjeto(id, "App", m.texto);
          esc.distribuirProjeto(id, p.id, [
            { para: "claude", titulo: "backend", descricao: "", modelo: "opus" },
            { para: "antigravity", titulo: "pesquisa", descricao: "", modelo: "neon" },
          ], equipeAtiva(esc.lerConfig("foraDaEquipe", [])));
        }
        const fim = m.texto.match(/Projeto #(\d+).*todas as/s);
        if (fim) {
          const merge = esc.partesDoProjeto(Number(fim[1])).map((t) => t.resultado).join(" + ");
          esc.concluirProjeto(id, Number(fim[1]), `MERGE: ${merge}`);
        }
      }
      return { ok: true, texto: "ok" };
    },
  });
  const proj = new Runner(esc, fazProjeto);
  proj.atualizarConfig({ ligado: true, maxPorHora: 50, coordenadora: "claude" });
  esc.lerCaixa("claude"); esc.lerCaixa("antigravity");
  const n0 = chamadas.length;
  esc.enviarMensagem("humano", "claude", "crie um app de tarefas");
  for (let i = 0; i < 6; i++) { await proj.ciclo(); await proj.aguardarOcioso(); }
  const projeto = esc.listarProjetos(1)[0];
  assert.equal(projeto.status, "concluido");
  assert.equal(projeto.partes.length, 2);
  assert.ok(projeto.partes.every((t) => t.status === "entregue"));
  assert.match(projeto.resultado!, /MERGE: parte de claude: backend \+ parte de antigravity: pesquisa/);
  const final = esc.mensagensRecentes().filter((m) => m.para === "humano").at(-1)!;
  assert.match(final.texto, /Projeto #\d+ concluído/);
  assert.ok(chamadas.slice(n0).some((c) => c.id === "antigravity" && c.modelo === "neon"));
  assert.ok(chamadas.slice(n0).some((c) => c.id === "claude" && c.prompt.includes("pegar_tarefa")), "coordenadora faz a própria parte");
  assert.ok(!esc.mensagensRecentes().some((m) => m.para === "claude" && /Tarefa #\d+ entregue: (backend|pesquisa)/.test(m.texto)), "partes não geram aviso avulso");

  // Tirar uma IA da equipe: ela não pode receber parte
  esc.gravarConfig("foraDaEquipe", ["antigravity"]);
  assert.deepEqual(equipeAtiva(esc.lerConfig("foraDaEquipe", [])), ["claude"]);
  const p2 = esc.criarProjeto("claude", "Só eu", "");
  assert.throws(() => esc.distribuirProjeto("claude", p2.id, [{ para: "antigravity", titulo: "x", descricao: "" }], ["claude"]), /Não estão na equipe/);

  console.log("OK: expediente, projetos (dividir → fazer → merge), modelos, travas e teste automático de modelos.");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
