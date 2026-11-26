import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pastaDados } from "./memoria.js";
import { rodar } from "./equipe/processo.js";

/**
 * Git do escritório: cada IA trabalha numa cópia própria (git worktree) do projeto,
 * numa branch "ktn/…". Assim duas IAs nunca editam o mesmo arquivo ao mesmo tempo,
 * e no final as partes são juntadas numa branch de integração.
 * O seu checkout (a branch em que você está) nunca é alterado sem você pedir.
 */

async function git(pasta: string, ...args: string[]) {
  const r = await rodar("git", ["-C", pasta, ...args], { timeoutMs: 120_000 });
  return { ok: r.codigo === 0, saida: (r.stdout + r.stderr).trim() };
}

async function gitOk(pasta: string, ...args: string[]) {
  const r = await git(pasta, ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.saida.slice(0, 400)}`);
  return r.saida;
}

export async function ehRepositorio(pasta: string | null | undefined): Promise<boolean> {
  if (!pasta || !existsSync(pasta)) return false;
  const r = await git(pasta, "rev-parse", "--is-inside-work-tree");
  return r.ok && r.saida === "true";
}

/** Raiz do repositório (mesmo que a pasta escolhida seja uma subpasta). */
export async function raizRepositorio(pasta: string) {
  return gitOk(pasta, "rev-parse", "--show-toplevel");
}

export const pastaWorktrees = () => path.join(pastaDados(), "worktrees");
export const branchParte = (projeto: number, agente: string, tarefa: number) => `ktn/proj${projeto}-${agente}-t${tarefa}`;
export const branchIntegracao = (projeto: number) => `ktn/proj${projeto}`;

/** Garante que o repositório tenha pelo menos um commit (worktree precisa de um ponto de partida). */
async function garantirCommit(raiz: string) {
  if ((await git(raiz, "rev-parse", "--verify", "HEAD")).ok) return;
  await gitOk(raiz, "-c", "user.name=KTN Office", "-c", "user.email=ktn-office@local", "commit", "--allow-empty", "-m", "ktn: commit inicial");
}

/** Ignora a pasta de anexos do escritório sem mexer no .gitignore do projeto. */
export function ignorarNoGit(raiz: string, padrao: string) {
  const exclude = path.join(raiz, ".git", "info", "exclude");
  if (!existsSync(path.dirname(exclude))) return;
  const atual = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!atual.split(/\r?\n/).includes(padrao)) appendFileSync(exclude, `${atual.endsWith("\n") || !atual ? "" : "\n"}${padrao}\n`);
}

/** Cria a cópia de trabalho de uma IA, a partir do commit atual do projeto. */
export async function criarWorktree(pastaProjeto: string, projeto: number, agente: string, tarefa: number): Promise<{ pasta: string; branch: string }> {
  const raiz = await raizRepositorio(pastaProjeto);
  await garantirCommit(raiz);
  const branch = branchParte(projeto, agente, tarefa);
  const destino = path.join(pastaWorktrees(), path.basename(raiz), `proj${projeto}-${agente}-t${tarefa}`);
  mkdirSync(path.dirname(destino), { recursive: true });
  if (!existsSync(destino)) await gitOk(raiz, "worktree", "add", "-B", branch, destino, "HEAD");
  // Se a IA trabalhava numa subpasta do repositório, ela continua na mesma subpasta dentro da cópia.
  const relativa = path.relative(raiz, pastaProjeto);
  return { pasta: relativa ? path.join(destino, relativa) : destino, branch };
}

/** Salva o que a IA fez na cópia dela (o escritório faz o commit, a IA não precisa de permissão de git). */
export async function commitarParte(pastaWorktree: string, mensagem: string): Promise<{ mudou: boolean; resumo: string }> {
  await gitOk(pastaWorktree, "add", "-A");
  const status = await gitOk(pastaWorktree, "status", "--porcelain");
  if (!status) return { mudou: false, resumo: "sem mudanças em arquivos" };
  await gitOk(pastaWorktree, "-c", "user.name=KTN Office", "-c", "user.email=ktn-office@local", "commit", "-m", mensagem);
  const resumo = await gitOk(pastaWorktree, "show", "--stat", "--format=", "HEAD");
  return { mudou: true, resumo: resumo.split("\n").slice(-12).join("\n") };
}

/** Diferença da parte em relação ao ponto de partida (para revisão). */
export async function diffParte(pastaWorktree: string, base: string) {
  return gitOk(pastaWorktree, "diff", `${base}...HEAD`);
}

export interface ResultadoIntegracao {
  pasta: string;
  branch: string;
  juntadas: string[];
  conflitos: { branch: string; arquivos: string[] }[];
}

/**
 * Junta as branches das partes numa branch de integração, numa cópia separada.
 * Conflitos ficam marcados nos arquivos para a coordenadora resolver ali mesmo.
 */
export async function integrarPartes(pastaProjeto: string, projeto: number, branches: string[]): Promise<ResultadoIntegracao> {
  const raiz = await raizRepositorio(pastaProjeto);
  const branch = branchIntegracao(projeto);
  const destino = path.join(pastaWorktrees(), path.basename(raiz), `proj${projeto}-final`);
  mkdirSync(path.dirname(destino), { recursive: true });
  if (!existsSync(destino)) await gitOk(raiz, "worktree", "add", "-B", branch, destino, "HEAD");
  const res: ResultadoIntegracao = { pasta: destino, branch, juntadas: [], conflitos: [] };
  for (const b of branches) {
    const m = await git(destino, "-c", "user.name=KTN Office", "-c", "user.email=ktn-office@local", "merge", "--no-ff", "-m", `ktn: junta ${b}`, b);
    if (m.ok) {
      res.juntadas.push(b);
      continue;
    }
    const arquivos = (await git(destino, "diff", "--name-only", "--diff-filter=U")).saida.split("\n").filter(Boolean);
    if (!arquivos.length) throw new Error(`Falhou ao juntar ${b}: ${m.saida.slice(0, 300)}`);
    // Deixa os marcadores de conflito nos arquivos e registra; a coordenadora resolve e o escritório commita depois.
    await gitOk(destino, "add", "-A");
    await gitOk(destino, "-c", "user.name=KTN Office", "-c", "user.email=ktn-office@local", "commit", "-m", `ktn: junta ${b} (com conflitos para resolver)`);
    res.conflitos.push({ branch: b, arquivos });
  }
  return res;
}

/** Aplica o resultado final no seu projeto (merge da branch de integração na branch em que você está). */
export async function aplicarNoProjeto(pastaProjeto: string, projeto: number) {
  const raiz = await raizRepositorio(pastaProjeto);
  const sujo = await gitOk(raiz, "status", "--porcelain", "--untracked-files=no");
  if (sujo) throw new Error("Seu projeto tem alterações não salvas (commit). Faça commit ou guarde (stash) antes de aplicar.");
  const branch = branchIntegracao(projeto);
  const r = await git(raiz, "-c", "user.name=KTN Office", "-c", "user.email=ktn-office@local", "merge", "--no-ff", "-m", `ktn: aplica projeto #${projeto}`, branch);
  if (!r.ok) {
    await git(raiz, "merge", "--abort");
    throw new Error(`Não deu para aplicar automaticamente (conflito com mudanças suas). Nada foi alterado. Detalhe: ${r.saida.slice(0, 300)}`);
  }
  return `Projeto #${projeto} aplicado na sua branch atual.`;
}

/** Remove as cópias de trabalho de um projeto (as branches ficam, caso você queira olhar depois). */
export async function limparWorktrees(pastaProjeto: string, pastas: string[]) {
  const raiz = await raizRepositorio(pastaProjeto);
  for (const p of pastas) await git(raiz, "worktree", "remove", "--force", p);
  await git(raiz, "worktree", "prune");
}
