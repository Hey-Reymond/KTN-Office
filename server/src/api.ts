import express, { type Express, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Escritorio } from "./db.js";
import { detectarEquipe, localizar, type Deteccao } from "./equipe/detectar.js";
import { conectarAoOffice, liberarFerramentasOffice } from "./equipe/instalar.js";
import { catalogoComEstado, testarModelos, type ProgressoTeste } from "./equipe/modelos.js";
import { carregarRegistro, definirModelo } from "./equipe/registro.js";
import type { Runner } from "./runner.js";
import { aplicarFerramenta, catalogoFerramentas, estadoFerramentas, navegadoresInstalados, prepararNavegador } from "./ferramentas.js";
import { exigePerguntar } from "./ferramentas.js";
import { lerConfigGithub, reposDaConta, statusGithub } from "./github.js";
import { aplicarNoProjeto, ehRepositorio, limparWorktrees } from "./git.js";
import { pastaDoChat } from "./integracao.js";
import { salvarAnexos, textoAnexos } from "./anexos.js";
import { descrever, dispararUm } from "./agenda.js";
import { apagarReceita, listarReceitas, salvarReceita } from "./receitas.js";
import { salvarCustom } from "./equipe/registro.js";
import { chaveDe, listarModelosApi, PROVEDORES, salvarChave } from "./equipe/apis.js";
import { enviarNtfy, type ConfigNotificacoes } from "./notificar.js";
import { existsSync, statSync } from "node:fs";
import { apagarMemoria, arquivoMemoria, escreverMemoria, lerMemoria } from "./memoria.js";

const PUBLICO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

/**
 * Rotas da interface. As que mudam algo exigem o cabeçalho X-KTN: um site qualquer aberto no
 * navegador não consegue mandar esse cabeçalho pro 127.0.0.1 (o navegador bloqueia), então
 * só a própria página do KTN Office consegue ligar o expediente, testar modelos etc.
 */
let cacheGh: { quando: number; valor: Awaited<ReturnType<typeof statusGithub>> } | null = null;
/** Pergunta ao gh quem está logado, no máximo uma vez por minuto (a interface consulta o estado a cada poucos segundos). */
async function statusGithubCache() {
  if (!cacheGh || Date.now() - cacheGh.quando > 60_000) cacheGh = { quando: Date.now(), valor: await statusGithub() };
  return cacheGh.valor;
}

