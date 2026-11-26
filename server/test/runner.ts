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
Object.assign(process.env, { KTN_CLIS: clis, KTN_CLIS_CUSTOM: path.join(tmp, "custom.json"), KTN_DADOS: path.join(tmp, "dados") });

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

  // IA que falha seguido (ex.: flag errada) fica pausada e você é avisado, em vez de falhar em loop
  {
    const quebrada = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], trabalhar: async () => ({ ok: false, texto: "", erro: "flags provided but not defined: -m\nUsage..." }) }));
    quebrada.atualizarConfig({ ligado: true, maxPorHora: 99, maxTentativas: 99 });
    esc.enviarMensagem("x", "antigravity", "oi");
    const antesFalha = esc.eventosRecentes(500).filter((e: any) => e.tipo === "inicio" && e.agente === "antigravity").length;
    for (let i = 0; i < 6; i++) { await quebrada.ciclo(); await quebrada.aguardarOcioso(); }
    const depoisFalha = esc.eventosRecentes(500).filter((e: any) => e.tipo === "inicio" && e.agente === "antigravity").length;
    assert.equal(depoisFalha - antesFalha, 3, "para depois de 3 falhas seguidas");
    assert.ok(quebrada.estado().pausadas.antigravity, "aparece como pausada");
    assert.ok(esc.mensagensRecentes().some((m) => m.para === "humano" && m.texto.includes("antigravity falhou 3 vezes")));
    assert.ok(!esc.eventosRecentes(5).some((e: any) => String(e.texto).includes("\n")), "erro resumido numa linha na linha do tempo");
    quebrada.retomar("antigravity");
    assert.equal(quebrada.estado().pausadas.antigravity, undefined);
    quebrada.atualizarConfig({ ligado: false });
    esc.lerCaixa("antigravity");
  }

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
    const vivo = par.estado().trabalhando as Record<string, { oque: string; progresso: unknown[] }>;
    assert.ok(vivo.claude && vivo.claude.oque.startsWith("tarefa"), "interface vê quem está trabalhando e no quê");
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

  // ---------- Chats separados: cada pedido e resposta fica no seu chat ----------
  {
    const memoria = await import("../src/memoria.js");
    const { existsSync } = await import("node:fs");
    const a = esc.criarConversa("Chat A");
    const b = esc.criarConversa("Chat B");
    esc.enviarMensagem("humano", "claude", "pedido do A", null, a.id);
    esc.enviarMensagem("humano", "claude", "pedido do B", null, b.id);
    for (const m of esc.lerCaixa("claude").filter((m) => m.de === "humano")) {
      esc.enviarMensagem("claude", "humano", `resposta: ${m.texto}`, null, m.conversa_id);
    }
    const doA = esc.historicoConversa(a.id).map((m) => m.texto);
    assert.deepEqual(doA, ["pedido do A", "resposta: pedido do A"], "chat A não mistura com B");
    // Projeto herda o chat e o resultado final volta pra ele
    const pj = esc.criarProjeto("claude", "x", "", b.id);
    const [parte] = esc.distribuirProjeto("claude", pj.id, [{ para: "claude", titulo: "t", descricao: "" }], ["claude"]);
    assert.equal(parte.conversa_id, b.id);
    esc.pegarTarefa("claude", parte.id); esc.entregarTarefa("claude", parte.id, "feito");
    esc.concluirProjeto("claude", pj.id, "final");
    assert.match(esc.historicoConversa(b.id).at(-1)!.texto, /Projeto #\d+ concluído/);
    // Renomear e apagar (com a memória)
    esc.renomearConversa(a.id, "Landing azul");
    assert.equal(esc.conversa(a.id)!.titulo, "Landing azul");
    memoria.escreverMemoria(a.id, "Landing azul", "- prefere azul");
    assert.ok(existsSync(memoria.arquivoMemoria(a.id)));
    esc.apagarConversa(a.id); memoria.apagarMemoria(a.id);
    assert.equal(esc.conversa(a.id), undefined);
    assert.equal(esc.historicoConversa(a.id).length, 0);
    assert.ok(!existsSync(memoria.arquivoMemoria(a.id)));
  }

  // Banco antigo (sem chats): mensagens com o humano viram a "Conversa 1"
  {
    const Database = (await import("better-sqlite3")).default;
    const velho = path.join(tmp, "velho.db");
    const db = new Database(velho);
    db.exec(`CREATE TABLE mensagens (id INTEGER PRIMARY KEY AUTOINCREMENT, de TEXT NOT NULL, para TEXT NOT NULL, texto TEXT NOT NULL,
      tarefa_id INTEGER, lida INTEGER NOT NULL DEFAULT 0, criada_em TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO mensagens (de, para, texto) VALUES ('humano','claude','msg antiga');`);
    db.close();
    const migrado = new Escritorio(abrirBanco(velho));
    const c1 = migrado.listarConversas();
    assert.equal(c1[0].titulo, "Conversa 1");
    assert.equal(migrado.historicoConversa(c1[0].id)[0].texto, "msg antiga");
  }

  // ---------- Modelo fora do plano: aprende sozinho e tenta de novo com o padrão ----------
  {
    const usados: (string | undefined)[] = [];
    const rm = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], async trabalhar(prompt, o = {}) {
      usados.push(o.modelo);
      if (o.modelo === "carbon") return { ok: false, texto: "", erro: "The 'gemini-4-carbon' model is not supported when using Codex with a ChatGPT account." };
      const t = prompt.match(/pegar_tarefa com id (\d+)/);
      if (t) { const x = esc.pegarTarefa(id, Number(t[1])); esc.entregarTarefa(id, x.id, "ok"); }
      return { ok: true, texto: "ok" };
    } }));
    rm.atualizarConfig({ ligado: true, maxPorHora: 99 });
    definirModelo("antigravity", "carbon", true);
    // limpa a escolha manual pra valer o resultado do teste automático
    const { salvarCustom } = await import("../src/equipe/registro.js");
    salvarCustom("antigravity", { modelosLigados: [], modelosDesligados: [], modelosDetectados: {} });
    for (const t of esc.tarefasAbertasPara("antigravity")) esc.cancelarTarefa(t.id, "limpeza do teste");
    esc.gravarConfig("foraDaEquipe", ["claude"]);
    const tm = esc.criarTarefa("claude", "difícil", "", "antigravity", "carbon");
    esc.lerCaixa("antigravity");
    await rm.ciclo(); await rm.aguardarOcioso();
    assert.equal(usados[0], "carbon");
    assert.equal(usados.length, 2, "tentou o modelo e depois outro liberado, na mesma execução");
    assert.notEqual(usados[1], "carbon");
    assert.equal(esc.tarefa(tm.id)!.status, "entregue");
    assert.equal(estadoModelo(carregarRegistro().antigravity, "carbon"), "indisponivel", "aprendeu que o modelo está fora do plano");
    assert.equal(rm.estado().pausadas.antigravity, undefined, "não conta como falha");
    rm.atualizarConfig({ ligado: false });
    esc.gravarConfig("foraDaEquipe", []);
  }

  // ---------- O padrão do próprio CLI fora do plano (codex grátis com sol): aprende pelo id e troca ----------
  {
    const { salvarCustom } = await import("../src/equipe/registro.js");
    const exeTeste = carregarRegistro().antigravity.executavel;
    salvarCustom("codex", { nome: "Codex", executavel: exeTeste, prompt: ["{prompt}"], ativo: true,
      modelos: { astra: { id: "gpt-6.2-astra" }, sol: { id: "gpt-6.2-sol" }, luna: { id: "gpt-6-luna" } } } as never);
    const recusados = ["gpt-6.2-sol", "gpt-6.2-astra"];
    const usados: (string | undefined)[] = [];
    const rc = new Runner(esc, (id, cfg) => ({ id, tipo: "cli", especialidades: [], async trabalhar(prompt, o = {}) {
      const real = o.modelo ? cfg.modelos![o.modelo].id : "gpt-6.2-sol"; // sem -m o CLI usa o padrão da conta (sol)
      usados.push(o.modelo);
      if (recusados.includes(real!)) return { ok: false, texto: "", erro: `The '${real}' model is not supported when using Codex with a ChatGPT account.` };
      const t = prompt.match(/pegar_tarefa com id (\d+)/);
      if (t) { const x = esc.pegarTarefa(id, Number(t[1])); esc.entregarTarefa(id, x.id, "ok"); }
      return { ok: true, texto: "ok" };
    } }));
    if (!carregarRegistro().codex) { console.log("(sem codex no catálogo de teste, pulando)"); } else {
      rc.atualizarConfig({ ligado: true, maxPorHora: 99 });
      esc.gravarConfig("foraDaEquipe", ["claude", "antigravity"]);
      const tc = esc.criarTarefa("claude", "qualquer", "", "codex");
      esc.lerCaixa("codex");
      await rc.ciclo(); await rc.aguardarOcioso();
      assert.equal(esc.tarefa(tc.id)!.status, "entregue", `entregou depois de trocar de modelo (tentou: ${usados.join(", ")})`);
      assert.equal(estadoModelo(carregarRegistro().codex, "sol"), "indisponivel", "aprendeu que sol (padrão do CLI) está fora do plano");
      assert.equal(rc.estado().pausadas.codex, undefined);
      rc.atualizarConfig({ ligado: false });
      esc.gravarConfig("foraDaEquipe", []);
    }
    salvarCustom("codex", { ativo: false } as never); // tira da equipe para os próximos testes
  }

  // ---------- Permissões no runner: nível por IA e "uma vez" ----------
  {
    const niveis: (string | undefined)[] = [];
    const rp = new Runner(esc, (id) => ({ id, tipo: "cli", especialidades: [], async trabalhar(_p, o = {}) { niveis.push(o.nivel); esc.lerCaixa(id); return { ok: true, texto: "" }; } }));
    rp.atualizarConfig({ ligado: true, maxPorHora: 99 });
    esc.gravarConfig("foraDaEquipe", ["claude"]);
    esc.enviarMensagem("x", "antigravity", "1");
    await rp.ciclo(); await rp.aguardarOcioso();
    const ped = esc.pedirPermissao("antigravity", "comandos", "npm install", "recado");
    esc.responderPermissao(ped.id, true, false); // manda mensagem e libera uma vez
    await rp.ciclo(); await rp.aguardarOcioso();
    esc.enviarMensagem("x", "antigravity", "3");
    await rp.ciclo(); await rp.aguardarOcioso();
    assert.deepEqual(niveis, ["leitura", "comandos", "leitura"], "uma vez vale só pra próxima execução");
    const ped2 = esc.pedirPermissao("antigravity", "edicao", "criar arquivo", "recado");
    esc.responderPermissao(ped2.id, true, true);
    assert.equal(esc.nivelDe("antigravity"), "edicao", "sempre permitir sobe o nível");
    rp.atualizarConfig({ ligado: false });
    esc.gravarConfig("foraDaEquipe", []);
  }

  console.log("OK: expediente, projetos (dividir → fazer → merge), chats e memória, permissões, modelos, travas e teste automático de modelos.");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
