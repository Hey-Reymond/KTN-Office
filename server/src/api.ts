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
import { aplicarNoProjeto, ehRepositorio, limparWorktrees } from "./git.js";
import { pastaDoChat } from "./integracao.js";
import { salvarAnexos, textoAnexos } from "./anexos.js";
import { existsSync, statSync } from "node:fs";
import { apagarMemoria, arquivoMemoria, escreverMemoria, lerMemoria } from "./memoria.js";

const PUBLICO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

/**
 * Rotas da interface. As que mudam algo exigem o cabeçalho X-KTN: um site qualquer aberto no
 * navegador não consegue mandar esse cabeçalho pro 127.0.0.1 (o navegador bloqueia), então
 * só a própria página do KTN Office consegue ligar o expediente, testar modelos etc.
 */
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
      projetos: escritorio.listarProjetos(15),
      foraDaEquipe: escritorio.lerConfig<string[]>("foraDaEquipe", []),
      ferramentas: {
        catalogo: catalogoFerramentas(),
        estado: estadoFerramentas(escritorio),
        navegadores: navegadoresInstalados(),
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
    tentar((req) => escritorio.responderPermissao(Number(req.body?.id), !!req.body?.permitir, !!req.body?.sempre)),
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
      const { id, ligada, navegador, semPerguntar } = req.body ?? {};
      const mudanca = {
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