export function montarApi(app: Express, escritorio: Escritorio, runner: Runner) {
  let deteccao: { quando: number; dados: Deteccao[] } | null = null;
  let detectando: Promise<Deteccao[]> | null = null;
  let teste: ProgressoTeste | null = null;

  const equipe = async (forcar = false) => {
    if (!forcar && deteccao && Date.now() - deteccao.quando < 60_000) return deteccao.dados;
    detectando ??= detectarEquipe().finally(() => (detectando = null));
    deteccao = { quando: Date.now(), dados: await detectando };
    return deteccao.dados;
  };

  const protegido = (req: Request, res: Response, next: NextFunction) => {
    if (req.get("X-KTN") !== "1") {
      res.status(403).json({ erro: "Use a interface do KTN Office." });
      return;
    }
    next();
  };
  const tentar =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      try {
        res.json((await fn(req, res)) ?? { ok: true });
      } catch (e) {
        res.status(400).json({ erro: e instanceof Error ? e.message : String(e) });
      }
    };

  app.use(express.static(PUBLICO));
  const api = express.Router();
  api.use(express.json({ limit: "250mb" })); // anexos vão em base64

  api.get(
    "/estado",
    tentar(async (req) => ({
      equipe: await equipe(req.query.atualizar === "1"),
      status: escritorio.statusEquipe(),
      tarefas: escritorio.listarTarefas().slice(-60).reverse(),
      mensagens: escritorio.mensagensRecentes(400),
      conversas: escritorio.listarConversas().map((c) => ({ ...c, pastaEfetiva: pastaDoChat(escritorio, c.id) })),
      eventos: escritorio.eventosRecentes(60),
      modelos: catalogoComEstado(),
      teste,
      runner: runner.estado(),
      revisaoCruzada: escritorio.lerConfig("revisaoCruzada", true),
      notificacoes: escritorio.lerConfig<ConfigNotificacoes>("notificacoes", {}),
      provedores: PROVEDORES,
      github: { ...lerConfigGithub(escritorio), ...(await statusGithubCache()) },
      receitas: listarReceitas(),
      agendamentos: escritorio.listarAgendamentos().map((a) => ({ ...a, quando: descrever(a) })),
      projetos: escritorio.listarProjetos(15),
      foraDaEquipe: escritorio.lerConfig<string[]>("foraDaEquipe", []),
      ferramentas: {
        catalogo: catalogoFerramentas(),
        estado: estadoFerramentas(escritorio),
        navegadores: navegadoresInstalados(),
        sistema: process.platform,
        // Para ferramentas exclusivas (controle da tela): IAs instaladas que pedem permissão a cada ação.
        iasQuePedem: Object.entries(carregarRegistro()).filter(([, c]) => c.ativo !== false && c.conexaoOffice === "claude-mcp" && localizar(c)).map(([id]) => id),
      },
      permissoes: {
        pendentes: escritorio.pedidosPendentes(),
        niveis: Object.fromEntries(Object.keys(carregarRegistro()).map((id) => [id, escritorio.nivelDe(id)])),
        sempre: Object.fromEntries(Object.keys(carregarRegistro()).map((id) => [id, escritorio.sempreDe(id)])),
      },
    })),
  );

  api.post(
    "/modelo",
    protegido,
    tentar((req) => definirModelo(String(req.body.cli), String(req.body.modelo), !!req.body.ligado)),
  );

  api.post(
    "/equipe",
    protegido,
    tentar((req) => {
      const cli = String(req.body?.cli);
      const fora = escritorio.lerConfig<string[]>("foraDaEquipe", []).filter((x) => x !== cli);
      if (!req.body?.naEquipe) fora.push(cli);
      escritorio.gravarConfig("foraDaEquipe", fora);
      escritorio.registrarEvento(null, "config", `${cli} ${req.body?.naEquipe ? "entrou na" : "saiu da"} equipe.`);
      return { foraDaEquipe: fora };
    }),
  );

  api.post(
    "/testar-modelos",
    protegido,
    tentar((req) => {
      if (teste?.rodando) throw new Error("Já tem um teste rodando.");
      testarModelos({ cli: req.body?.cli || undefined, aoProgredir: (p) => (teste = { ...p, resultados: [...p.resultados] }) })
        .catch((e) => escritorio.registrarEvento(null, "erro", `Teste de modelos falhou: ${e}`));
      return { ok: true };
    }),
  );

  api.post(
    "/runner",
    protegido,
    tentar((req) => {
      const { ligado, coordenadora, pastaTrabalho, maxPorHora, revisaoCruzada } = req.body ?? {};
      if (typeof revisaoCruzada === "boolean") escritorio.gravarConfig("revisaoCruzada", revisaoCruzada);
      return runner.atualizarConfig({
        ...(typeof ligado === "boolean" ? { ligado } : {}),
        ...(typeof coordenadora === "string" && coordenadora ? { coordenadora } : {}),
        ...(typeof pastaTrabalho === "string" && pastaTrabalho ? { pastaTrabalho } : {}),
        ...(Number(maxPorHora) > 0 ? { maxPorHora: Number(maxPorHora) } : {}),
      });
    }),
  );

  api.post(
    "/notificacoes",
    protegido,
    tentar((req) => {
      const topico = String(req.body?.ntfyTopico ?? "").trim();
      const servidor = String(req.body?.ntfyServidor ?? "").trim();
      if (topico && !/^[\w-]{6,64}$/.test(topico)) throw new Error("Tópico do ntfy: use de 6 a 64 letras, números, - ou _ (difícil de adivinhar, ele é público).");
      if (servidor && !/^https?:\/\//.test(servidor)) throw new Error("Servidor do ntfy deve começar com https://");
      escritorio.gravarConfig("notificacoes", { ntfyTopico: topico || undefined, ntfyServidor: servidor || undefined });
    }),
  );
  api.post(
    "/notificacoes/testar",
    protegido,
    tentar(async () => {
      const ok = await enviarNtfy(escritorio.lerConfig<ConfigNotificacoes>("notificacoes", {}), "KTN Office", "Teste: os avisos estão chegando no celular.");
      if (!ok) throw new Error("Não consegui enviar. Confira o tópico e a internet.");
    }),
  );
  // ---------- GitHub ----------
  api.post("/github", protegido, tentar(async (req) => {
    const b = req.body ?? {};
    const atual = lerConfigGithub(escritorio);
    const repos = Array.isArray(b.repos) ? b.repos.map(String).filter((r: string) => /^[\w.-]+\/[\w.-]+$/.test(r)) : atual.repos;
    const novo = { ligado: typeof b.ligado === "boolean" ? b.ligado : atual.ligado, todos: typeof b.todos === "boolean" ? b.todos : atual.todos, repos };
    escritorio.gravarConfig("github", novo);
    escritorio.registrarEvento(null, "config", `GitHub ${novo.ligado ? `ligado (${novo.todos ? "todos os repositórios" : (novo.repos ?? []).length + " repositório(s)"})` : "desligado"}.`);
    cacheGh = null;
  }));
  api.post("/github/repos", protegido, tentar(async () => ({ repos: await reposDaConta() })));

  // ---------- Receitas ----------
  api.post("/receita", protegido, tentar((req) => salvarReceita(req.body ?? {})));
  api.post("/receita/apagar", protegido, tentar((req) => apagarReceita(String(req.body?.id ?? ""))));

  // ---------- Agenda ----------
  api.post("/agendamento", protegido, tentar((req) => {
    const b = req.body ?? {};
    return escritorio.criarAgendamento("humano", {
      texto: String(b.texto ?? ""), tipo: b.tipo, minutos: Number(b.minutos) || undefined, hora: b.hora || undefined,
      dias: Array.isArray(b.dias) ? b.dias.map(Number) : undefined, data: b.data || undefined,
      conversa_id: Number(b.conversa_id) || null,
    });
  }));
  api.post("/agendamento/alternar", protegido, tentar((req) => escritorio.alternarAgendamento(Number(req.body?.id), !!req.body?.ativo)));
  api.post("/agendamento/apagar", protegido, tentar((req) => escritorio.apagarAgendamento(Number(req.body?.id))));
  api.post("/agendamento/agora", protegido, tentar((req) => {
    const a = escritorio.agendamento(Number(req.body?.id));
    if (!a) throw new Error("Agendamento não existe.");
    dispararUm(escritorio, a, runner.config.coordenadora); // mantém a próxima execução como estava
  }));

  // ---------- IAs por API ----------
  const dadosApi = (b: any) => {
    const prov = PROVEDORES[String(b?.provedor ?? "")];
    if (!prov) throw new Error("Escolha um provedor.");
    const baseUrl = String(b?.baseUrl || prov.baseUrl).trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error("Endereço da API inválido (comece com http:// ou https://).");
    return { prov, provedor: String(b.provedor), baseUrl };
  };
  api.post(
    "/api-ia/modelos",
    protegido,
    tentar(async (req) => {
      const { prov, baseUrl } = dadosApi(req.body);
      const chave = String(req.body?.chave ?? "").trim() || (req.body?.id ? chaveDe(String(req.body.id)) : undefined);
      if (prov.precisaChave && !chave) throw new Error("Cole a chave da API primeiro.");
      try {
        return { modelos: await listarModelosApi(prov.tipo, baseUrl, chave) };
      } catch (e) {
        throw new Error(`Não consegui listar os modelos: ${e instanceof Error ? e.message : e}. ${prov.local ? prov.dica : "Confira a chave."}`);
      }
    }),
  );
  api.post(
    "/api-ia/salvar",
    protegido,
    tentar(async (req) => {
      const { prov, provedor, baseUrl } = dadosApi(req.body);
      const id = String(req.body?.id ?? "").trim().toLowerCase();
      if (!/^[a-z0-9_-]{2,32}$/.test(id)) throw new Error("Nome curto: 2 a 32 letras minúsculas, números, - ou _.");
      const existente = carregarRegistro()[id];
      if (existente && existente.tipo !== "api") throw new Error(`"${id}" já é um CLI. Escolha outro nome.`);
      const modelos: string[] = Array.isArray(req.body?.modelos) ? req.body.modelos.map(String).filter(Boolean) : [];
      if (!modelos.length) throw new Error("Escolha pelo menos um modelo.");
      const padrao = modelos.includes(String(req.body?.padrao)) ? String(req.body.padrao) : modelos[0];
      const chave = String(req.body?.chave ?? "").trim();
      if (prov.precisaChave && !chave && !chaveDe(id)) throw new Error("Cole a chave da API.");
      salvarCustom(id, {
        tipo: "api",
        nome: String(req.body?.nome || `${prov.nome}`).slice(0, 60),
        api: { provedor, tipo: prov.tipo, baseUrl },
        modelos: Object.fromEntries(modelos.map((m) => [m, { id: m }])),
        modeloPadrao: padrao,
        modelosDetectados: {}, modelosLigados: [], modelosDesligados: [],
        especialidades: String(req.body?.especialidades ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        ativo: true,
      });
      if (chave) salvarChave(id, chave);
      escritorio.registrarEvento(null, "config", `${id} (${prov.nome}) entrou na equipe com ${modelos.length} modelo(s).`);
      await equipe(true);
    }),
  );
  api.post(
    "/api-ia/remover",
    protegido,
    tentar(async (req) => {
      const id = String(req.body?.id ?? "");
      if (carregarRegistro()[id]?.tipo !== "api") throw new Error("Essa IA não é por API.");
      salvarCustom(id, { ativo: false });
      salvarChave(id, null);
      escritorio.registrarEvento(null, "config", `${id} saiu da equipe (chave apagada).`);
      await equipe(true);
    }),
  );
  api.post("/cota/limite", protegido, tentar((req) => escritorio.definirLimite5h(String(req.body?.cli), Number(req.body?.limite) || null)));
  api.post("/cota/liberar", protegido, tentar((req) => escritorio.marcarSemCota(String(req.body?.cli), null)));
  api.post(
    "/retomar",
    protegido,
    tentar((req) => runner.retomar(String(req.body?.cli))),
  );

  api.post(
    "/mensagem",
    protegido,
    tentar(async (req) => {
      const anexos = Array.isArray(req.body?.anexos) ? req.body.anexos : [];
      const texto = String(req.body?.texto ?? "").trim() || (anexos.length ? "Veja os arquivos anexados." : "");
      if (!texto) throw new Error("Mensagem vazia.");
      const para = String(req.body?.para || runner.config.coordenadora);
      // Sem chat aberto: cria um, com o começo da mensagem como título.
      let conversa = Number(req.body?.conversa_id) || null;
      if (!conversa || !escritorio.conversa(conversa)) {
        conversa = escritorio.criarConversa(texto.split("\n")[0].slice(0, 50)).id;
      }
      const salvos = await salvarAnexos(pastaDoChat(escritorio, conversa), anexos);
      return escritorio.enviarMensagem("humano", para, texto + textoAnexos(salvos), null, conversa);
    }),
  );

  // ---------- Permissões ----------
  api.post(
    "/permissao/responder",
    protegido,
    tentar((req) => {
      const pedido = escritorio.pedido(Number(req.body?.id));
      // Controle da tela (e afins): "sempre permitir" vira "só desta vez".
      const sempre = !!req.body?.sempre && !(pedido && exigePerguntar(pedido.ferramenta));
      return escritorio.responderPermissao(Number(req.body?.id), !!req.body?.permitir, sempre);
    }),
  );
  api.post(
    "/permissao/nivel",
    protegido,
    tentar((req) => escritorio.definirNivel(String(req.body?.cli), req.body?.nivel)),
  );
  api.post(
    "/permissao/sempre",
    protegido,
    tentar((req) => {
      const cli = String(req.body?.cli);
      escritorio.definirSempre(cli, escritorio.sempreDe(cli).filter((f) => f !== String(req.body?.remover)));
    }),
  );

  // ---------- Ferramentas (navegador) ----------
  api.post(
    "/ferramenta",
    protegido,
    tentar(async (req) => {
      const { id, ligada, navegador, semPerguntar, ia } = req.body ?? {};
      const mudanca = {
        ...(typeof ia === "string" ? { ia } : {}),
        ...(typeof ligada === "boolean" ? { ligada } : {}),
        ...(typeof navegador === "string" ? { navegador } : {}),
        ...(typeof semPerguntar === "boolean" ? { semPerguntar } : {}),
      };
      return { mensagens: await aplicarFerramenta(escritorio, String(id), mudanca) };
    }),
  );
  api.post(
    "/ferramenta/preparar",
    protegido,
    tentar(async (req) => ({ mensagem: await prepararNavegador(String(req.body?.id), String(req.body?.navegador)) })),
  );

  // ---------- Chats ----------
  api.post("/conversa", protegido, tentar((req) => escritorio.criarConversa(String(req.body?.titulo ?? "Novo chat"))));
  api.post(
    "/conversa/renomear",
    protegido,
    tentar((req) => escritorio.renomearConversa(Number(req.body?.id), String(req.body?.titulo ?? ""))),
  );
  api.post(
    "/conversa/apagar",
    protegido,
    tentar((req) => {
      const id = Number(req.body?.id);
      escritorio.apagarConversa(id);
      apagarMemoria(id);
      escritorio.registrarEvento(null, "config", `Chat #${id} apagado (mensagens e memória).`);
    }),
  );
  api.post(
    "/conversa/pasta",
    protegido,
    tentar(async (req) => {
      const id = Number(req.body?.id);
      const pasta = String(req.body?.pasta ?? "").trim().replace(/^"(.*)"$/, "$1");
      if (pasta && (!existsSync(pasta) || !statSync(pasta).isDirectory())) throw new Error(`A pasta não existe: ${pasta}`);
      escritorio.definirPastaConversa(id, pasta || null);
      const git = pasta ? await ehRepositorio(pasta) : false;
      escritorio.registrarEvento(null, "config", `Chat #${id} agora trabalha em ${pasta || "pasta padrão"}${git ? " (repositório git)" : ""}.`);
      return { git };
    }),
  );
  api.post(
    "/projeto/aplicar",
    protegido,
    tentar(async (req) => {
      const p = escritorio.projeto(Number(req.body?.id));
      if (!p?.branch_final) throw new Error("Esse projeto não tem branch de resultado.");
      const msg = await aplicarNoProjeto(pastaDoChat(escritorio, p.conversa_id), p.id);
      escritorio.registrarEvento(null, "projeto", msg);
      return { mensagem: msg };
    }),
  );
  api.post(
    "/projeto/limpar",
    protegido,
    tentar(async (req) => {
      const p = escritorio.projeto(Number(req.body?.id));
      if (!p) throw new Error("Projeto não existe.");
      const pastas = [...escritorio.partesDoProjeto(p.id).map((t) => t.pasta), p.pasta_final].filter((x): x is string => !!x);
      await limparWorktrees(pastaDoChat(escritorio, p.conversa_id), pastas);
      escritorio.registrarEvento(null, "projeto", `Cópias de trabalho do projeto #${p.id} removidas (as branches continuam no git).`);
      return { mensagem: "Cópias removidas. As branches ktn/… continuam no git." };
    }),
  );
  api.get(
    "/memoria",
    tentar((req) => {
      const id = Number(req.query.id);
      return { arquivo: arquivoMemoria(id), memoria: lerMemoria(id) };
    }),
  );
  api.post(
    "/memoria",
    protegido,
    tentar((req) => {
      const id = Number(req.body?.id);
      const c = escritorio.conversa(id);
      if (!c) throw new Error(`Chat #${id} não existe.`);
      escreverMemoria(id, c.titulo, String(req.body?.texto ?? ""), true);
    }),
  );

  api.post(
    "/conectar",
    protegido,
    tentar(async (req) => {
      const id = String(req.body?.cli);
      const cfg = carregarRegistro()[id];
      const caminho = cfg && localizar(cfg);
      if (!cfg || !caminho) throw new Error(`${id} não está instalado.`);
      const msgs = [await conectarAoOffice(id, cfg, caminho), liberarFerramentasOffice(cfg)].filter(Boolean);
      await equipe(true);
      return { mensagens: msgs };
    }),
  );

  app.use("/api", api);
}
