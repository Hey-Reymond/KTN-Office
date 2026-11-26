import os from "node:os";
import path from "node:path";
import type { Escritorio, ParteProjeto, Tarefa } from "./db.js";
import { commitarParte, criarWorktree, ehRepositorio, ignorarNoGit, integrarPartes, raizRepositorio } from "./git.js";
import { rodar } from "./equipe/processo.js";

export const PASTA_PADRAO = path.join(os.homedir(), "KTN-Office-trabalho");

/** Pasta em que as IAs trabalham num chat: a do chat, ou a pasta padrão do expediente. */
export function pastaDoChat(esc: Escritorio, conversaId: number | null | undefined): string {
  const doChat = conversaId ? esc.conversa(conversaId)?.pasta : null;
  return doChat || esc.lerConfig<{ pastaTrabalho?: string }>("runner", {}).pastaTrabalho || PASTA_PADRAO;
}

/** Onde cada execução roda: na cópia da tarefa, na cópia final (merge) ou na pasta do chat. */
export function pastaDaTarefa(esc: Escritorio, t: Tarefa): string {
  return t.pasta || pastaDoChat(esc, t.conversa_id);
}

/**
 * Se a pasta do chat for um repositório git, cada parte ganha uma cópia própria (worktree)
 * numa branch ktn/… criada a partir do commit atual.
 */
export async function prepararPartes(esc: Escritorio, projetoId: number, partes: ParteProjeto[]): Promise<{ partes: ParteProjeto[]; git: boolean }> {
  const p = esc.projeto(projetoId);
  const pasta = pastaDoChat(esc, p?.conversa_id);
  if (!(await ehRepositorio(pasta))) return { partes, git: false };
  const raiz = await raizRepositorio(pasta);
  ignorarNoGit(raiz, ".ktn-anexos/");
  const prontas: ParteProjeto[] = [];
  for (const [i, parte] of partes.entries()) {
    const wt = await criarWorktree(pasta, projetoId, parte.para, i + 1);
    const base = (await rodar("git", ["-C", wt.pasta, "rev-parse", "HEAD"], { timeoutMs: 20_000 })).stdout.trim();
    prontas.push({ ...parte, pasta: wt.pasta, branch: wt.branch, base });
  }
  return { partes: prontas, git: true };
}

/** Na entrega: o escritório faz o commit do que a IA mudou na cópia dela e anota os arquivos no resultado. */
export async function salvarEntrega(esc: Escritorio, t: Tarefa, agente: string): Promise<{ texto: string; mudou: boolean }> {
  // Revisão: salva as correções do revisor na branch de quem foi revisado.
  const branch = t.branch ?? (t.revisa ? esc.tarefa(t.revisa)?.branch : null);
  if (!t.pasta || !branch) return { texto: "", mudou: false };
  const c = await commitarParte(t.pasta, `ktn: ${t.titulo} (tarefa #${t.id}, ${agente})`);
  if (t.revisa) return { texto: c.mudou ? `\n\n---\nCorreções do revisor salvas na branch ${branch}:\n${c.resumo}` : "", mudou: c.mudou };
  return {
    texto: c.mudou ? `\n\n---\nArquivos alterados (branch ${branch}):\n${c.resumo}` : `\n\n---\nNenhum arquivo foi alterado na branch ${branch}.`,
    mudou: c.mudou,
  };
}

/** Quem revisa: outra IA da equipe, de preferência uma boa em revisão de código. */
export function escolherRevisor(autor: string, equipe: string[], especialidades: Record<string, string[]>): string | null {
  const candidatas = equipe.filter((a) => a !== autor);
  if (!candidatas.length) return null;
  const nota = (a: string) => ((especialidades[a] ?? []).some((e) => /revis|segunda opini|teste/i.test(e)) ? 0 : 1);
  return [...candidatas].sort((x, y) => nota(x) - nota(y))[0];
}

const emAndamento = new Set<number>();

/**
 * Projetos em "integrando": junta as branches das partes numa branch ktn/projN (numa cópia separada)
 * e passa para a coordenadora revisar, resolver conflitos e concluir. Pode ser chamado várias vezes.
 */
export async function processarIntegracoes(esc: Escritorio) {
  for (const p of esc.projetosEm("integrando")) {
    if (emAndamento.has(p.id)) continue;
    emAndamento.add(p.id);
    try {
      const partes = esc.partesDoProjeto(p.id).filter((t) => t.branch && !t.revisa && t.status === "entregue");
      const pasta = pastaDoChat(esc, p.conversa_id);
      if (!partes.length) {
        esc.avisarConsolidacao(p.id, "Nenhuma parte foi entregue com sucesso, então não há código para juntar.");
        continue;
      }
      const r = await integrarPartes(pasta, p.id, partes.map((t) => t.branch!));
      esc.definirIntegracao(p.id, r.pasta, r.branch);
      const linhas = [
        `As partes foram juntadas na branch ${r.branch}, numa cópia separada: ${r.pasta}`,
        `Trabalhe NESSA pasta para revisar e ajustar o resultado final (o projeto original do humano não foi alterado).`,
        r.conflitos.length
          ? `CONFLITOS para resolver (os arquivos têm marcadores <<<<<<< / >>>>>>>):\n${r.conflitos.map((c) => `- ${c.branch}: ${c.arquivos.join(", ")}`).join("\n")}\nResolva editando os arquivos e só então use concluir_projeto.`
          : `Sem conflitos.`,
        `Ao concluir, o humano decide se aplica a branch no projeto dele.`,
      ];
      esc.avisarConsolidacao(p.id, linhas.join("\n"));
    } catch (e) {
      esc.avisarConsolidacao(p.id, `Não consegui juntar as branches automaticamente: ${e instanceof Error ? e.message : e}. Junte manualmente a partir das entregas.`);
    } finally {
      emAndamento.delete(p.id);
    }
  }
}

/** Antes de concluir: salva o merge final da coordenadora e garante que não sobrou conflito. */
export async function fecharIntegracao(esc: Escritorio, projetoId: number): Promise<string> {
  const p = esc.projeto(projetoId);
  if (!p?.pasta_final) return "";
  const marcadores = await rodar("git", ["-C", p.pasta_final, "grep", "-n", "-I", "-e", "^<<<<<<< ", "-e", "^>>>>>>> "], { timeoutMs: 30_000 });
  if (marcadores.codigo === 0 && marcadores.stdout.trim()) {
    throw new Error(`Ainda há conflitos sem resolver em ${p.pasta_final}:\n${marcadores.stdout.trim().split("\n").slice(0, 10).join("\n")}`);
  }
  const c = await commitarParte(p.pasta_final, `ktn: merge final do projeto #${projetoId}`);
  return `\n\n---\nResultado na branch **${p.branch_final}**${c.mudou ? " (com os ajustes finais da coordenadora)" : ""}. Use "Aplicar no meu projeto" para trazer para a sua branch.`;
}
