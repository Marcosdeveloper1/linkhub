# LinkHub — Documento de Estado do Projeto

> Última atualização: 19/06/2026 (sessão de correção do bug "grupo 0" / foto sobrescrita)
> Este documento substitui os .md anteriores (CORRECAO_BUGS, IMPLEMENTAR_APROVACAO_GRUPOS, FOTO_AUTOMATICA_E_IMPORTACAO_LOTE, CORRECOES, DIAGNOSTICO_FOTO). Use **este** como referência única do estado atual.

---

## 1. O que é o projeto

Diretório web de grupos de WhatsApp organizados por categoria, com cadastro de usuário, envio de grupo para moderação, painel admin de aprovação/rejeição, e importação em lote para o admin adicionar grupos de outros sites direto (já aprovados, sem fila).

Objetivo de negócio: gerar volume inicial de grupos via importação em lote (feita pelo sócio), e depois captar novos cadastros organicamente pelo fluxo de usuário comum.

---

## 2. Stack técnica

- **Backend:** Node.js + Express
- **Banco de dados:** SQLite via `sql.js` (não usa `better-sqlite3` — foi trocado no início do projeto por incompatibilidade de build nativo)
- **Sessão:** `express-session`, cookie httpOnly
- **Senha:** `bcryptjs`
- **Segurança:** `helmet` (CSP ativo), `express-rate-limit`, `validator`
- **Email:** `nodemailer`, modo simulado (loga no console) quando `SMTP_HOST` não está configurado no `.env`
- **Frontend:** HTML + CSS + JS puro (sem framework, sem build step)
- **Dev:** `npm run dev` usa `node --watch` (reinicia sozinho ao salvar arquivo)

---

## 3. Estrutura de arquivos

```
linkhub/
├── data/
│   └── linkhub.db                  # banco SQLite (gerado por npm run setup, não vai pro git)
├── public/
│   ├── css/global.css              # design system completo
│   ├── img/grupos/                 # fotos de grupos baixadas localmente (novo - ver seção 6)
│   ├── js/utils.js                 # funções compartilhadas (navbar, apiFetch, sessão)
│   ├── index.html                  # home — lista grupos aprovados, busca, filtro categoria
│   └── pages/
│       ├── login.html
│       ├── cadastro.html
│       ├── enviar-grupo.html       # form de envio (requer login)
│       └── admin.html              # painel de moderação + importação em lote
├── src/
│   ├── db/
│   │   ├── index.js                # getDb, query, queryOne, run, migrar (ver seção 6)
│   │   └── setup.js                # cria tabelas + seed inicial (admin + categorias)
│   ├── middleware/
│   │   └── security.js             # rate limiters, sessionConfig, requireLogin/Admin, validações
│   ├── routes/
│   │   ├── auth.js                 # cadastro, login, logout, /me
│   │   ├── groups.js               # GET / (paginado), GET /categorias, POST /enviar
│   │   └── admin.js                # pendentes, aprovar, rejeitar, remover, importar-lote
│   ├── utils/
│   │   └── whatsappPreview.js      # busca og:image/og:title do link do WhatsApp (novo)
│   ├── email.js                    # templates + envio (emailBoasVindas, emailGrupoAprovado, emailGrupoRejeitado)
│   └── server.js                   # bootstrap Express
├── .env / .env.example
├── .gitignore
└── package.json
```

---

## 4. Banco de dados — schema atual

```sql
users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha TEXT NOT NULL,            -- hash bcrypt
  role TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
)

categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  icone TEXT NOT NULL DEFAULT 'folder'
)
-- seed: politica, financas, esportes, tecnologia, saude, entretenimento,
--       empregos, educacao, negocios, outros

groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_grupo TEXT NOT NULL,
  link_whatsapp TEXT NOT NULL,
  descricao TEXT NOT NULL,
  categoria_id INTEGER NOT NULL,
  usuario_id INTEGER,              -- NULL quando inserido via importação em lote (sem dono)
  nome_contato TEXT NOT NULL,
  email_contato TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',  -- 'pendente' | 'aprovado' | 'rejeitado'
  motivo_rejeicao TEXT,
  foto_url TEXT,                   -- NOVO: caminho local da foto (ex: /img/grupos/grupo-7.jpg)
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  aprovado_em TEXT,
  FOREIGN KEY (categoria_id) REFERENCES categories(id),
  FOREIGN KEY (usuario_id) REFERENCES users(id)
)
```

**Admin padrão (seed):** `admin@linkhub.com.br` / senha vinda de `ADMIN_SENHA` no `.env`, ou `admin123` se a variável não existir. **Trocar antes de produção.**

---

## 5. Bugs já corrigidos (histórico — não retrabalhar)

Todos seguiam o mesmo padrão raiz: **handlers de evento inline (`onclick=`, `onsubmit=`, `oninput=`) no HTML são bloqueados pelo CSP** configurado no `helmet` (`script-src-attr: 'none'` implícito quando não declarado). A correção em todos os casos foi remover o atributo inline e registrar via `addEventListener` depois que o DOM carrega (ou depois do `innerHTML` ser montado, no caso de conteúdo dinâmico).

