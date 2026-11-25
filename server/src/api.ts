import express, { type Express, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Escritorio } from "./db.js";
import { detectarEquipe, localizar, type Deteccao } from "./equipe/detectar.js";
import { conectarAoOffice, liberarFerramentasOffice } from "./equipe/instalar.js";
import { catalogoComEstado, testarModelos, type ProgressoTeste } from "./equipe/modelos.js";
import { carregarRegistro, definirModelo } from "./equipe/registro.js";
import type { Runner } from "./runner.js";

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
  api.use(express.json());

  api.get(
    "/estado",
    tentar(async (req) => ({
      equipe: await equipe(req.query.atualizar === "1"),
      status: escritorio.statusEquipe(),
      tarefas: escritorio.listarTarefas().slice(-60).reverse(),
      mensagens: escritorio.mensagensRecentes(120),
      eventos: escritorio.eventosRecentes(60),
      modelos: catalogoComEstado(),
      teste,
      runner: runner.estado(),
      projetos: escritorio.listarProjetos(15),
      foraDaEquipe: escritorio.lerConfig<string[]>("foraDaEquipe", []),
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
      const { ligado, coordenadora, pastaTrabalho, maxPorHora } = req.body ?? {};
      return runner.atualizarConfig({
        ...(typeof ligado === "boolean" ? { ligado } : {}),
        ...(typeof coordenadora === "string" && coordenadora ? { coordenadora } : {}),
        ...(typeof pastaTrabalho === "string" && pastaTrabalho ? { pastaTrabalho } : {}),
        ...(Number(maxPorHora) > 0 ? { maxPorHora: Number(maxPorHora) } : {}),
      });
    }),
  );

  api.post(
    "/mensagem",
    protegido,
    tentar((req) => {
      const texto = String(req.body?.texto ?? "").trim();
      if (!texto) throw new Error("Mensagem vazia.");
      const para = String(req.body?.para || runner.config.coordenadora);
      return escritorio.enviarMensagem("humano", para, texto);
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
