import spawn from "cross-spawn";

export interface SaidaProcesso {
  codigo: number | null;
  stdout: string;
  stderr: string;
  estourouTempo: boolean;
}

/**
 * Roda um programa sem shell (seguro contra injeção). cross-spawn cuida dos
 * executáveis .cmd do Windows (npm instala os CLIs assim).
 */
export function rodar(
  comando: string,
  args: string[],
  opcoes: { timeoutMs?: number; cwd?: string; aoReceber?: (trecho: string) => void; entrada?: string } = {},
): Promise<SaidaProcesso> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let estourouTempo = false;
    let filho;
    try {
      filho = spawn(comando, args, { cwd: opcoes.cwd, stdio: [opcoes.entrada === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ codigo: null, stdout: "", stderr: String(e), estourouTempo: false });
      return;
    }
    if (opcoes.entrada !== undefined) filho.stdin?.end(opcoes.entrada);
    const timer = opcoes.timeoutMs
      ? setTimeout(() => {
          estourouTempo = true;
          filho.kill();
        }, opcoes.timeoutMs)
      : undefined;
    filho.stdout?.on("data", (d: Buffer) => {
      stdout += d;
      opcoes.aoReceber?.(String(d));
    });
    filho.stderr?.on("data", (d: Buffer) => {
      stderr += d;
      opcoes.aoReceber?.(String(d));
    });
    filho.on("error", (e: Error) => {
      stderr += e.message;
    });
    filho.on("close", (codigo: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ codigo, stdout, stderr, estourouTempo });
    });
  });
}
