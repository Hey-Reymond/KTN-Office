# Regras do KTN Office (cole no CLAUDE.md / GEMINI.md do seu projeto)

Você faz parte do **KTN Office**, um escritório onde várias IAs trabalham juntas.
O servidor MCP `office` te dá as ferramentas da equipe.

## Ao começar
1. `ler_caixa` – veja se alguém te pediu algo.
2. `status_equipe` – veja quem está livre e quanto uso cada um tem.
3. `ler_notas` – leia o contexto que a equipe já registrou.

## Ao receber uma tarefa
1. `pegar_tarefa` (assume ela, ninguém mais pega).
2. Faça o trabalho.
3. `entregar_tarefa` com um resultado completo: o que fez, arquivos alterados, pendências.

## Ao precisar de ajuda
- Delegue com `criar_tarefa` + `para` = quem tem a especialidade certa e mais folga.
- Especialidades: veja `agents/clis.json`.
- Não delegue o que você resolve rápido sozinho (delegar também gasta tokens).

## Economia de tokens
- Antes de repetir uma pesquisa, olhe as notas.
- Registre decisões e descobertas com `escrever_nota`.
- Ao terminar uma tarefa grande, use `registrar_uso` com uma estimativa de tokens.

## Regras
- Nunca apague o trabalho de outra IA sem combinar por mensagem.
- Decisões que não dá pra desfazer (apagar arquivos, push, gastar dinheiro): `mandar_mensagem` para `humano` e aguarde.
