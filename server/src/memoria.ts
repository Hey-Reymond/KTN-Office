import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Memória de cada chat: um arquivo memoria.md numa pasta do PC do usuário.
 * Fica fora do banco de propósito: você pode abrir, ler e editar no Bloco de Notas.
 */
export const pastaDados = () => process.env.KTN_DADOS ?? path.join(os.homedir(), "KTN-Office-dados");

export const pastaConversa = (id: number) => path.join(pastaDados(), "conversas", String(id));
export const arquivoMemoria = (id: number) => path.join(pastaConversa(id), "memoria.md");

export function lerMemoria(id: number): string {
  const arq = arquivoMemoria(id);
  return existsSync(arq) ? readFileSync(arq, "utf8") : "";
}

export function escreverMemoria(id: number, titulo: string, texto: string, substituir = false) {
  mkdirSync(pastaConversa(id), { recursive: true });
  const arq = arquivoMemoria(id);
  if (substituir || !existsSync(arq)) {
    writeFileSync(arq, `# Memória do chat #${id}: ${titulo}\n\n${substituir ? texto.trim() + "\n" : ""}`);
  }
  if (!substituir) appendFileSync(arq, `${texto.trim()}\n`);
}

export function apagarMemoria(id: number) {
  rmSync(pastaConversa(id), { recursive: true, force: true });
}