Arquivos já corrigidos com esse padrão:
- `cadastro.html` (onsubmit do form, oninput da senha)
- `login.html` (onsubmit do form — **este vazou senha em texto puro na URL antes de corrigido**, porque o submit nativo do navegador (GET) rodou no lugar do `fetch`)
- `enviar-grupo.html` (onsubmit do form, oninput da descrição)
- `utils.js` → `montarNavbar()` (onclick do botão Sair)
- `index.html` (onsubmit da busca, onclick do filtro "Todos", onclick dos botões de paginação gerados dinamicamente)
- `admin.html` (onclick de aprovar/rejeitar/remover/toggle usuário — todos os botões gerados via `innerHTML`)

**Regra permanente daqui pra frente:** qualquer HTML novo, estático ou gerado via `innerHTML`/template string, **nunca** deve usar `onclick=`, `onsubmit=`, `oninput=`, `onchange=` etc. como atributo. Sempre `addEventListener` (delegação de evento quando o elemento é dinâmico, geralmente usando `data-id` no elemento e selecionando via `querySelectorAll` depois do `innerHTML` ser setado).

**Bug separado já corrigido:** rate limiter (`limiterGeral`) estava aplicado globalmente em `app.use(limiterGeral)`, **antes** do `express.static`. Isso fazia toda requisição de arquivo estático (CSS, JS, fontes) contar contra o limite, causando 429 em uso normal e o navegador recebendo JSON de erro no lugar do `.css` (daí o erro de MIME type). Corrigido: `express.static` agora vem **antes**, e o limiter foi restrito a `app.use('/api', limiterGeral)`.

**Bug separado já corrigido:** `last_insert_rowid()` em `src/db/index.js` retornava sempre `0` depois de inserts. Causa: a função `run()` chamava `saveDb()` (que faz `_db.export()`) **antes** de capturar o `last_insert_rowid()`, e o `export()` do `sql.js` reseta esse contador interno. Corrigido capturando o ID **antes** de chamar `saveDb()`.

---

## 6. Funcionalidades novas (foto automática + importação em lote) — EM ANDAMENTO, COM BUG ABERTO

### 6.1 Motivação
O sócio vai inserir grupos de outros sites pra dar volume inicial. Decisão: não obrigar conta de usuário pra isso — admin insere direto, já aprovado, sem disparar e-mail (não existe "solicitante" real pra notificar nesses casos).

### 6.2 Captura de foto — abordagem
Link de convite do WhatsApp (`chat.whatsapp.com/CODIGO`) serve uma página com metadados Open Graph (`og:image`, `og:title`) públicos, sem precisar de login. Plano:
1. Servidor busca essa página (`fetch` no backend, sem problema de CORS porque não é o navegador fazendo a chamada)
2. Extrai `og:image` e `og:title` via regex/parsing simples
3. **Decodifica entidades HTML** do título (ex: `&#x1f977;` → emoji real) — bug já corrigido nessa parte
4. Baixa a imagem do `og:image` e salva localmente em `public/img/grupos/`, servindo do próprio domínio

### 6.3 Por que baixar a imagem em vez de só guardar a URL
**Tentativa 1 (abandonada):** guardar só a URL externa (`pps.whatsapp.net/...`) no campo `foto_url` e apontar o `<img>` direto pra lá.
**Resultado:** erro 403 Forbidden ao carregar no navegador. O CDN do WhatsApp tem proteção anti-hotlinking — bloqueia quando a imagem é carregada fora do contexto/referer do próprio WhatsApp.
**Solução adotada:** servidor baixa a imagem **uma vez**, no momento do cadastro/importação, e salva como arquivo estático em `public/img/grupos/grupo-{id}.jpg` (ou extensão equivalente). O `foto_url` salvo no banco passa a ser um caminho local (ex: `/img/grupos/grupo-7.jpg`), servido pelo `express.static` que já existe. **Não é um banco de imagens — é só uma pasta com arquivos.**

### 6.4 Importação em lote
Painel Admin → botão "Importar em lote" → modal com textarea. Formato esperado, uma linha por grupo:
```
https://chat.whatsapp.com/CODIGO1,esportes
https://chat.whatsapp.com/CODIGO2,tecnologia
```
(link + slug da categoria, separados por vírgula). Até 50 linhas por vez. Para cada linha: valida formato do link, valida se a categoria existe, checa duplicidade (mesmo link já cadastrado), busca foto/nome via Open Graph, insere com `status = 'aprovado'` diretamente (pula fila de moderação) e `usuario_id = NULL`. Retorna resumo: quantos importados com sucesso, quais falharam e por quê.

### 6.5 BUG RESOLVIDO — "grupo 0" no log + foto sobrescrita entre grupos

**Causa raiz confirmada:** não era a hipótese do loop/closure em `admin.js` (esse arquivo estava correto — captura o `id` do retorno de `db.run()` antes de chamar `baixarFotoGrupo`). O bug estava em `src/db/index.js`, na função `run()`:

