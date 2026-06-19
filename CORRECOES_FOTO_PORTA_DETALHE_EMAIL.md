# LinkHub — Correções: Foto na Home, Crash de Porta, Detalhe da Solicitação, Texto dos Emails

> Ler `ESTADO_DO_PROJETO.md` primeiro se ainda não tiver lido nesta sessão.
> Este documento cobre 4 correções independentes. Aplicar todas, mas cada uma pode ser testada separadamente.

---

## Correção 1 — Foto não aparece nos cards da home

**Diagnóstico confirmado:** o `index.html` já está correto — a tag `<img class="card-grupo-foto" src="${g.foto_url}">` já existe no template do card, com tratamento de erro via `addEventListener`. O problema é que a classe CSS `.card-grupo-foto` provavelmente está ausente, incompleta, ou conflitando com outra regra em `public/css/global.css`.

**Ação:** abrir `public/css/global.css` e confirmar se a classe `.card-grupo-foto` existe. Se não existir, adicionar:

```css
.card-grupo-foto {
  width: 100%;
  height: 140px;
  object-fit: cover;
  border-radius: 8px;
  margin-bottom: 8px;
  display: block;
}
```

Se a classe já existir mas com `display: none`, `height: 0`, `width: 0`, ou estiver dentro de algum seletor mais específico que a sobrescreve (ex: `.card-grupo img` com outra regra conflitante declarada depois), corrigir o conflito — a regra de `.card-grupo-foto` precisa garantir altura e largura visíveis.

Também conferir se existe a classe `.card-grupo-cabecalho` usada logo abaixo da foto no HTML (`<div class="card-grupo-cabecalho">`) — se não existir, ela não quebra nada visualmente (é só uma div sem estilo), mas vale adicionar um `display: flex; gap: 8px; align-items: center; margin-bottom: 6px;` básico para alinhar a tag de categoria corretamente abaixo da foto.

**Teste:** depois de aplicar, abrir a home e confirmar visualmente que os 3 cards mostram a foto. Se ainda não aparecer, abrir DevTools → Network → filtrar por "Img" → conferir se a requisição da imagem retorna 200 (carregou) ou erro — isso indicaria um problema diferente (caminho do arquivo incorreto), não mais CSS.

---

## Correção 2 — Crash do servidor por porta em uso (EADDRINUSE)

**Diagnóstico:** não é um bug de lógica do projeto. É o `node --watch` (usado em `npm run dev`) tentando reiniciar o servidor após cada arquivo salvo, e o processo anterior às vezes não solta a porta 3000 a tempo do novo processo tentar escutar nela. Resultado: o novo processo crasha com `Error: listen EADDRINUSE: address already in use :::3000` e o servidor fica fora do ar até alguém perceber e reiniciar manualmente (ou matar o processo preso com `taskkill`).

Isso já causou pelo menos dois problemas observados nesta sessão: um clique de cadastro que pareceu "não funcionar" na primeira tentativa, e uma rejeição de grupo cujo email não foi enviado porque o servidor estava fora do ar naquele momento.

**Ação 1 — mensagem de erro mais clara em `src/server.js`:**

Localizar a função `iniciar()` (que chama `app.listen(PORT, ...)`) e adicionar tratamento explícito para esse erro específico, para que pelo menos fique óbvio no terminal o que aconteceu e o que fazer:

```js
async function iniciar() {
  try {
    await getDb();
    console.log('[db] Banco de dados carregado.');

    const servidor = app.listen(PORT, () => {
      console.log(`[server] LinkHub rodando em http://localhost:${PORT}`);
    });

    servidor.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n[server] ❌ A porta ${PORT} já está em uso por outro processo.`);
        console.error('[server] Isso geralmente acontece quando o servidor anterior não foi fechado corretamente.');
        console.error('[server] No Windows, rode: netstat -ano | findstr :' + PORT);
        console.error('[server] Depois: taskkill /PID <numero_do_pid> /F\n');
        process.exit(1);
      } else {
        console.error('[server] Erro inesperado ao iniciar:', err);
        process.exit(1);
      }
    });
  } catch (err) {
    console.error('[server] Falha ao iniciar:', err.message);
    console.error('Execute primeiro: npm run setup');
    process.exit(1);
  }
}
```

