/**
 * GitHub para TODAS as IAs (CLIs e APIs), pelo escritório.
 * Usa o GitHub CLI (gh) já logado no PC: o token nunca sai do gh nem vai para as IAs.
 * Só os repositórios que o humano liberar; ações que mudam algo no GitHub pedem permissão.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Escritorio } from "./db.js";
import { acharNoPath } from "./equipe/detectar.js";
import { rodar } from "./equipe/processo.js";

export interface ConfigGithub {
  ligado?: boolean;
  /** "dono/repo" liberados. */
  repos?: string[];
  /** Libera todos os repositórios da conta (só leitura sem perguntar; ações sempre perguntam). */
  todos?: boolean;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const LIMITE = 60_000;

/** Pastas extras onde o instalador rápido coloca o gh (antes do PATH atualizar). */
export const CAMINHOS_GH = [
  "~/.local/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/AppData/Local/ktn-office/bin",
  "~/AppData/Local/Programs/GitHub CLI",
  "C:\\Program Files\\GitHub CLI",
];

/** Procura o executável do GitHub CLI (gh) no PATH e nas pastas padrão de instalação. */
export const localizarGh = () => acharNoPath("gh", CAMINHOS_GH);

export const lerConfigGithub = (esc: Escritorio) => esc.lerConfig<ConfigGithub>("github", {});