```js
// ANTES (quebrado)
function run(sql, params = []) {
  _db.run(sql, params);
  saveDb();                                          // export() reseta last_insert_rowid()
  const result = query('SELECT last_insert_rowid() as id');
  return result[0]?.id;                              // sempre retornava 0
}
```

`saveDb()` chama `_db.export()` internamente, e essa chamada **reseta o contador interno do `last_insert_rowid()`** do `sql.js`. Como `saveDb()` era chamado antes de ler o `last_insert_rowid()`, todo INSERT (em qualquer tabela — `users`, `groups`, etc.) retornava sempre `0` em vez do ID real gerado pelo `AUTOINCREMENT`.

Essa correção já tinha sido identificada e aplicada uma vez antes (ver registro em sessão anterior), mas **regrediu** — o arquivo `src/db/index.js` voltou a ter a versão quebrada em algum momento entre sessões/aplicações do agy. Causa exata da regressão não identificada (possivelmente o agy reescreveu o arquivo do zero numa tarefa não relacionada e usou uma versão desatualizada como base).

**Correção aplicada (definitiva):**
```js
function run(sql, params = []) {
  if (!_db) throw new Error('Banco não inicializado');
  _db.run(sql, params);
  const result = query('SELECT last_insert_rowid() as id');  // captura ANTES de salvar
  const id = result[0]?.id;
  saveDb();                                                    // só então persiste em disco
  return id;
}
```

**Status:** testado e confirmado funcionando — importação em lote de 3 grupos diferentes gerou 3 fotos distintas corretamente associadas (sem mais sobrescrita do `grupo-0.jpg`).

**Ação preventiva recomendada:** ao pedir qualquer alteração futura em `src/db/index.js`, sempre colar o conteúdo atual do arquivo primeiro (nunca deixar o agy assumir/recriar do zero), e citar este documento como referência de que a função `run()` tem essa particularidade não-óbvia (ordem de captura do ID importa).

---

## 7. Convenções e padrões do projeto (seguir nesses novos trabalhos)

- **Idioma:** todo o código (nomes de variável, função, classe) em português, propositalmente — para não parecer gerado por IA. Comentários também em português quando existirem.
- **Formato de erro de API:** sempre `{ erro: 'mensagem em português' }`, nunca em inglês, nunca expondo stack trace pro cliente.
- **Acesso a banco:** sempre via `db.query()` (múltiplas linhas), `db.queryOne()` (uma linha), `db.run()` (insert/update/delete, retorna o ID no caso de insert). Nunca acessar `_db` diretamente fora de `src/db/index.js`.
- **Autenticação:** sessão em `req.session.usuario` (objeto com `id`, `nome`, `email`, `role`). Middlewares prontos: `requireLogin`, `requireAdmin` (em `src/middleware/security.js`).
- **Validação de link do WhatsApp:** regex oficial é `^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{20,}$` (função `isValidWhatsAppLink` em `security.js`) — frontend e backend devem usar a mesma regra.
- **Nenhum handler de evento inline em HTML** (ver seção 5 — regra permanente).
- **Sanitização:** `sanitizeString(str, maxLen)` para qualquer input de texto antes de salvar no banco.

---

## 8. Pendências conhecidas (não urgentes, registradas para não esquecer)

- Links de grupos importados de outros sites podem expirar/quebrar com o tempo (admin troca o link, grupo lota). Vale criar rotina de verificação periódica de links mortos no futuro — não é prioridade agora.
- Favicon ausente (erro 404 no console, cosmético, sem impacto funcional).
- Edição de grupo já publicado pelo admin (corrigir nome/categoria/descrição sem precisar remover e reimportar) — mencionado como possível próximo passo, ainda não implementado.
- SMTP real ainda não configurado — emails atualmente só são logados no console (modo simulado). Configurar quando for pra produção.
- `DELETE /grupos/:id` remove o registro do banco mas **não apaga o arquivo de foto correspondente** em `public/img/grupos/`. Não é crítico (arquivos órfãos não quebram nada, só ocupam espaço), mas vale resolver em algum momento — idealmente fazendo o DELETE também rodar `fs.unlink` no caminho de `foto_url` antes de remover a linha do banco.
- Alguns nomes de grupo capturados via `og:title` podem ser genéricos demais (ex: um grupo real retornou só "Ta" como nome) — isso não é bug, é o título real cadastrado no WhatsApp por quem criou o grupo. Sem ferramenta de edição (ver item acima), não dá pra corrigir isso pelo painel ainda.

---

## 9. Status geral (resumo rápido)

Fluxo completo testado e funcionando ponta a ponta: cadastro de usuário → login → envio de grupo → moderação no painel admin (aprovar/rejeitar com motivo + email automático) → exibição pública na home com busca e filtro por categoria → importação em lote pelo admin com captura automática de nome e foto via Open Graph do WhatsApp, salvando a imagem localmente para evitar bloqueio de hotlinking do CDN do WhatsApp (erro 403).

Não há bugs abertos conhecidos no momento. Próximos passos ficam a critério do usuário — candidatos naturais são os itens da seção 8, ou novas funcionalidades de produto (perfil de usuário, edição de grupo, etc.).
