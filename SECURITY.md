# Segurança

## O que o KTN Office faz no seu computador

- O servidor escuta **só em 127.0.0.1** (não aparece na rede) e bloqueia pedidos de outros sites (proteção contra DNS rebinding e cabeçalho obrigatório na API).
- **Não lê** arquivos de login dos CLIs. Só confere se a pasta de configuração existe.
- **Não instala nada sem você confirmar.**
- Chaves de API ficam em `~/KTN-Office-dados/chaves-api.json`, fora da pasta do projeto, e só são enviadas ao provedor que você escolheu.
- Cada IA trabalha com o nível de permissão que você define (só ler / editar / rodar comandos). O que passar disso vira um pedido para você aprovar.
- O controle da tela vem desligado e pede permissão a cada ação.
- Os instaladores da página de Releases são compilados pelo GitHub Actions a partir do código público (dá para conferir na aba Actions e com o `SHA256SUMS.txt`).

## Achou uma falha?

Não abra uma issue pública. Use **Security → Report a vulnerability** no GitHub (aviso privado).
Responderemos assim que possível.
