import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acharNoPath, ARQ_MCP_ANTIGRAVITY, lerJsonTolerante, URL_OFFICE } from "./detectar.js";
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

const ehWindows = process.platform === "win32";

/** Monta o plano. Não executa nada: quem chama mostra ao usuário e pede confirmação. */
export function planejarInstalacao(cfg: ConfigCli): PlanoInstalacao {
  const inst = cfg.instalar ?? {};
  const script = ehWindows ? inst.windows : inst.unix;

  // Instalador oficial do fabricante tem prioridade sobre npm.
  if (script) {
    return {
      possivel: true,
      comando: ehWindows ? "powershell" : "bash",
      args: ehWindows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script] : ["-c", script],
      descricao: script,
      depois: `${cfg.login ?? ""} Se o comando não for encontrado, abra um terminal novo (o PATH muda só em janelas novas).`.trim(),
    };
  }
  if (!inst.npm) return { possivel: false, descricao: `${cfg.nome} não tem instalação automática. Adicione manualmente.` };
  if (!acharNoPath("npm")) {
    return {
      possivel: false,
      descricao: "Precisa do Node.js (com npm) pra instalar. Baixe em https://nodejs.org e rode a detecção de novo.",
    };
  }
  return {
    possivel: true,
    comando: "npm",
    args: ["install", "-g", inst.npm],
    descricao: `npm install -g ${inst.npm}`,
    depois: cfg.login,
  };
}

export async function executarInstalacao(plano: PlanoInstalacao, aoReceber?: (t: string) => void) {
  if (!plano.possivel || !plano.comando) throw new Error(plano.descricao);
  const r = await rodar(plano.comando, plano.args ?? [], { timeoutMs: 10 * 60_000, aoReceber });
  if (r.codigo !== 0) throw new Error(`Instalação falhou (código ${r.codigo}). Veja o log acima.`);
}

/** Coloca o servidor "office" num arquivo JSON de MCP, preservando o resto e fazendo backup. */
function gravarOfficeNoJson(arq: string, entrada: Record<string, string>) {
  mkdirSync(path.dirname(arq), { recursive: true });
  let dados: Record<string, any> = {};
  if (existsSync(arq)) {
    const bruto = readFileSync(arq, "utf8");
    try {
      dados = lerJsonTolerante(arq);
    } catch {
      throw new Error(`${arq} não é um JSON válido. Corrija o arquivo antes de conectar.`);
    }
    writeFileSync(arq + ".bak", bruto); // backup antes de mexer
  }
  dados.mcpServers = { ...dados.mcpServers, office: entrada };
  writeFileSync(arq, JSON.stringify(dados, null, 2) + "\n");
}

/** Adiciona uma regra em permissions.allow de um settings.json (sem duplicar, com backup). */
export function liberarNoSettings(arq: string, regra: string): boolean {
  mkdirSync(path.dirname(arq), { recursive: true });
  let dados: Record<string, any> = {};
  if (existsSync(arq)) {
    const bruto = readFileSync(arq, "utf8");
    try {
      dados = lerJsonTolerante(arq);
    } catch {
      throw new Error(`${arq} não é um JSON válido. Corrija o arquivo antes de liberar as ferramentas.`);
    }
    writeFileSync(arq + ".bak", bruto);
  }
  const permissoes = (dados.permissions ??= {});
  const allow: string[] = Array.isArray(permissoes.allow) ? permissoes.allow : [];
  if (allow.includes(regra)) return false;
  permissoes.allow = [...allow, regra];
  writeFileSync(arq, JSON.stringify(dados, null, 2) + "\n");
  return true;
}

/**
 * Libera todas as ferramentas do "office" no CLI, pra ele não pedir confirmação a cada chamada.
 * Só afeta o servidor local do escritório; o resto das permissões continua como estava.
 */
export function liberarFerramentasOffice(cfg: ConfigCli): string | null {
  switch (cfg.conexaoOffice) {
    case "claude-mcp": {
      const arq = path.join(os.homedir(), ".claude", "settings.json");
      liberarNoSettings(arq, "mcp__office");
      return `Ferramentas do office liberadas no Claude (${arq})`;
    }
    case "antigravity-mcp": {
      const arq = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
      liberarNoSettings(arq, "mcp(office/*)");
      return `Ferramentas do office liberadas no Antigravity (${arq})`;
    }
    default:
      return null;
  }
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
    case "codex-mcp": {
      await rodar(caminho, ["mcp", "remove", "office"], { timeoutMs: 20_000 }); // se existir
      const r = await rodar(caminho, ["mcp", "add", "office", "--url", url], { timeoutMs: 20_000 });
      if (r.codigo !== 0) throw new Error(`Falhou ao conectar: ${r.stderr || r.stdout}`);
      return `Conectado (codex mcp add office --url ${url})`;
    }
    case "gemini-settings": {
      const arq = path.join(os.homedir(), ".gemini", "settings.json");
      gravarOfficeNoJson(arq, { httpUrl: url });
      return `Conectado (${arq})`;
    }
    case "antigravity-mcp": {
      const arq = ARQ_MCP_ANTIGRAVITY();
      gravarOfficeNoJson(arq, { serverUrl: url });
      return `Conectado (${arq}). Reinicie o agy pra ele carregar o servidor.`;
    }
    default:
      return `Conexão manual: configure um servidor MCP HTTP chamado "office" com a URL ${url}`;
  }
}
