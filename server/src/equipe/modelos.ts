import { localizar } from "./detectar.js";
import { CliAgent, type Funcionario } from "./funcionario.js";
import { carregarRegistro, estadoModelo, salvarDeteccaoModelo, type ConfigCli } from "./registro.js";

export interface ProgressoTeste {
  rodando: boolean;
  atual?: string;
  feitos: number;
  total: number;
  resultados: { cli: string; modelo: string; ok: boolean; motivo?: string }[];
}

type Fabrica = (id: string, cfg: ConfigCli) => Funcionario;

/**
 * Testa cada modelo com um prompt mínimo ("responda ok"). O que responder fica ligado;
 * o que falhar é marcado como indisponível no seu plano. Gasta pouquíssimos tokens.
 */
export async function testarModelos(
  opcoes: { cli?: string; aoProgredir?: (p: ProgressoTeste) => void; fabrica?: Fabrica } = {},
): Promise<ProgressoTeste> {
  const fabrica = opcoes.fabrica ?? ((id, cfg) => new CliAgent(id, cfg));
  const fila: [string, ConfigCli, string][] = [];
  for (const [id, cfg] of Object.entries(carregarRegistro())) {
    if (cfg.ativo === false || (opcoes.cli && opcoes.cli !== id) || !cfg.modelos || !localizar(cfg)) continue;
    for (const apelido of Object.keys(cfg.modelos)) fila.push([id, cfg, apelido]);
  }
  const p: ProgressoTeste = { rodando: true, feitos: 0, total: fila.length, resultados: [] };
  opcoes.aoProgredir?.(p);
  for (const [id, cfg, apelido] of fila) {
    p.atual = `${id}/${apelido}`;
    opcoes.aoProgredir?.(p);
    const r = await fabrica(id, cfg).trabalhar("Responda apenas com a palavra: ok", { modelo: apelido, timeoutMs: 120_000 });
    const motivo = r.ok ? undefined : (r.erro ?? "sem resposta").split("\n")[0].slice(0, 200);
    salvarDeteccaoModelo(id, apelido, r.ok ? true : motivo!);
    p.resultados.push({ cli: id, modelo: apelido, ok: r.ok, motivo });
    p.feitos++;
    opcoes.aoProgredir?.(p);
  }
  p.rodando = false;
  p.atual = undefined;
  opcoes.aoProgredir?.(p);
  return p;
}

/** Catálogo com o estado de cada modelo, pra interface mostrar as caixinhas. */
export function catalogoComEstado() {
  return Object.entries(carregarRegistro())
    .filter(([, c]) => c.ativo !== false && c.modelos)
    .map(([id, c]) => ({
      cli: id,
      nome: c.nome,
      padrao: c.modeloPadrao ?? null,
      modelos: Object.entries(c.modelos!).map(([apelido, m]) => ({
        apelido,
        ...m,
        estado: estadoModelo(c, apelido),
        teste: c.modelosDetectados?.[apelido] ?? null,
      })),
    }));
}
