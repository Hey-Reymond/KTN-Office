import { ligarNotificacoes } from "./notificar.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { abrirBanco, Escritorio } from "./db.js";
import { criarServidor } from "./tools.js";
import { detectarEquipe } from "./equipe/detectar.js";
import { montarApi } from "./api.js";
import { Runner } from "./runner.js";

const PORTA = Number(process.env.KTN_PORT ?? 7777);
const escritorio = new Escritorio(abrirBanco());

/** Nome do agente vem da URL: /mcp?agent=claude */
function nomeDoAgente(req: Request): string | null {
  const nome = String(req.query.agent ?? "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(nome) ? nome : null;
}

const app = createMcpExpressApp(); // escuta só em 127.0.0.1, com proteção contra DNS rebinding
const runner = new Runner(escritorio);
montarApi(app, escritorio, runner);
ligarNotificacoes(escritorio);

// Modo sem sessão: cada requisição cria um servidor leve; o estado fica todo no SQLite.
app.post("/mcp", async (req: Request, res: Response) => {
  const agente = nomeDoAgente(req);
  if (!agente) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Informe o agente na URL: /mcp?agent=claude" },
      id: null,
    });
    return;
  }
  escritorio.registrarPresenca(agente);
  const server = criarServidor(escritorio, agente);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
    }
  }
});

const metodoNaoPermitido = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Método não permitido" }, id: null });
};
app.get("/mcp", metodoNaoPermitido);
app.delete("/mcp", metodoNaoPermitido);

// Painel rápido (JSON) para você acompanhar pelo navegador.
app.get("/status", (_req: Request, res: Response) => {
  res.json({ equipe: escritorio.statusEquipe(), tarefas: escritorio.listarTarefas() });
});

// Detecção dos CLIs (pra interface do app usar depois).
app.get("/equipe", async (_req: Request, res: Response) => {
  res.json(await detectarEquipe());
});

app.listen(PORTA, "127.0.0.1", () => {
  console.log(`KTN Office rodando em http://127.0.0.1:${PORTA}/mcp?agent=<nome>`);
  console.log(`Status: http://127.0.0.1:${PORTA}/status`);
  console.log(`Interface: http://127.0.0.1:${PORTA}/`);
  runner.iniciar();
});
