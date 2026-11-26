/** GitHub pelo gh: só repositórios liberados, leitura, clonar e ações — com um gh falso. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-gh-"));
const bin = path.join(tmp, "bin");
mkdirSync(bin);
const registro = path.join(tmp, "chamadas.jsonl");
writeFileSync(path.join(bin, "gh.mjs"), `
import { appendFileSync, mkdirSync } from "node:fs";
const a = process.argv.slice(2);
let entrada = ""; try { entrada = (await import("node:fs")).readFileSync(0, "utf8"); } catch {}
appendFileSync(${JSON.stringify(registro)}, JSON.stringify({ a, entrada }) + "\\n");
const j = (x) => console.log(JSON.stringify(x));
if (a[0] === "api" && a[1] === "user") console.log("reymond");
else if (a[0] === "repo" && a[1] === "list") j([{ nameWithOwner: "reireymond/KTN-Office", description: "app", isPrivate: false }, { nameWithOwner: "reireymond/secreto", description: "", isPrivate: true }]);
else if (a[0] === "api" && a.includes("repos/reireymond/KTN-Office/contents/README.md")) j({ type: "file", encoding: "base64", path: "README.md", size: 5, content: Buffer.from("Olá!").toString("base64") });
else if (a[0] === "api") j({ url: a[3] });
else if (a[0] === "repo" && a[1] === "clone") mkdirSync(a[3] + "/.git", { recursive: true });
else if (a[0] === "issue" && a[1] === "create") console.log("https://github.com/reireymond/KTN-Office/issues/9");
else { console.error("comando inesperado"); process.exit(1); }
`);
writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nexec node "${path.join(bin, "gh.mjs")}" "$@"\n`);
chmodSync(path.join(bin, "gh"), 0o755);
writeFileSync(path.join(bin, "gh.cmd"), `@node "%~dp0gh.mjs" %*\r\n`);
process.env.PATH = bin + path.delimiter + process.env.PATH;
process.env.KTN_DADOS = path.join(tmp, "dados");

const { abrirBanco, Escritorio } = await import("../src/db.js");
const gh = await import("../src/github.js");
const esc = new Escritorio(abrirBanco(path.join(tmp, "o.db")));
try {
  assert.deepEqual(await gh.statusGithub(), { disponivel: true, usuario: "reymond" });
  await assert.rejects(gh.lerGithub(esc, "reireymond/KTN-Office", "issues"), /desligado/);
  esc.gravarConfig("github", { ligado: true, repos: ["reireymond/KTN-Office"] });
  await assert.rejects(gh.lerGithub(esc, "reireymond/secreto", ""), /não foi liberado/);
  await assert.rejects(gh.lerGithub(esc, "nada", ""), /inválido/);
  await assert.rejects(gh.lerGithub(esc, "reireymond/KTN-Office", "../../user"), /Caminho inválido/);
  assert.match(await gh.lerGithub(esc, "https://github.com/reireymond/KTN-Office.git", "issues?state=open"), /repos\/reireymond\/KTN-Office\/issues\?state=open/);
  assert.equal(await gh.lerGithub(esc, "reireymond/KTN-Office", "contents/README.md"), "README.md (5 bytes):\n\nOlá!", "arquivo vem como texto");
  const pasta = await gh.clonarGithub(esc, "reireymond/KTN-Office", path.join(tmp, "trabalho"));
  assert.equal(pasta, path.join(tmp, "trabalho", "KTN-Office"));
  assert.equal(await gh.executarAcao("reireymond/KTN-Office", { tipo: "criar_issue", titulo: "Bug", corpo: "texto com `crase` e $(nada)" }), "https://github.com/reireymond/KTN-Office/issues/9");
  const ultima = readFileSync(registro, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.equal(ultima.entrada, "texto com `crase` e $(nada)", "corpo vai pela entrada padrão, sem shell");
  // todos: libera repos da própria conta, não de outros
  esc.gravarConfig("github", { ligado: true, todos: true, repos: [] });
  assert.equal(await gh.conferirRepo(esc, "reireymond/secreto"), "reireymond/secreto");
  await assert.rejects(gh.conferirRepo(esc, "outro/repo"), /não é um repositório da conta/);
  console.log("OK: GitHub (gh logado, só repositórios liberados, leitura, clonar, ações sem shell).");
} finally {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10 }); } catch { /* Windows: banco aberto */ }
}