Isso não elimina o problema de timing do `--watch`, mas transforma uma stack trace técnica assustadora numa mensagem clara com o comando exato pra resolver — reduz a confusão na hora de diagnosticar.

**Ação 2 — não é código, é processo de trabalho:** registrar como nota operacional (já incluída na seção de notas finais deste documento) que, depois de qualquer rodada de edições feitas pelo agy, vale fechar o terminal completamente e abrir um novo antes de testar — não confiar cegamente no auto-reload do `--watch` quando múltiplos arquivos forem alterados em sequência rápida.

---

## Correção 3 — Ver detalhes completos da solicitação pendente antes de decidir

**Contexto:** hoje, no Painel Admin → aba Pendentes, o card já mostra nome, categoria, descrição, link e contato — mas a pessoa quer poder ver tudo de forma mais destacada/expandida antes de aprovar ou rejeitar, para casos como: nome parece ok mas a descrição tem algo problemático, ou o link aponta para um grupo que fere as diretrizes.

**Decisão de implementação:** em vez de criar uma página nova ou modal separado, **expandir o próprio card** ao clicar nele (ou num botão "Ver detalhes completos"), revelando todos os campos do grupo de forma mais organizada — já que o card no `admin.html` atual já mostra a maioria dos campos, a melhoria real aqui é de **organização visual e destaque**, não de dados faltando.

Adicionar ao card de cada solicitação pendente (no `admin.html`, dentro da função que renderiza a lista de pendentes):

```html
<div class="solicitacao-detalhe-expandido" style="display:none; margin-top:12px; padding-top:12px; border-top:1px dashed var(--cinza-borda); font-size:0.85rem;">
  <p><strong>Nome do grupo:</strong> ${escaparHtml(g.nome_grupo)}</p>
  <p><strong>Categoria:</strong> ${escaparHtml(g.categoria_nome)}</p>
  <p><strong>Descrição completa:</strong> ${escaparHtml(g.descricao)}</p>
  ${g.regras ? `<p><strong>Regras informadas:</strong><br>${escaparHtml(g.regras).replace(/\n/g, '<br>')}</p>` : ''}
  <p><strong>Link:</strong> <a href="${escaparHtml(g.link_whatsapp)}" target="_blank" rel="noopener">${escaparHtml(g.link_whatsapp)}</a></p>
  <p><strong>Nome do solicitante:</strong> ${escaparHtml(g.nome_contato)}</p>
  <p><strong>Email do solicitante:</strong> ${escaparHtml(g.email_contato)}</p>
  <p><strong>Enviado em:</strong> ${formatarData(g.criado_em)}</p>
</div>
<button class="btn btn-contorno btn-sm btn-ver-detalhes" data-id="${g.id}" style="margin-top:8px;">Ver detalhes completos</button>
```

E o toggle via `addEventListener` (delegação de evento, seguindo o padrão já usado no resto do `admin.html` — **nenhum handler inline**):

```js
document.getElementById('lista-area').addEventListener('click', (e) => {
  const btnDetalhe = e.target.closest('.btn-ver-detalhes');
  if (btnDetalhe) {
    const card = btnDetalhe.closest('.solicitacao-card');
    const painel = card.querySelector('.solicitacao-detalhe-expandido');
    const aberto = painel.style.display !== 'none';
    painel.style.display = aberto ? 'none' : 'block';
    btnDetalhe.textContent = aberto ? 'Ver detalhes completos' : 'Ocultar detalhes';
    return;
  }
  // manter o resto da lógica de clique já existente (aprovar/rejeitar/remover) abaixo deste bloco
});
```

