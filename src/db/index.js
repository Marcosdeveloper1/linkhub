const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/linkhub.db');

let _db = null;
let _SQL = null;

async function getDb() {
  if (_db) return _db;

  _SQL = await initSqlJs();

  if (!fs.existsSync(DB_PATH)) {
    throw new Error('Banco de dados não encontrado. Execute: npm run setup');
  }

  const fileBuffer = fs.readFileSync(DB_PATH);
  _db = new _SQL.Database(fileBuffer);

  migrar();

  return _db;
}

function saveDb() {
  if (!_db) return;
  const buffer = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buffer));
}

function tentar(sql, params = [], mensagemOk = null, mensagemErro = null) {
  try {
    _db.run(sql, params);
    saveDb();
    if (mensagemOk) console.log(mensagemOk);
  } catch (err) {
    if (mensagemErro) console.error(mensagemErro, err.message);
  }
}

function migrar() {
  tentar('ALTER TABLE groups ADD COLUMN foto_url TEXT');
  tentar('ALTER TABLE groups ADD COLUMN regras TEXT');
  tentar('ALTER TABLE groups ADD COLUMN total_acessos INTEGER NOT NULL DEFAULT 0');

  tentar('ALTER TABLE groups ADD COLUMN owner_email TEXT');
  tentar('ALTER TABLE groups ADD COLUMN owner_user_id INTEGER');
  tentar("ALTER TABLE groups ADD COLUMN ownership_status TEXT NOT NULL DEFAULT 'sem_dono'");
  tentar('ALTER TABLE groups ADD COLUMN ownership_claimed_at TEXT');
  tentar('ALTER TABLE groups ADD COLUMN owner_assigned_at TEXT');
  tentar('ALTER TABLE groups ADD COLUMN owner_assigned_by INTEGER');

  tentar(`
    UPDATE groups
    SET owner_user_id = usuario_id,
        owner_email = COALESCE(owner_email, (SELECT email FROM users WHERE users.id = groups.usuario_id)),
        ownership_status = 'vinculado',
        ownership_claimed_at = COALESCE(ownership_claimed_at, datetime('now'))
    WHERE usuario_id IS NOT NULL
      AND (owner_user_id IS NULL OR ownership_status IS NULL OR ownership_status = 'sem_dono')
  `);

  tentar(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      user_id INTEGER PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `, [], '[db] ZapCoin: tabela user_wallets verificada.', '[db] Erro ao criar user_wallets:');

  tentar(`
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
  `, [], '[db] ZapCoin: tabela wallet_transactions verificada.', '[db] Erro ao criar wallet_transactions:');

  tentar('ALTER TABLE wallet_transactions ADD COLUMN admin_id INTEGER');

  tentar(`
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
  `, [], '[db] ZapCoin: tabela zapcoin_packages verificada.', '[db] Erro ao criar zapcoin_packages:');

  tentar(`
    CREATE TABLE IF NOT EXISTS zapcoin_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      package_id INTEGER,
      coins INTEGER NOT NULL,
      preco_centavos INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      gateway TEXT DEFAULT 'mercadopago',
      gateway_payment_id TEXT,
      gateway_preference_id TEXT,
      checkout_url TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      pago_em TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (package_id) REFERENCES zapcoin_packages(id)
    )
  `, [], '[db] ZapCoin: tabela zapcoin_orders verificada.', '[db] Erro ao criar zapcoin_orders:');

  tentar('ALTER TABLE zapcoin_orders ADD COLUMN gateway_preference_id TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN buyer_name TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN buyer_email TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN buyer_cpf TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN payment_method TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN pix_code TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN gateway_status TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN gateway_payload TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN gateway_final_amount_centavos INTEGER');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN credited_at TEXT');
  tentar('ALTER TABLE zapcoin_orders ADD COLUMN atualizado_em TEXT');

  tentar(`
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
  `, [], '[db] ZapCoin: tabela group_boosts verificada.', '[db] Erro ao criar group_boosts:');

  const pacotesZapCoin = [
    ['avulso', 'Avulso', 1, 799, '1 ZapCoin para testar ou completar saldo. Valor base: R$ 7,99 por ZapCoin.', 0, 1],
    ['starter', 'Starter', 5, 3495, 'Entrada ideal para testar impulsos com desconto. R$ 6,99 por ZapCoin.', 0, 2],
    ['bronze', 'Bronze', 10, 6490, 'Mais alcance por menos. R$ 6,49 por ZapCoin.', 0, 3],
    ['profissional', 'Profissional', 25, 14975, 'Pacote profissional/empresarial para divulgar grupos com frequência. R$ 5,99 por ZapCoin.', 1, 4],
    ['empresarial', 'Empresarial', 50, 27450, 'Pacote empresarial para operações com vários grupos e impulsos recorrentes. R$ 5,49 por ZapCoin.', 0, 5],
    ['empresarial-plus', 'Empresarial Plus', 100, 49900, 'Pacote empresarial avançado com o melhor custo por ZapCoin. R$ 4,99 por ZapCoin.', 0, 6]
  ];

  try {
    for (const pacote of pacotesZapCoin) {
      _db.run(`
        INSERT OR IGNORE INTO zapcoin_packages
          (codigo, nome, coins, preco_centavos, descricao, destaque, ordem)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, pacote);

      _db.run(`
        UPDATE zapcoin_packages
        SET nome = ?, coins = ?, preco_centavos = ?, descricao = ?, destaque = ?, ordem = ?, ativo = 1
        WHERE codigo = ?
      `, [pacote[1], pacote[2], pacote[3], pacote[4], pacote[5], pacote[6], pacote[0]]);
    }

    _db.run(`
      UPDATE zapcoin_packages
      SET ativo = 0
      WHERE codigo NOT IN ('avulso', 'starter', 'bronze', 'profissional', 'empresarial', 'empresarial-plus')
    `);

    saveDb();
    console.log('[db] ZapCoin: pacotes e preços verificados.');
  } catch (err) {
    console.error('[db] Erro ao inserir pacotes ZapCoin:', err.message);
  }
}

function query(sql, params = []) {
  if (!_db) throw new Error('Banco não inicializado');
  const stmt = _db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  if (!_db) throw new Error('Banco não inicializado');
  _db.run(sql, params);
  const result = query('SELECT last_insert_rowid() as id');
  const id = result[0]?.id;
  saveDb();
  return id;
}

module.exports = { getDb, query, queryOne, run };