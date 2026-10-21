const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const DB_PATH = process.env.VERCEL
  ? path.join("/tmp", "mercadoos.db")
  : path.join(__dirname, "..", "data", "mercadoos.db");

let db;
let dbInstance = null;

function persist() {
  if (!db) return;
  try {
    const data = db.export();
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error("Error al persistir DB:", err);
  }
}

function exec(sql) {
  db.run(sql);
}

function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function lastId() {
  return get("SELECT last_insert_rowid() AS id").id;
}

function createSchema() {
  exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY,
      clave TEXT UNIQUE NOT NULL,
      nombre TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      usuario TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      rol_id INTEGER NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (rol_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_barras TEXT UNIQUE NOT NULL,
      nombre TEXT NOT NULL,
      categoria_id INTEGER,
      unidad TEXT NOT NULL DEFAULT 'unidad',
      precio_venta REAL NOT NULL,
      costo REAL NOT NULL DEFAULT 0,
      impuesto REAL NOT NULL DEFAULT 0.15,
      stock REAL NOT NULL DEFAULT 0,
      stock_minimo REAL NOT NULL DEFAULT 5,
      activo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (categoria_id) REFERENCES categorias(id)
    );

    CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      usuario_id INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      impuesto REAL NOT NULL,
      descuento REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      metodo_pago TEXT NOT NULL,
      recibido REAL,
      cambio REAL,
      estado TEXT NOT NULL DEFAULT 'completada',
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    );

    CREATE TABLE IF NOT EXISTS detalle_ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      cantidad REAL NOT NULL,
      precio_unitario REAL NOT NULL,
      impuesto REAL NOT NULL,
      subtotal REAL NOT NULL,
      FOREIGN KEY (venta_id) REFERENCES ventas(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    );

    CREATE TABLE IF NOT EXISTS movimientos_inventario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      cantidad REAL NOT NULL,
      stock_anterior REAL NOT NULL,
      stock_nuevo REAL NOT NULL,
      referencia TEXT,
      usuario_id INTEGER,
      fecha TEXT NOT NULL,
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    );
  `);
}

async function init() {
  if (dbInstance) {
    return dbInstance;
  }

  const wasmCandidates = [
    path.join(__dirname, "sql-wasm.wasm"),
    path.join(process.cwd(), "src", "sql-wasm.wasm"),
    path.join(path.dirname(require.resolve("sql.js")), "sql-wasm.wasm")
  ];
  let wasmBinary = null;
  for (const candidate of wasmCandidates) {
    if (fs.existsSync(candidate)) {
      wasmBinary = fs.readFileSync(candidate);
      break;
    }
  }

  const SQL = wasmBinary
    ? await initSqlJs({ wasmBinary })
    : await initSqlJs();

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    createSchema();
  } else {
    const bundledDbCandidates = [
      path.join(__dirname, "..", "data", "mercadoos.db"),
      path.join(process.cwd(), "data", "mercadoos.db")
    ];
    let loaded = false;
    for (const c of bundledDbCandidates) {
      if (fs.existsSync(c)) {
        try {
          db = new SQL.Database(fs.readFileSync(c));
          createSchema();
          loaded = true;
          break;
        } catch (e) {
          console.warn("No se pudo cargar la base empaquetada:", e);
        }
      }
    }
    if (!loaded) {
      db = new SQL.Database();
      createSchema();
    }
    persist();
  }

  dbInstance = {
    db,
    persist,
    run,
    all,
    get,
    lastId,
    exec,
    transaction(fn) {
      run("BEGIN");
      try {
        const result = fn();
        run("COMMIT");
        persist();
        return result;
      } catch (error) {
        run("ROLLBACK");
        throw error;
      }
    }
  };
  return dbInstance;
}

module.exports = { init, DB_PATH };