async function gh(args: string[], opcoes: { cwd?: string; entrada?: string } = {}) {
  const r = await rodar(localizarGh() ?? "gh", args, { cwd: opcoes.cwd, timeoutMs: 120_000, entrada: opcoes.entrada });
  if (r.codigo !== 0) {
    const msg = (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ");
    throw new Error(r.codigo === null || /ENOENT|não é reconhecido|is not recognized/i.test(msg) ? "O GitHub CLI (gh) não foi encontrado. Instale pelo botão abaixo ou em cli.github.com e rode 'gh auth login'." : msg || `gh saiu com código ${r.codigo}`);
  }
  return r.stdout;
}

/** gh instalado e logado? (não lê o token: só pergunta ao gh quem está logado) */
export async function statusGithub(): Promise<{ disponivel: boolean; usuario?: string; erro?: string }> {
  try {
    const login = (await gh(["api", "user", "--jq", ".login"])).trim();
    return { disponivel: true, usuario: login };
  } catch (e) {
    return { disponivel: false, erro: e instanceof Error ? e.message : String(e) };
  }
}

export async function reposDaConta(): Promise<{ nome: string; descricao: string; privado: boolean }[]> {
  const j = JSON.parse(await gh(["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate"]));
  return j.map((r: any) => ({ nome: r.nameWithOwner, descricao: r.description ?? "", privado: !!r.isPrivate }));
}

/** Confere se o GitHub está ligado e se o repositório foi liberado pelo humano. */
export async function conferirRepo(esc: Escritorio, repo: string): Promise<string> {
  const cfg = lerConfigGithub(esc);
  if (!cfg.ligado) throw new Error("O acesso ao GitHub está desligado. O humano liga em Configurações → Ferramentas → GitHub.");
  const r = String(repo ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "");
  if (!REPO.test(r)) throw new Error(`Repositório inválido: "${repo}". Use dono/nome.`);
  const liberado = (cfg.repos ?? []).some((x) => x.toLowerCase() === r.toLowerCase());
  if (!liberado && !cfg.todos) throw new Error(`O repositório ${r} não foi liberado. Liberados: ${(cfg.repos ?? []).join(", ") || "nenhum"}. Peça ao humano para liberar.`);
  if (!liberado && cfg.todos) {
    const meus = (await reposDaConta()).map((x) => x.nome.toLowerCase());
    if (!meus.includes(r.toLowerCase())) throw new Error(`${r} não é um repositório da conta do humano.`);
  }
  return r;
}

/** Leitura (GET) na API do GitHub dentro de um repositório liberado. Ex.: "issues?state=open", "pulls/3/files", "contents/README.md". */
export async function lerGithub(esc: Escritorio, repo: string, caminho: string): Promise<string> {
  const r = await conferirRepo(esc, repo);
  const c = String(caminho ?? "").trim().replace(/^\/+/, "");
  if (c.includes("..") || /^https?:/i.test(c)) throw new Error("Caminho inválido.");
  const url = c ? `repos/${r}/${c}` : `repos/${r}`;
  let saida = await gh(["api", "-X", "GET", url, "-H", "Accept: application/vnd.github+json"]);
  // Arquivo: devolve o texto em vez do base64.
  try {
    const j = JSON.parse(saida);
    if (j && j.type === "file" && j.encoding === "base64" && typeof j.content === "string") {
      saida = `${j.path} (${j.size} bytes):\n\n${Buffer.from(j.content, "base64").toString("utf8")}`;
    }
  } catch { /* não é JSON */ }
  return saida.length > LIMITE ? saida.slice(0, LIMITE) + `\n…(cortado, ${saida.length} caracteres; peça páginas menores com ?per_page=)` : saida;
}

/** Clona o repositório na pasta de trabalho do chat (ou atualiza, se já existir). */
export async function clonarGithub(esc: Escritorio, repo: string, pastaBase: string): Promise<string> {
  const r = await conferirRepo(esc, repo);
  const destino = path.join(pastaBase, r.split("/")[1]);
  mkdirSync(pastaBase, { recursive: true });
  if (existsSync(path.join(destino, ".git"))) {
    await rodar("git", ["-C", destino, "pull", "--ff-only"], { timeoutMs: 120_000 });
    return destino;
  }
  if (existsSync(destino)) throw new Error(`Já existe uma pasta ${destino} que não é esse repositório.`);
  await gh(["repo", "clone", r, destino]);
  return destino;
}

export type AcaoGithub =
  | { tipo: "criar_issue"; titulo: string; corpo?: string }
  | { tipo: "comentar"; numero: number; corpo: string }
  | { tipo: "criar_pr"; pasta: string; titulo: string; corpo?: string; base?: string };

export function descreverAcao(repo: string, a: AcaoGithub): string {
  if (a.tipo === "criar_issue") return `Criar issue em ${repo}: "${a.titulo}"`;
  if (a.tipo === "comentar") return `Comentar na issue/PR #${a.numero} de ${repo}: ${a.corpo.slice(0, 200)}`;
  return `Enviar a branch da pasta ${a.pasta} para ${repo} e abrir PR "${a.titulo}"${a.base ? ` (para ${a.base})` : ""}`;
}

/** Executa uma ação que muda algo no GitHub (chamar só depois da permissão do humano). */
export async function executarAcao(repo: string, a: AcaoGithub): Promise<string> {
  if (a.tipo === "criar_issue") {
    return (await gh(["issue", "create", "--repo", repo, "--title", a.titulo, "--body-file", "-"], { entrada: a.corpo ?? "" })).trim();
  }
  if (a.tipo === "comentar") {
    return (await gh(["issue", "comment", String(a.numero), "--repo", repo, "--body-file", "-"], { entrada: a.corpo })).trim() || "Comentado.";
  }
  // PR: envia a branch atual da pasta (ex.: a cópia final de um projeto, ktn/projN) e abre o PR.
  if (!existsSync(path.join(a.pasta, ".git")) && !existsSync(a.pasta)) throw new Error(`Pasta não existe: ${a.pasta}`);
  const branch = (await rodar("git", ["-C", a.pasta, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 20_000 })).stdout.trim();
  if (!branch || branch === "HEAD") throw new Error("A pasta não está numa branch.");
  const remoto = (await rodar("git", ["-C", a.pasta, "remote", "get-url", "origin"], { timeoutMs: 20_000 })).stdout.trim();
  if (!remoto.toLowerCase().replace(/\.git$/, "").endsWith(repo.toLowerCase())) throw new Error(`A pasta não é um clone de ${repo} (origin: ${remoto || "nenhum"}).`);
  const push = await rodar("git", ["-C", a.pasta, "push", "-u", "origin", branch], { timeoutMs: 180_000 });
  if (push.codigo !== 0) throw new Error(`Não consegui enviar a branch: ${(push.stderr || push.stdout).trim().slice(-300)}`);
  const args = ["pr", "create", "--repo", repo, "--head", branch, "--title", a.titulo, "--body-file", "-"];
  if (a.base) args.push("--base", a.base);
  return (await gh(args, { cwd: a.pasta, entrada: a.corpo ?? "" })).trim();
}
