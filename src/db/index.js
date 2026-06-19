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
  return _db;
}

function saveDb() {
  if (!_db) return;
  const buffer = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buffer));
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
  saveDb();
  const result = query('SELECT last_insert_rowid() as id');
  return result[0]?.id;
}

module.exports = { getDb, query, queryOne, run };
