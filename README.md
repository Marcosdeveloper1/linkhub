# LinkHub

Diretório de grupos de WhatsApp com sistema de moderação.

## Requisitos

- Node.js 18+
- npm

## Instalação e setup

```bash
# 1. Clone o projeto
git clone <seu-repo>
cd linkhub

# 2. Instale as dependências
npm install

# 3. Configure o ambiente
cp .env.example .env
# Edite o .env com seus valores

# 4. Crie o banco de dados (apenas na primeira vez)
npm run setup

# 5. Inicie o servidor
npm start
```

O servidor estará disponível em `http://localhost:3000`.

## Credenciais padrão

- **Admin:** admin@linkhub.com.br / admin123
- **TROQUE A SENHA DO ADMIN APÓS O PRIMEIRO LOGIN!**

## Estrutura do projeto

```
linkhub/
├── public/            # Frontend (HTML, CSS, JS estáticos)
│   ├── css/           # Estilos globais
│   ├── js/            # Utilitários JS compartilhados
│   ├── pages/         # Páginas HTML
│   └── index.html     # Home principal
├── src/               # Backend Node.js
│   ├── db/            # Banco de dados (sql.js)
│   ├── middleware/     # Segurança, sessão, validação
│   ├── routes/        # Rotas da API
│   ├── email.js       # Serviço de email
│   └── server.js      # Servidor Express
├── data/              # Banco de dados SQLite (criado automaticamente)
├── .env.example       # Modelo de variáveis de ambiente
└── package.json
```

## API

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| POST | /api/auth/cadastro | Público | Criar conta |
| POST | /api/auth/login | Público | Login |
| POST | /api/auth/logout | Logado | Logout |
| GET | /api/auth/me | Público | Sessão atual |
| GET | /api/grupos | Público | Listar grupos aprovados |
| GET | /api/grupos/categorias | Público | Listar categorias |
| POST | /api/grupos/enviar | Logado | Enviar grupo para aprovação |
| GET | /api/admin/pendentes | Admin | Grupos aguardando moderação |
| POST | /api/admin/aprovar/:id | Admin | Aprovar grupo |
| POST | /api/admin/rejeitar/:id | Admin | Rejeitar grupo com motivo |
| DELETE | /api/admin/grupo/:id | Admin | Remover grupo |
| GET | /api/admin/usuarios | Admin | Listar usuários |
| GET | /api/admin/stats | Admin | Métricas gerais |

## Deploy no Vercel

O Vercel não suporta Node.js com estado persistente (banco de dados em arquivo). Para deploy, use:

- **Railway.app** — suporta Node.js com volume persistente (gratuito)
- **Render.com** — similar ao Railway, tem plano gratuito
- **VPS própria** — controle total

### Para Railway:
1. Crie uma conta em railway.app
2. Conecte seu repositório GitHub
3. Adicione as variáveis de ambiente do .env.example
4. Configure o start command: `npm run setup && npm start`

## Segurança implementada

- Senhas com bcrypt (custo 12)
- Rate limiting em todas as rotas críticas
- Sessões httpOnly com regeneração no login
- Helmet.js com CSP configurado
- Sanitização de inputs em todas as rotas
- Validação de link WhatsApp via regex
- Proteção contra timing attacks no login
- CORS configurável por variável de ambiente
- Nenhuma informação sensível exposta nas respostas de erro
