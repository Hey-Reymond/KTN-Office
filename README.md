# KTN Office

Um escritório onde IAs (Claude, Gemini, Codex…) trabalham juntas: dividem tarefas,
trocam mensagens, compartilham notas e enxergam o uso de cada uma pra economizar tokens.

Feito pela **KTN Dev**.

## Status

**Fase 1 – servidor MCP "Escritório"** ✅
As IAs se conectam ao mesmo servidor e ganham ferramentas da equipe.
Nesta fase você ainda "cutuca" cada IA manualmente; o runner automático vem na fase 2.

## Ferramentas que cada IA ganha

| Ferramenta | Pra quê |
|---|---|
| `criar_tarefa` | Cria/delega uma tarefa (`para: "gemini"`) |
| `listar_tarefas` | Vê o quadro |
| `pegar_tarefa` | Assume uma tarefa (atômico, ninguém pega duas vezes) |
| `entregar_tarefa` | Entrega o resultado pra quem pediu |
| `mandar_mensagem` / `ler_caixa` | Conversa direta entre IAs (ou com `humano`) |
| `status_equipe` | Quem está livre/ocupado e uso estimado de tokens |
| `registrar_uso` | Informa tokens gastos e limite do plano |
| `escrever_nota` / `ler_notas` | Memória compartilhada da equipe |
| `quem_sou_eu` | Confere o nome registrado |

## Como rodar

Requisitos: Node.js 20+.

```bash
cd server
npm install
npm start
```

Servidor: `http://127.0.0.1:7777/mcp?agent=<nome>`
Painel rápido (JSON): `http://127.0.0.1:7777/status`

Variáveis opcionais: `KTN_PORT` (porta) e `KTN_DB` (arquivo do banco, padrão `office.db`).

## Conectar as IAs

**Claude Code**
```bash
claude mcp add --transport http office "http://127.0.0.1:7777/mcp?agent=claude"
```

**Gemini CLI** — em `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "office": { "httpUrl": "http://127.0.0.1:7777/mcp?agent=gemini" }
  }
}
```

Depois, cole o conteúdo de `agents/INSTRUCOES-EQUIPE.md` no `CLAUDE.md` e no `GEMINI.md`
da pasta onde vão trabalhar.

## Primeiro teste

1. No Claude: *"crie uma tarefa pro gemini: pesquisar como o Gemini CLI mostra o uso de tokens"*
2. No Gemini: *"leia sua caixa e execute as tarefas pendentes"*
3. No Claude: *"leia sua caixa"* → recebe a entrega.
4. Abra `http://127.0.0.1:7777/status` pra ver o quadro.

## Testes

```bash
cd server
npm test        # simula claude e gemini trocando tarefa via MCP
npm run typecheck
```

## Roadmap

- [x] **Fase 1** – servidor MCP com tarefas, mensagens, uso e notas
- [ ] **Fase 2** – runner que acorda sozinho quem tem tarefa (`claude -p`, `gemini -p`) + gerente que distribui
- [ ] **Fase 3** – medição automática de uso (ex.: `claude -p --output-format json`) e economia
- [ ] **Fase 4** – app desktop: chat com o gerente, painel do escritório, conversa da equipe

## Estrutura

```
server/src/index.ts   servidor HTTP MCP (127.0.0.1)
server/src/tools.ts   ferramentas expostas às IAs
server/src/db.ts      regras do escritório + SQLite
server/test/smoke.ts  teste ponta a ponta
agents/               perfis e regras da equipe
```

## 📄 Licença

© 2026 Kaua Teixeira Nascimento / KTN Dev. **Todos os direitos reservados.**
O código está público apenas para visualização. Veja o arquivo [`LICENSE`](LICENSE).
