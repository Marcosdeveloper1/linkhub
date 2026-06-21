const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '../../data/linkhub.db');

async function createDatabase() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      icone TEXT NOT NULL DEFAULT 'folder'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_grupo TEXT NOT NULL,
      link_whatsapp TEXT NOT NULL,
      descricao TEXT NOT NULL,
      categoria_id INTEGER NOT NULL,
      usuario_id INTEGER,
      nome_contato TEXT NOT NULL,
      email_contato TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      motivo_rejeicao TEXT,
      foto_url TEXT,
      regras TEXT,
      total_acessos INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      aprovado_em TEXT,
      FOREIGN KEY (categoria_id) REFERENCES categories(id),
      FOREIGN KEY (usuario_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS error_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grupo_id INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      descricao TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      resolvido_em TEXT,
      FOREIGN KEY (grupo_id) REFERENCES groups(id),
      FOREIGN KEY (usuario_id) REFERENCES users(id)
    )
  `);


  db.run(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      user_id INTEGER PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      quantidade INTEGER NOT NULL,
      saldo_antes INTEGER NOT NULL,
      saldo_depois INTEGER NOT NULL,
      referencia_tipo TEXT,
      referencia_id INTEGER,
      descricao TEXT,
      admin_id INTEGER,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (admin_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS zapcoin_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      coins INTEGER NOT NULL,
      preco_centavos INTEGER NOT NULL,
      descricao TEXT,
      destaque INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1,
      ordem INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS zapcoin_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      package_id INTEGER,
      coins INTEGER NOT NULL,
      preco_centavos INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      gateway TEXT DEFAULT 'syncpay',
      gateway_payment_id TEXT,
      checkout_url TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      pago_em TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (package_id) REFERENCES zapcoin_packages(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS group_boosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      coins_used INTEGER NOT NULL,
      days INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ativo',
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES groups(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired TEXT NOT NULL
    )
  `);

  const adminSenha = bcrypt.hashSync(process.env.ADMIN_SENHA || 'admin123', 12);
  db.run(`
    INSERT OR IGNORE INTO users (nome, email, senha, role)
    VALUES ('Administrador', 'admin@whatsappgrupos.site', '${adminSenha}', 'admin')
  `);

  const categorias = [
    ['Amizade', 'amizade', 'users'],
    ['Relacionamento', 'relacionamento', 'heart'],
    ['Carros e Motos', 'carros', 'car'],
    ['Cidades', 'cidade', 'building'],
    ['Compra e Venda', 'compras-e-vendas', 'shopping-cart'],
    ['Concursos', 'concursos', 'books'],
    ['Desenhos e Animes', 'desenhos', 'video'],
    ['Divulgação', 'divulgacao', 'megaphone'],
    ['Educação', 'educacao', 'school'],
    ['Emagrecimento', 'emagrecimento', 'activity'],
    ['Dinheiro', 'financas', 'currency-dollar'],
    ['Investimentos', 'investimentos', 'chart-line'],
    ['Links', 'links', 'link'],
    ['Receitas', 'receitas', 'chef-hat'],
    ['Religião', 'religiao', 'sparkles'],
    ['Turismo', 'turismo', 'map'],
    ['Política', 'politica', 'speakerphone'],
    ['Tecnologia', 'tecnologia', 'device-laptop'],
    ['Saúde', 'saude', 'heart-pulse'],
    ['Entretenimento', 'entretenimento', 'movie'],
    ['Empregos', 'empregos', 'briefcase'],
    ['Negócios', 'negocios', 'trending-up'],
    ['Esportes', 'esportes', 'ball-football'],
    ['Outros', 'outros', 'dots-circle-horizontal']
  ];

  for (const [nome, slug, icone] of categorias) {
    db.run(`INSERT OR IGNORE INTO categories (nome, slug, icone) VALUES (?, ?, ?)`, [nome, slug, icone]);
    db.run(`UPDATE categories SET nome = ?, icone = ? WHERE slug = ?`, [nome, icone, slug]);
  }


  const pacotesZapCoin = [
    ['avulso', 'Avulso', 1, 799, '1 ZapCoin para testar ou completar saldo. Valor base: R$ 7,99 por ZapCoin.', 0, 1],
    ['starter', 'Starter', 5, 3495, 'Entrada ideal para testar impulsos com desconto. R$ 6,99 por ZapCoin.', 0, 2],
    ['bronze', 'Bronze', 10, 6490, 'Mais alcance por menos. R$ 6,49 por ZapCoin.', 0, 3],
    ['profissional', 'Profissional', 25, 14975, 'Pacote profissional/empresarial para divulgar grupos com frequência. R$ 5,99 por ZapCoin.', 1, 4],
    ['empresarial', 'Empresarial', 50, 27450, 'Pacote empresarial para operações com vários grupos e impulsos recorrentes. R$ 5,49 por ZapCoin.', 0, 5],
    ['empresarial-plus', 'Empresarial Plus', 100, 49900, 'Pacote empresarial avançado com o melhor custo por ZapCoin. R$ 4,99 por ZapCoin.', 0, 6]
  ];

  for (const [codigo, nome, coins, preco, descricao, destaque, ordem] of pacotesZapCoin) {
    db.run(`
      INSERT OR IGNORE INTO zapcoin_packages
        (codigo, nome, coins, preco_centavos, descricao, destaque, ordem)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [codigo, nome, coins, preco, descricao, destaque, ordem]);
  }

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const buffer = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buffer));
  db.close();

  console.log('Banco de dados criado com sucesso em', DB_PATH);
  console.log('Admin padrão: admin@whatsappgrupos.site / admin123 (MUDE EM PRODUÇÃO!)');
}

createDatabase().catch(console.error);