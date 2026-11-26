import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-rc-"));
process.env.KTN_DADOS = tmp;
const { apagarReceita, listarReceitas, salvarReceita } = await import("../src/receitas.js");
try {
  const prontas = listarReceitas();
  assert.ok(prontas.length >= 6 && prontas.every((r) => r.texto.includes("«") && !r.propria));
  const r = salvarReceita({ nome: "Revisão de PR à noite", texto: "Revise «link»" });
  assert.equal(r.id, "revisao-de-pr-a-noite");
  assert.ok(listarReceitas().find((x) => x.id === r.id)?.propria);
  salvarReceita({ id: "estudar", nome: "Estudar (minha)", texto: "outro texto" });
  assert.equal(listarReceitas().find((x) => x.id === "estudar")!.texto, "outro texto", "a sua substitui a pronta");
  assert.throws(() => apagarReceita("revisar-codigo"), /Só dá para apagar/);
  apagarReceita("estudar");
  assert.notEqual(listarReceitas().find((x) => x.id === "estudar")!.texto, "outro texto", "volta a pronta");
  assert.throws(() => salvarReceita({ nome: "", texto: "x" }), /nome/);
  console.log("OK: receitas (prontas, suas, substituir, apagar).");
} finally {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10 }); } catch { /* Windows: o banco aberto neste processo fica travado; a pasta temporária pode ficar */ }
}
