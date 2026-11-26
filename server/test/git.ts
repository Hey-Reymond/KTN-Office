/**
 * Testa o fluxo de projeto com git: cada IA numa cópia própria (worktree), commit na entrega,
 * junção das branches, conflito resolvido pela coordenadora e aplicação no projeto do humano.
 * Rode com: npm test
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-git-"));
process.env.KTN_DADOS = path.join(tmp, "dados");
const repo = path.join(tmp, "meu-projeto");
const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo]);
g("config", "user.email", "eu@x"); g("config", "user.name", "Eu");
writeFileSync(path.join(repo, "a.txt"), "linha 1\nlinha 2\n");
g("add", "-A"); g("commit", "-qm", "inicial");

const { abrirBanco, Escritorio } = await import("../src/db.js");
const { prepararPartes, salvarEntrega, processarIntegracoes, fecharIntegracao, pastaDaTarefa } = await import("../src/integracao.js");
const { aplicarNoProjeto, limparWorktrees } = await import("../src/git.js");
const esc = new Escritorio(abrirBanco(path.join(tmp, "o.db")));

async function rodarProjeto(edicoes: Record<string, (pasta: string) => void>) {
  const chat = esc.criarConversa("Projeto git");
  esc.definirPastaConversa(chat.id, repo);
  const p = esc.criarProjeto("claude", "Feature", "", chat.id);
  const { partes, git } = await prepararPartes(esc, p.id, Object.keys(edicoes).map((para) => ({ para, titulo: `parte de ${para}`, descricao: "" })));
  assert.equal(git, true);
  const tarefas = esc.distribuirProjeto("claude", p.id, partes, Object.keys(edicoes));
  for (const t of tarefas) {
    assert.ok(t.pasta && t.pasta !== repo && t.branch, "cada parte tem a sua cópia e branch");
    assert.equal(pastaDaTarefa(esc, t), t.pasta, "a IA roda dentro da cópia dela");
    esc.pegarTarefa(t.para!, t.id);
    edicoes[t.para!](t.pasta!);
    const extra = await salvarEntrega(esc.tarefa(t.id)!, t.para!);
    esc.entregarTarefa(t.para!, t.id, "feito" + extra);
  }
  assert.equal(esc.projeto(p.id)!.status, "integrando");
  await processarIntegracoes(esc);
  return esc.projeto(p.id)!;
}

try {
  // 1. Sem conflito: cada IA mexe num arquivo diferente
  const p1 = await rodarProjeto({
    claude: (d) => writeFileSync(path.join(d, "b.txt"), "novo do claude\n"),
    antigravity: (d) => writeFileSync(path.join(d, "a.txt"), "linha 1\nlinha 2\nlinha 3 do agy\n"),
  });
  assert.equal(p1.status, "consolidando");
  assert.equal(p1.branch_final, "ktn/proj1");
  assert.equal(readFileSync(path.join(p1.pasta_final!, "b.txt"), "utf8"), "novo do claude\n");
  assert.match(readFileSync(path.join(p1.pasta_final!, "a.txt"), "utf8"), /linha 3 do agy/);
  assert.ok(!existsSync(path.join(repo, "b.txt")), "o projeto do humano não muda sozinho");
  assert.match(esc.partesDoProjeto(p1.id)[0].resultado!, /Arquivos alterados \(branch ktn\/proj1-claude-t1\)/);
  const aviso = esc.lerCaixa("claude").find((m) => m.texto.includes("Projeto #1"))!;
  assert.match(aviso.texto, /Sem conflitos/);
  assert.match(aviso.texto, /ktn\/proj1/);

  const rodape = await fecharIntegracao(esc, p1.id);
  assert.match(rodape, /Aplicar no meu projeto/);
  esc.concluirProjeto("claude", p1.id, "pronto" + rodape);
  assert.equal(await aplicarNoProjeto(repo, p1.id), "Projeto #1 aplicado na sua branch atual.");
  assert.equal(readFileSync(path.join(repo, "b.txt"), "utf8"), "novo do claude\n", "aplicado no projeto do humano");

  // 2. Com conflito: as duas IAs mudam a mesma linha
  const p2 = await rodarProjeto({
    claude: (d) => writeFileSync(path.join(d, "a.txt"), "linha 1 (claude)\nlinha 2\nlinha 3 do agy\n"),
    antigravity: (d) => writeFileSync(path.join(d, "a.txt"), "linha 1 (agy)\nlinha 2\nlinha 3 do agy\n"),
  });
  const avisoConflito = esc.lerCaixa("claude").find((m) => m.texto.includes(`Projeto #${p2.id}`))!;
  assert.match(avisoConflito.texto, /CONFLITOS para resolver/);
  assert.match(avisoConflito.texto, /a\.txt/);
  await assert.rejects(fecharIntegracao(esc, p2.id), /conflitos sem resolver/, "não conclui com conflito pendente");
  writeFileSync(path.join(p2.pasta_final!, "a.txt"), "linha 1 (claude e agy)\nlinha 2\nlinha 3 do agy\n"); // coordenadora resolve
  await fecharIntegracao(esc, p2.id);
  esc.concluirProjeto("claude", p2.id, "resolvido");
  await aplicarNoProjeto(repo, p2.id);
  assert.match(readFileSync(path.join(repo, "a.txt"), "utf8"), /claude e agy/);

  // 3. Aplicar recusa se o humano tem alterações não salvas
  writeFileSync(path.join(repo, "a.txt"), "mexi aqui\n");
  await assert.rejects(aplicarNoProjeto(repo, p2.id), /alterações não salvas/);
  g("checkout", "--", "a.txt");

  // 4. Limpar cópias
  const pastas = [...esc.partesDoProjeto(p1.id).map((t) => t.pasta!), p1.pasta_final!];
  await limparWorktrees(repo, pastas);
  assert.ok(pastas.every((p) => !existsSync(p)));
  assert.ok(g("branch", "--list", "ktn/proj1").includes("ktn/proj1"), "branch continua");

  console.log("OK: git (cópia por IA, commit na entrega, junção, conflito, aplicar e limpar).");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
