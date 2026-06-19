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
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired TEXT NOT NULL
    )
  `);

  const adminSenha = bcrypt.hashSync(process.env.ADMIN_SENHA || 'admin123', 12);
  db.run(`
    INSERT OR IGNORE INTO users (nome, email, senha, role)
    VALUES ('Administrador', 'admin@linkhub.com.br', '${adminSenha}', 'admin')
  `);

  const categorias = [
    ['Política', 'politica', 'speakerphone'],
    ['Finanças & Dinheiro', 'financas', 'currency-dollar'],
    ['Esportes & Futebol', 'esportes', 'ball-football'],
    ['Tecnologia', 'tecnologia', 'device-laptop'],
    ['Saúde & Bem-estar', 'saude', 'heart'],
    ['Entretenimento', 'entretenimento', 'movie'],
    ['Empregos & Vagas', 'empregos', 'briefcase'],
    ['Educação', 'educacao', 'school'],
    ['Negócios & Empreendedorismo', 'negocios', 'trending-up'],
    ['Outros', 'outros', 'dots-circle-horizontal']
  ];

  for (const [nome, slug, icone] of categorias) {
    db.run(`INSERT OR IGNORE INTO categories (nome, slug, icone) VALUES (?, ?, ?)`, [nome, slug, icone]);
  }

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const buffer = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buffer));
  db.close();

  console.log('Banco de dados criado com sucesso em', DB_PATH);
  console.log('Admin padrão: admin@linkhub.com.br / admin123 (MUDE EM PRODUÇÃO!)');
}

createDatabase().catch(console.error);
