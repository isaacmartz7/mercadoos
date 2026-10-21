const bcrypt = require("bcryptjs");

function seedIfEmpty(database) {
  const { get, run, lastId, persist } = database;
  if (get("SELECT COUNT(*) AS n FROM usuarios").n > 0) return;

  const roles = [
    [1, "admin", "Administrador"],
    [2, "cajero", "Cajero"],
    [3, "bodeguero", "Bodeguero"],
    [4, "gerente", "Gerente"]
  ];
  for (const [id, clave, nombre] of roles) {
    run("INSERT INTO roles (id, clave, nombre) VALUES (?, ?, ?)", [id, clave, nombre]);
  }

  const users = [
    ["Ana López", "admin", "admin123", 1],
    ["Carlos Pérez", "cajero", "cajero123", 2],
    ["María Gómez", "bodeguero", "bodeguero123", 3],
    ["Luis Fernández", "gerente", "gerente123", 4]
  ];
  for (const [nombre, usuario, password, rolId] of users) {
    run(
      "INSERT INTO usuarios (nombre, usuario, password_hash, rol_id) VALUES (?, ?, ?, ?)",
      [nombre, usuario, bcrypt.hashSync(password, 10), rolId]
    );
  }

  const categorias = ["Abarrotes", "Lácteos", "Bebidas", "Limpieza", "Panadería", "Cárnicos"];
  for (const nombre of categorias) {
    run("INSERT INTO categorias (nombre) VALUES (?)", [nombre]);
  }

  const catId = (nombre) => get("SELECT id FROM categorias WHERE nombre = ?", [nombre]).id;

  const productos = [
    ["7501000100019", "Arroz blanco 5 lb", "Abarrotes", "unidad", 48.5, 36, 0.15, 40, 10],
    ["7501000100026", "Frijol rojo 2 lb", "Abarrotes", "unidad", 32.0, 22, 0.15, 28, 8],
    ["7501000100033", "Azúcar 2 lb", "Abarrotes", "unidad", 26.5, 18, 0.15, 35, 10],
    ["7501000100040", "Aceite vegetal 1 L", "Abarrotes", "unidad", 42.0, 30, 0.15, 22, 6],
    ["7501000100057", "Café molido 400 g", "Abarrotes", "unidad", 78.0, 55, 0.15, 18, 5],
    ["7501000100064", "Leche entera 1 L", "Lácteos", "unidad", 28.0, 20, 0.15, 4, 12],
    ["7501000100071", "Queso fresco lb", "Lácteos", "lb", 55.0, 38, 0.15, 15, 5],
    ["7501000100088", "Huevos docena", "Lácteos", "unidad", 42.0, 30, 0.15, 20, 6],
    ["7501000100095", "Agua 1.5 L", "Bebidas", "unidad", 18.0, 10, 0.15, 60, 15],
    ["7501000100101", "Refresco 3 L", "Bebidas", "unidad", 38.0, 26, 0.15, 25, 8],
    ["7501000100118", "Jabón en barra", "Limpieza", "unidad", 15.0, 9, 0.15, 40, 10],
    ["7501000100125", "Detergente 1 kg", "Limpieza", "unidad", 52.0, 36, 0.15, 16, 6],
    ["7501000100132", "Papel higiénico 4 rollos", "Limpieza", "unidad", 46.0, 32, 0.15, 24, 8],
    ["7501000100149", "Pan molde", "Panadería", "unidad", 36.0, 24, 0.15, 12, 6],
    ["7501000100156", "Pechuga de pollo lb", "Cárnicos", "lb", 62.0, 45, 0.15, 10, 4]
  ];

  for (const [codigo, nombre, cat, unidad, precio, costo, impuesto, stock, min] of productos) {
    run(
      `INSERT INTO productos
        (codigo_barras, nombre, categoria_id, unidad, precio_venta, costo, impuesto, stock, stock_minimo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [codigo, nombre, catId(cat), unidad, precio, costo, impuesto, stock, min]
    );
    const productoId = lastId();
    run(
      `INSERT INTO movimientos_inventario
        (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
       VALUES (?, 'entrada', ?, 0, ?, 'carga inicial', 1, datetime('now','localtime'))`,
      [productoId, stock, stock]
    );
  }

  persist();
}

module.exports = { seedIfEmpty };
