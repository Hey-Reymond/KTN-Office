import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acharNoPath, URL_OFFICE } from "./detectar.js";
import { rodar } from "./processo.js";
import type { ConfigCli } from "./registro.js";

export interface PlanoInstalacao {
  possivel: boolean;
  comando?: string;
  args?: string[];
  /** Texto exato mostrado ao usuário antes de confirmar. */
  descricao: string;
  depois?: string;
}

/** Monta o plano. Não executa nada: quem chama mostra ao usuário e pede confirmação. */
export function planejarInstalacao(cfg: ConfigCli): PlanoInstalacao {
  const pacote = cfg.instalar?.npm;
  if (!pacote) return { possivel: false, descricao: `${cfg.nome} não tem instalação automática. Adicione manualmente.` };
  if (!acharNoPath("npm")) {
    return {
      possivel: false,
      descricao: "Precisa do Node.js (com npm) pra instalar. Baixe em https://nodejs.org e rode a detecção de novo.",
    };
  }
  return {
    possivel: true,
    comando: "npm",
    args: ["install", "-g", pacote],
    descricao: `npm install -g ${pacote}`,
    depois: cfg.login,
  };
}

export async function executarInstalacao(plano: PlanoInstalacao, aoReceber?: (t: string) => void) {
  if (!plano.possivel || !plano.comando) throw new Error(plano.descricao);
  const r = await rodar(plano.comando, plano.args ?? [], { timeoutMs: 10 * 60_000, aoReceber });
  if (r.codigo !== 0) throw new Error(`Instalação falhou (código ${r.codigo}). Veja o log acima.`);
}

/** Liga o CLI ao servidor do escritório. */
export async function conectarAoOffice(id: string, cfg: ConfigCli, caminho: string): Promise<string> {
  const url = URL_OFFICE(id);
  switch (cfg.conexaoOffice) {
    case "claude-mcp": {
      await rodar(caminho, ["mcp", "remove", "office", "--scope", "user"], { timeoutMs: 20_000 }); // se existir
      const r = await rodar(caminho, ["mcp", "add", "--scope", "user", "--transport", "http", "office", url], {
        timeoutMs: 20_000,
      });
      if (r.codigo !== 0) throw new Error(`Falhou ao conectar: ${r.stderr || r.stdout}`);
      return `Conectado (claude mcp add office ${url})`;
    }
    case "gemini-settings": {
      const pasta = path.join(os.homedir(), ".gemini");
      const arq = path.join(pasta, "settings.json");
      mkdirSync(pasta, { recursive: true });
      let settings: Record<string, any> = {};
      if (existsSync(arq)) {
        try {
          settings = JSON.parse(readFileSync(arq, "utf8"));
        } catch {
          throw new Error(`${arq} não é um JSON válido. Corrija o arquivo antes de conectar.`);
        }
        writeFileSync(arq + ".bak", readFileSync(arq)); // backup antes de mexer
      }
      settings.mcpServers = { ...settings.mcpServers, office: { httpUrl: url } };
      writeFileSync(arq, JSON.stringify(settings, null, 2) + "\n");
      return `Conectado (${arq})`;
    }
    default:
      return `Conexão manual: configure um servidor MCP HTTP chamado "office" com a URL ${url}`;
  }
}
