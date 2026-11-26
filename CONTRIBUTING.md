# Como contribuir

Obrigado por querer ajudar! O KTN Office é aberto justamente para qualquer pessoa poder usar, conferir e melhorar.

## Rodando do código

Precisa do **Node.js 22+** e do **git**.

```bash
git clone https://github.com/reireymond/KTN-Office.git
cd KTN-Office/server
npm install
npm start          # abre em http://127.0.0.1:7777/
npm test           # todos os testes (não usam suas contas: as IAs são simuladas)
```

App de desktop: `cd desktop && npm install && npm start`.

## Organização

| Pasta | O que tem |
|---|---|
| `server/src` | servidor do escritório (MCP, expediente, API da interface) |
| `server/src/equipe` | detecção, instalação e execução dos CLIs e das IAs por API |
| `server/public` | interface (um único `index.html`) |
| `agents/` | catálogos editáveis: CLIs, ferramentas, receitas, instruções da equipe |
| `desktop/` | app Electron |
| `server/test` | testes |

Para **adicionar um CLI novo**, quase sempre basta uma entrada em `agents/clis.json` (veja as existentes) e um teste em `server/test/clis-novos.ts`.

## Regras

- Rode `npm run typecheck` e `npm test` antes de abrir o PR. O GitHub roda os mesmos testes no Linux e no Windows.
- Nunca leia nem envie credenciais dos CLIs; nunca instale nada sem confirmação do usuário.
- Textos da interface em português claro, sem jargão.
- Um assunto por PR, com descrição do que muda e por quê.
