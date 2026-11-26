/**
 * Gerencia a equipe pelo terminal.
 *   npm run equipe                       detecta os CLIs
 *   npm run equipe -- instalar gemini    instala (pede confirmação)
 *   npm run equipe -- conectar antigravity   liga ao escritório e libera as ferramentas do office
 *   npm run equipe -- caminho claude "C:\tools\claude.cmd"
 *   npm run equipe -- adicionar          cadastra um CLI novo (perguntas)
 *   npm run equipe -- modelos            lista modelos (✅ ligados / ⬜ desligados)
 *   npm run equipe -- modelo claude fable on   liga um modelo opcional do seu plano
 */
import { createInterface } from "node:readline/promises";
import { acharNoPath, detectarEquipe, detectarUm, localizar, type Deteccao } from "./detectar.js";
import { conectarAoOffice, executarInstalacao, liberarFerramentasOffice, planejarInstalacao } from "./instalar.js";
import { carregarRegistro, definirModelo, modeloDisponivel, salvarCustom, type ConexaoOffice } from "./registro.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const perguntar = async (q: string, padrao = "") => (await rl.question(padrao ? `${q} [${padrao}]: ` : `${q}: `)).trim() || padrao;
const confirmar = async (q: string) => /^s(im)?$/i.test(await perguntar(`${q} (s/N)`));

function linha(d: Deteccao) {
  const inst = d.instalado ? `✅ ${d.versao ?? "instalado"}` : "❌ não instalado";
  const login = { provavel: "✅ logado", nao: "⚠️ sem login", desconhecido: "❔ login" }[d.login];
  const office = { conectado: "✅ no escritório", nao: "⚠️ conectar", manual: "🔧 manual", desconhecido: "❔ escritório" }[d.office];
  return `${d.nome.padEnd(16)} ${inst.padEnd(34)} ${d.instalado ? `${login.padEnd(14)} ${office}` : ""}`;
}

function pegarConfig(id: string) {
  const cfg = carregarRegistro()[id];
  if (!cfg) throw new Error(`CLI "${id}" não está no registro. Use 'adicionar'.`);
  return cfg;
}

async function mostrarEquipe() {
  console.log("Detectando CLIs...\n");
  const equipe = await detectarEquipe();
  equipe.forEach((d) => console.log(linha(d)));
  for (const d of equipe) {
    if (!d.instalado) {
      console.log(`\n→ ${d.nome} faltando: ${d.podeInstalar ? `npm run equipe -- instalar ${d.id}` : ""}` +
        `${d.podeInstalar ? " | " : ""}ou já tem? npm run equipe -- caminho ${d.id} <caminho>`);
    } else if (d.login === "nao") console.log(`\n→ ${d.nome}: ${d.dicaLogin ?? "faça o login no CLI."}`);
    else if (d.office === "nao") console.log(`\n→ ${d.nome}: npm run equipe -- conectar ${d.id}`);
    d.problemas.forEach((p) => console.log(`   ⚠️ ${d.nome}: ${p}`));
  }
}

async function instalar(id: string) {
  const cfg = pegarConfig(id);
  const plano = planejarInstalacao(cfg);
  if (!plano.possivel) return console.log(plano.descricao);
  console.log(`Vou rodar: ${plano.descricao}`);
  if (!(await confirmar("Confirmar instalação?"))) return console.log("Cancelado.");
  await executarInstalacao(plano, (t) => process.stdout.write(t));
  console.log(`\n✅ ${cfg.nome} instalado.`);
  if (plano.depois) console.log(`Próximo passo (com você): ${plano.depois}`);
  if (await confirmar("Já conectar ao escritório?")) await conectar(id);
}

async function conectar(id: string) {
  const cfg = pegarConfig(id);
  const caminho = localizar(cfg);
  if (!caminho) return console.log(`${cfg.nome} não está instalado.`);
  console.log(await conectarAoOffice(id, cfg, caminho));
  if (process.argv.includes("--sem-liberar")) return;
  const liberado = liberarFerramentasOffice(cfg);
  if (liberado) console.log(`${liberado}\n(Use --sem-liberar se preferir aprovar cada ferramenta na mão.)`);
}

async function definirCaminho(id: string, caminho: string) {
  if (!acharNoPath(caminho)) throw new Error(`Não achei um executável em ${caminho}`);
  salvarCustom(id, { executavel: caminho });
  const d = await detectarUm(id, pegarConfig(id));
  console.log(linha(d));
}

async function adicionar() {
  console.log("Cadastro de CLI novo. Use {prompt} e {modelo} onde o texto/modelo entram.\n");
  const id = (await perguntar("id curto (ex.: meucli)")).toLowerCase();
  const nome = await perguntar("Nome pra exibir", id);
  const executavel = await perguntar("Comando ou caminho do executável", id);
  const prompt = (await perguntar("Argumentos pra rodar um prompt", "-p {prompt}")).split(" ");
  const modeloTxt = await perguntar("Argumentos pra escolher modelo (vazio = nenhum)", "");
  const modeloPadrao = await perguntar("Modelo padrão (vazio = do próprio CLI)", "");
  const especialidades = (await perguntar("Especialidades, separadas por vírgula", ""))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const conexaoOffice = (await perguntar("Conexão ao escritório (claude-mcp, codex-mcp, antigravity-mcp, gemini-settings, manual)", "manual")) as ConexaoOffice;

  salvarCustom(id, {
    nome, executavel, prompt, especialidades, conexaoOffice,
    ...(modeloTxt ? { modelo: modeloTxt.split(" ") } : {}),
    ...(modeloPadrao ? { modeloPadrao } : {}),
  });
  console.log(`\nSalvo em agents/clis.custom.json.`);
  console.log(linha(await detectarUm(id, pegarConfig(id))));
}

function listarModelos() {
  for (const [id, cfg] of Object.entries(carregarRegistro())) {
    if (cfg.ativo === false || !cfg.modelos) continue;
    console.log(`\n${cfg.nome} (padrão: ${cfg.modeloPadrao ?? "do CLI"})`);
    for (const [apelido, m] of Object.entries(cfg.modelos)) {
      const on = modeloDisponivel(cfg, apelido) ? "✅" : "⬜";
      console.log(`  ${on} ${apelido.padEnd(9)} ${(m.nivel ?? "").padEnd(11)} ${m.quando ?? ""}${m.requer && !modeloDisponivel(cfg, apelido) ? `  [requer: ${m.requer}]` : ""}`);
    }
  }
  console.log("\nLigar/desligar: npm run equipe -- modelo <cli> <modelo> on|off");
}

const [comando, ...args] = process.argv.slice(2);
try {
  if (!comando || comando === "detectar") await mostrarEquipe();
  else if (comando === "instalar" && args[0]) await instalar(args[0]);
  else if (comando === "conectar" && args[0]) await conectar(args[0]);
  else if (comando === "caminho" && args[0] && args[1]) await definirCaminho(args[0], args[1]);
  else if (comando === "adicionar") await adicionar();
  else if (comando === "modelos") listarModelos();
  else if (comando === "modelo" && args[0] && args[1] && /^(on|off)$/.test(args[2] ?? "")) {
    definirModelo(args[0], args[1], args[2] === "on");
    listarModelos();
  }
  else console.log("Uso: npm run equipe -- [detectar | instalar <id> | conectar <id> | caminho <id> <caminho> | adicionar | modelos | modelo <id> <modelo> on|off]");
} catch (e) {
  console.error(`❌ ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