**Nota para quem aplicar:** o `admin.html` já tem um listener de clique em `#lista-area` para os botões de ação (aprovar/rejeitar/remover). Não criar um segundo listener duplicado — inserir essa checagem de `btn-ver-detalhes` no **início** do listener já existente, com `return` se for o caso, deixando o resto do código de aprovar/rejeitar/remover intacto logo abaixo.

---

## Correção 4 — Texto dos emails de aprovação e rejeição

**Localização:** `src/email.js`, funções `emailGrupoAprovado` e `emailGrupoRejeitado` (os nomes exatos das funções podem variar ligeiramente — conferir o arquivo atual antes de editar, e procurar pela parte que monta o assunto/corpo do email).

**Formato pedido pelo usuário:**

Para aprovação:
```
Assunto: SUPORTE LinkHub
Corpo: Seu grupo foi aprovado! Logo logo estará em nosso sistema.
```

Para rejeição:
```
Assunto: SUPORTE LinkHub
Corpo: Lamentamos informar que seu Grupo não foi aceito pelo seguinte motivo: {motivo}
```//(o `{motivo}` é o texto que o admin escreveu no campo de rejeição do painel — esse dado já é passado para a função de email no fluxo atual, só ajustar o template)

Ajustar o HTML/template do email (mantendo a estrutura visual de cabeçalho/rodapé que já existe em `email.js`, só trocando o texto do assunto e do corpo principal para esse formato mais direto). Manter o link de volta para o site e qualquer outro elemento de identidade visual (cores, logo) que já exista no template atual — a mudança é só de **copy**, não de estrutura HTML do email.

**Importante:** confirmar que a função de rejeição recebe e usa corretamente a variável do motivo digitado pelo admin no modal de rejeição (`admin.html` → textarea de motivo → `POST /admin/grupos/:id/rejeitar` → `src/routes/admin.js` → `emailGrupoRejeitado(...)`). Esse encadeamento já deveria existir no projeto atual — apenas confirmar que o motivo chega íntegro até o template do email, sem ser cortado ou perdido no caminho.

---

## Checklist de teste depois de aplicar

1. **Foto na home:** recarregar `localhost:3000` e confirmar visualmente que os cards mostram foto.
2. **Crash de porta:** não há como forçar esse teste de forma confiável, mas da próxima vez que `EADDRINUSE` acontecer, confirmar que a mensagem de erro no terminal ficou mais clara (com o comando de `taskkill` sugerido) em vez da stack trace crua de antes.
3. **Detalhe expandido:** no Painel Admin → Pendentes, enviar um grupo de teste novo, clicar em "Ver detalhes completos" no card dele, e confirmar que todos os campos aparecem (incluindo regras, se preenchidas). Clicar de novo para confirmar que oculta.
4. **Email de aprovação:** com o servidor **confirmadamente rodando** (checar a última linha do terminal antes de testar — deve mostrar `[server] LinkHub rodando em http://localhost:3000` e nenhum erro depois disso), aprovar um grupo pendente no painel e conferir no terminal se aparece `[EMAIL SIMULADO]` com o assunto e corpo no novo formato.
5. **Email de rejeição:** mesma checagem, mas rejeitando um grupo com um motivo de teste (ex: "Conteúdo não condiz com a categoria selecionada") — conferir que o motivo aparece corretamente dentro do corpo do email simulado no terminal.

---

## Nota operacional (processo de trabalho, não é código)

Depois de qualquer rodada de mudanças aplicadas pelo agy, antes de testar:
1. Fechar completamente o terminal onde o `npm run dev` está rodando (não só `Ctrl+C` — fechar a aba/janela do terminal).
2. Abrir um terminal novo.
3. Rodar `npm run dev` limpo.
4. Conferir que a última linha mostra `[server] LinkHub rodando em http://localhost:3000` sem nenhum erro abaixo, antes de começar a testar no navegador.

Isso evita boa parte dos falsos-bugs causados por reinício de porta que já aconteceram mais de uma vez nesta sessão.
