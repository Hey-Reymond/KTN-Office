import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pastaDados } from "./memoria.js";

export interface Receita { id: string; nome: string; descricao?: string; texto: string; propria?: boolean }

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARQ_PADRAO = () => process.env.KTN_RECEITAS ?? path.join(RAIZ, "agents", "receitas.json");
const ARQ_PROPRIAS = () => path.join(pastaDados(), "receitas.json");

function ler(arq: string): Record<string, Omit<Receita, "id">> {
  if (!existsSync(arq)) return {};
  try {
    return Object.fromEntries(Object.entries(JSON.parse(readFileSync(arq, "utf8"))).filter(([k]) => !k.startsWith("_"))) as Record<string, Omit<Receita, "id">>;
  } catch {
    return {};
  }
}

/** Receitas prontas + as suas (as suas com o mesmo id substituem a pronta). */
export function listarReceitas(): Receita[] {
  const proprias = ler(ARQ_PROPRIAS());
  const todas = { ...ler(ARQ_PADRAO()), ...proprias };
  return Object.entries(todas).map(([id, r]) => ({ id, ...r, propria: id in proprias }));
}

export function salvarReceita(r: { id?: string; nome: string; descricao?: string; texto: string }): Receita {
  const nome = String(r.nome ?? "").trim().slice(0, 60);
  const texto = String(r.texto ?? "").trim();
  if (!nome) throw new Error("Dê um nome para a receita.");
  if (!texto) throw new Error("Escreva o pedido da receita.");
  if (texto.length > 8000) throw new Error("Receita longa demais (máximo 8000 caracteres).");
  const id = (r.id || nome).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "receita";
  const proprias = ler(ARQ_PROPRIAS());
  proprias[id] = { nome, descricao: String(r.descricao ?? "").trim().slice(0, 80) || undefined, texto };
  mkdirSync(pastaDados(), { recursive: true });
  writeFileSync(ARQ_PROPRIAS(), JSON.stringify(proprias, null, 2) + "\n");
  return { id, ...proprias[id], propria: true };
}

export function apagarReceita(id: string) {
  const proprias = ler(ARQ_PROPRIAS());
  if (!(id in proprias)) throw new Error("Só dá para apagar receitas suas (as prontas ficam).");
  delete proprias[id];
  writeFileSync(ARQ_PROPRIAS(), JSON.stringify(proprias, null, 2) + "\n");
}
