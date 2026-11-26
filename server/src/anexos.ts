import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ehRepositorio, ignorarNoGit, raizRepositorio } from "./git.js";

export const MAX_ANEXO = 20 * 1024 * 1024; // 20 MB por arquivo
export const MAX_ANEXOS = 10;

export interface AnexoRecebido { nome: string; dados: string } // dados em base64 (com ou sem prefixo data:)
export interface AnexoSalvo { nome: string; caminho: string; bytes: number }

/** Nome seguro: sem pastas, sem caracteres proibidos no Windows. */
export function nomeSeguro(nome: string): string {
  const base = path.basename(String(nome || "arquivo").replace(/\\/g, "/"));
  const limpo = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return limpo || "arquivo";
}

/** Salva os anexos em <pasta do chat>/.ktn-anexos/, que fica fora do git (.git/info/exclude). */
export async function salvarAnexos(pastaChat: string, anexos: AnexoRecebido[]): Promise<AnexoSalvo[]> {
  if (!Array.isArray(anexos) || !anexos.length) return [];
  if (anexos.length > MAX_ANEXOS) throw new Error(`No máximo ${MAX_ANEXOS} anexos por mensagem.`);
  const buffers = anexos.map((a) => {
    const b = Buffer.from(String(a?.dados ?? "").replace(/^data:[^,]*,/, ""), "base64");
    if (!b.length) throw new Error(`O anexo "${a?.nome}" está vazio.`);
    if (b.length > MAX_ANEXO) throw new Error(`"${a?.nome}" passa de ${MAX_ANEXO / 1024 / 1024} MB.`);
    return b;
  });
  const pasta = path.join(pastaChat, ".ktn-anexos");
  mkdirSync(pasta, { recursive: true });
  if (await ehRepositorio(pastaChat)) ignorarNoGit(await raizRepositorio(pastaChat), ".ktn-anexos/");
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return anexos.map((a, i) => {
    const caminho = path.join(pasta, `${carimbo}-${i + 1}-${nomeSeguro(a.nome)}`);
    writeFileSync(caminho, buffers[i]);
    return { nome: nomeSeguro(a.nome), caminho, bytes: buffers[i].length };
  });
}

const tamanho = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Texto que vai junto da mensagem para as IAs abrirem os arquivos. */
export function textoAnexos(salvos: AnexoSalvo[]): string {
  if (!salvos.length) return "";
  return `\n\n📎 Anexos (abra pelo caminho com suas ferramentas de leitura):\n${salvos.map((s) => `- ${s.nome} (${tamanho(s.bytes)}): ${s.caminho}`).join("\n")}`;
}
