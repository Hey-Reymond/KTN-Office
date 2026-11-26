import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_ANEXO, nomeSeguro, salvarAnexos, textoAnexos } from "../src/anexos.js";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-anexo-"));
try {
  assert.equal(nomeSeguro("../../etc/passwd"), "passwd");
  assert.equal(nomeSeguro("C:\\x\\a<b>.txt"), "a_b_.txt");
  assert.equal(nomeSeguro(".."), "arquivo");
  execFileSync("git", ["init", "-q", tmp]);
  const s = await salvarAnexos(tmp, [{ nome: "nota.txt", dados: "data:text/plain;base64," + Buffer.from("oi").toString("base64") }]);
  assert.equal(readFileSync(s[0].caminho, "utf8"), "oi");
  assert.ok(s[0].caminho.startsWith(path.join(tmp, ".ktn-anexos")));
  assert.match(readFileSync(path.join(tmp, ".git/info/exclude"), "utf8"), /\.ktn-anexos\//);
  assert.match(textoAnexos(s), /nota\.txt \(1 KB\)/);
  await assert.rejects(salvarAnexos(tmp, [{ nome: "x", dados: "" }]), /vazio/);
  await assert.rejects(salvarAnexos(tmp, [{ nome: "g", dados: Buffer.alloc(MAX_ANEXO + 1).toString("base64") }]), /passa de/);
  assert.ok(existsSync(path.join(tmp, ".ktn-anexos")));
  console.log("OK: anexos (nome seguro, pasta do chat, fora do git, limites).");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
}
