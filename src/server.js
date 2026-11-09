const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const config = require("./config");
const { init, all, get, run, lastId, persist, transaction } = require("./db");
const { seedIfEmpty, ensureSuperuser } = require("./seed");
const { filtroDePeriodo, cargarReportes, interpretar } = require("./asistente");

const PERMS = {
  caja: ["admin", "cajero", "gerente"],
  productos: ["admin", "bodeguero", "gerente"],
  inventario: ["admin", "bodeguero", "gerente"],
  inventarioAjuste: ["admin", "bodeguero"],
  ventas: ["admin", "cajero", "gerente"],
  devoluciones: ["admin", "cajero", "gerente"],
  reportes: ["admin", "gerente"],
  asistente: ["admin", "gerente", "bodeguero"],
  usuarios: ["admin"],
  anular: ["admin"]
};

function isSuperuser(user) {
  return Boolean(user && user.rol === "superusuario");
}

function can(user, perm) {
  if (!user) return false;
  if (isSuperuser(user)) return true;
  return Boolean(PERMS[perm] && PERMS[perm].includes(user.rol));
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect("/login");
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!can(req.session.user, perm)) {
      return res.status(403).render("error", {
        title: "Sin permiso",
        mensaje: "Tu rol no puede entrar a esta sección."
      });
    }
    next();
  };
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function productoFromBody(body, stockActual) {
  const codigo = String(body.codigo_barras || "").trim();
  const nombre = String(body.nombre || "").trim();
  const unidades = ["unidad", "lb", "kg", "litro"];
  const unidad = unidades.includes(body.unidad) ? body.unidad : "unidad";
  const precio = Number(body.precio_venta);
  const costo = Number(body.costo) || 0;
  const impuesto = body.impuesto === undefined || body.impuesto === ""
    ? config.negocio.impuestoDefault
    : Number(body.impuesto);
  const stock = stockActual == null ? Number(body.stock) || 0 : Number(stockActual);
  const stockMin = Number(body.stock_minimo);
  const categoriaId = Number(body.categoria_id) || null;
  if (!codigo || !nombre || !Number.isFinite(precio) || precio < 0 || !Number.isFinite(stock) || stock < 0) {
    throw new Error("datos");
  }
  return [
    codigo,
    nombre,
    categoriaId,
    unidad,
    round2(precio),
    round2(Math.max(0, costo)),
    Number.isFinite(impuesto) && impuesto >= 0 ? impuesto : config.negocio.impuestoDefault,
    stock,
    Number.isFinite(stockMin) && stockMin >= 0 ? stockMin : 5
  ];
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function homeFor(user) {
  return user && user.rol === "cajero" ? "/caja" : "/";
}

function turnoAbierto(userId) {
  return get(
    `SELECT * FROM turnos WHERE usuario_id=? AND estado='abierto' ORDER BY id DESC LIMIT 1`,
    [userId]
  );
}

function montoNeto(alias) {
  const estado = alias ? `${alias}.estado` : "estado";
  const total = alias ? `${alias}.total` : "total";
  return `CASE WHEN ${estado}='devolucion' THEN -${total} ELSE ${total} END`;
}

function resumenMetodo(turno, metodo) {
  return get(
    `SELECT
       COALESCE(SUM(CASE WHEN estado='completada' THEN total ELSE 0 END), 0) AS cobrado,
       COALESCE(SUM(CASE WHEN estado='devolucion' THEN total ELSE 0 END), 0) AS devuelto,
       COALESCE(SUM(CASE WHEN estado='completada' THEN 1 ELSE 0 END), 0) AS tickets
     FROM ventas
     WHERE usuario_id=? AND metodo_pago=? AND fecha >= ?
       AND estado IN ('completada','devolucion')`,
    [turno.usuario_id, metodo, turno.apertura]
  );
}

function resumenTurno(turno) {
  if (!turno) return null;
  const efectivo = resumenMetodo(turno, "efectivo");
  const tarjeta = resumenMetodo(turno, "tarjeta");
  const ventasEfectivo = round2(efectivo.cobrado - efectivo.devuelto);
  return {
    id: turno.id,
    apertura: turno.apertura,
    fondo: round2(turno.fondo),
    efectivoCobrado: round2(efectivo.cobrado),
    efectivoDevuelto: round2(efectivo.devuelto),
    ventasEfectivo,
    ticketsEfectivo: efectivo.tickets,
    ventasTarjeta: round2(tarjeta.cobrado - tarjeta.devuelto),
    tarjetaCobrada: round2(tarjeta.cobrado),
    tarjetaDevuelta: round2(tarjeta.devuelto),
    ticketsTarjeta: tarjeta.tickets,
    esperado: round2(turno.fondo + ventasEfectivo),
    nombreCajero: String(turno.nombre_cajero || "").trim()
  };
}

function disponibleDevolucion(productoId) {
  const row = get(
    `SELECT COALESCE(SUM(
       CASE
         WHEN v.estado='completada' THEN d.cantidad
         WHEN v.estado='devolucion' THEN -d.cantidad
         ELSE 0
       END
     ), 0) AS neto
     FROM detalle_ventas d
     JOIN ventas v ON v.id = d.venta_id
     WHERE d.producto_id=?`,
    [productoId]
  );
  return round2(row.neto);
}

function displayNameFor(user) {
  if (!user) return "";
  const abierto = turnoAbierto(user.id);
  if (abierto && abierto.nombre_cajero) return String(abierto.nombre_cajero).trim();
  return user.usuario || user.nombre || "";
}

const app = express();
app.set("trust proxy", 1);
function findPath(subDir) {
  const candidates = [
    path.join(__dirname, "..", subDir),
    path.join(process.cwd(), subDir),
    path.join(__dirname, subDir),
    path.join("/var/task", subDir)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(process.cwd(), subDir);
}

const viewsPath = findPath("views");
app.set("views", viewsPath);
app.set("view engine", "ejs");

const publicPath = findPath("public");
app.use("/static", express.static(publicPath));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const isVercel = Boolean(process.env.VERCEL);
const publicConfig = { negocio: config.negocio };
app.use(
  cookieSession({
    name: "mercadoos_session",
    keys: [config.sessionSecret],
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    sameSite: "lax",
    secure: isVercel || process.env.COOKIE_SECURE === "1",
    path: "/"
  })
);

let dbInitPromise = null;
function ensureDb() {
  if (!dbInitPromise) {
    dbInitPromise = init().then((database) => {
      seedIfEmpty(database);
      ensureSuperuser(database);
      return database;
    });
  }
  return dbInitPromise;
}

app.use((req, res, next) => {
  ensureDb()
    .then(() => next())
    .catch((err) => {
      console.error("Error inicializando base de datos:", err);
      res.status(500).send(`
        <div style="font-family: sans-serif; padding: 2rem;">
          <h2>Error al conectar con la base de datos</h2>
          <p>Revisa el archivo de datos o vuelve a iniciar el sistema.</p>
        </div>
      `);
    });
});

  app.use((req, res, next) => {
    if (!req.session) req.session = {};
    res.locals.user = req.session.user
      ? { ...req.session.user, nombre: displayNameFor(req.session.user) }
      : null;
    res.locals.config = publicConfig;
    res.locals.can = (perm) => can(req.session.user, perm);
    res.locals.flash = req.session.flash || null;
    res.locals.money = money;
    const p = req.path;
    res.locals.nav =
      p === "/" ? "inicio" :
      p.startsWith("/caja") ? "caja" :
      p.startsWith("/inventario") || /\/productos\/\d+\/editar/.test(p) ? "inventario" :
      p.startsWith("/ventas") ? "ventas" :
      p.startsWith("/asistente") || p.startsWith("/reportes") ? "asistente" :
      p.startsWith("/usuarios") ? "usuarios" : "";
    delete req.session.flash;
    next();
  });

  function flash(req, tipo, texto) {
    req.session.flash = { tipo, texto };
  }

  app.get("/presentacion", (req, res) => {
    const docsPath = findPath("docs");
    res.sendFile(path.join(docsPath, "presentacion.html"));
  });

  const loginAttempts = new Map();
  function loginKey(req) {
    return String(req.ip || req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  }
  function loginBlocked(key) {
    const rec = loginAttempts.get(key);
    if (!rec) return false;
    if (Date.now() > rec.until) {
      loginAttempts.delete(key);
      return false;
    }
    return rec.count >= 8;
  }
  function loginFail(key) {
    const rec = loginAttempts.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
    rec.count += 1;
    rec.until = Date.now() + 15 * 60 * 1000;
    loginAttempts.set(key, rec);
  }

  app.get("/login", (req, res) => {
    if (req.session.user) return res.redirect(homeFor(req.session.user));
    res.render("login", { title: "Iniciar sesión", error: null });
  });

  app.post("/login", (req, res) => {
    const key = loginKey(req);
    if (loginBlocked(key)) {
      return res.status(429).render("login", {
        title: "Iniciar sesión",
        error: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo."
      });
    }
    const usuario = String(req.body.usuario || "").trim();
    const password = String(req.body.password || "");
    const row = get(
      `SELECT u.*, r.clave AS rol, r.nombre AS rol_nombre
       FROM usuarios u JOIN roles r ON r.id = u.rol_id
       WHERE u.usuario = ? AND u.activo = 1`,
      [usuario]
    );
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      loginFail(key);
      return res.status(401).render("login", {
        title: "Iniciar sesión",
        error: "Usuario o contraseña incorrectos."
      });
    }
    loginAttempts.delete(key);
    req.session.user = {
      id: row.id,
      nombre: row.nombre,
      usuario: row.usuario,
      rol: row.rol,
      rolNombre: row.rol_nombre
    };
    res.redirect(303, homeFor(req.session.user));
  });

  function clearSession(res) {
    res.clearCookie("mercadoos_session");
    res.clearCookie("mercadoos_session.sig");
  }

  app.post("/logout", requireAuth, (req, res) => {
    req.session = null;
    clearSession(res);
    res.redirect(303, "/login");
  });
  app.get("/logout", (req, res) => {
    res.redirect(303, req.session && req.session.user ? homeFor(req.session.user) : "/login");
  });

  app.get("/", requireAuth, (req, res) => {
    if (req.session.user.rol === "cajero") return res.redirect("/caja");
    const ventasHoy = get(
      `SELECT
         COALESCE(SUM(CASE WHEN estado='completada' THEN 1 ELSE 0 END), 0) AS n,
         COALESCE(SUM(${montoNeto()}), 0) AS total
       FROM ventas
       WHERE date(fecha)=date('now','localtime') AND estado IN ('completada','devolucion')`
    );
    const stockBajo = all(
      `SELECT p.*, c.nombre AS categoria
       FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.activo=1 AND p.stock <= p.stock_minimo
       ORDER BY p.stock ASC LIMIT 8`
    );
    const top = all(
      `SELECT p.nombre,
         SUM(CASE WHEN v.estado='devolucion' THEN -d.cantidad ELSE d.cantidad END) AS cantidad,
         SUM(CASE WHEN v.estado='devolucion' THEN -d.subtotal ELSE d.subtotal END) AS total
       FROM detalle_ventas d
       JOIN ventas v ON v.id = d.venta_id
       JOIN productos p ON p.id = d.producto_id
       WHERE v.estado IN ('completada','devolucion') AND date(v.fecha)=date('now','localtime')
       GROUP BY p.id
       HAVING cantidad > 0
       ORDER BY cantidad DESC LIMIT 5`
    );
    const productosN = get("SELECT COUNT(*) AS n FROM productos WHERE activo=1").n;
    res.render("dashboard", {
      title: "Inicio",
      ventasHoy,
      stockBajo,
      top,
      productosN
    });
  });

  app.get("/productos", requireAuth, (req, res) => {
    res.redirect("/inventario");
  });

  app.get("/productos/nuevo", requireAuth, (req, res) => {
    res.redirect("/inventario");
  });

  app.post("/productos/nuevo", requireAuth, requirePerm("productos"), (req, res) => {
    try {
      const data = productoFromBody(req.body);
      run(
        `INSERT INTO productos
          (codigo_barras, nombre, categoria_id, unidad, precio_venta, costo, impuesto, stock, stock_minimo, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        data
      );
      const id = lastId();
      run(
        `INSERT INTO movimientos_inventario
          (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
         VALUES (?, 'entrada', ?, 0, ?, 'alta de producto', ?, datetime('now','localtime'))`,
        [id, data[7], data[7], req.session.user.id]
      );
      persist();
      flash(req, "ok", "Producto creado.");
      res.redirect("/inventario");
    } catch (error) {
      flash(req, "error", "No se pudo crear. Revisa código de barras duplicado y datos.");
      res.redirect("/inventario");
    }
  });

  app.get("/productos/:id/editar", requireAuth, requirePerm("productos"), (req, res) => {
    const producto = get("SELECT * FROM productos WHERE id=?", [req.params.id]);
    if (!producto) return res.status(404).render("error", { title: "No encontrado", mensaje: "Producto inexistente." });
    res.render("producto-form", {
      title: "Editar producto",
      producto,
      categorias: all("SELECT * FROM categorias ORDER BY nombre")
    });
  });

  app.post("/productos/:id/editar", requireAuth, requirePerm("productos"), (req, res) => {
    const actual = get("SELECT * FROM productos WHERE id=?", [req.params.id]);
    if (!actual) return res.redirect("/inventario");
    try {
      const d = productoFromBody(req.body, actual.stock);
      const activo = req.body.activo ? 1 : 0;
      run(
        `UPDATE productos SET codigo_barras=?, nombre=?, categoria_id=?, unidad=?,
          precio_venta=?, costo=?, impuesto=?, stock_minimo=?, activo=? WHERE id=?`,
        [d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[8], activo, actual.id]
      );
      persist();
      flash(req, "ok", "Producto actualizado.");
      res.redirect("/inventario");
    } catch (error) {
      flash(req, "error", "No se pudo actualizar el producto.");
      res.redirect(`/productos/${actual.id}/editar`);
    }
  });

  app.get("/inventario", requireAuth, requirePerm("inventario"), (req, res) => {
    const productos = all(
      `SELECT p.*, c.nombre AS categoria
       FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
       ORDER BY p.activo DESC, p.nombre`
    );
    const movimientos = all(
      `SELECT m.*, p.nombre AS producto, u.nombre AS usuario
       FROM movimientos_inventario m
       JOIN productos p ON p.id = m.producto_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       ORDER BY m.id DESC LIMIT 40`
    );
    res.render("inventario", {
      title: "Inventario",
      productos,
      movimientos,
      puedeAjustar: can(req.session.user, "inventarioAjuste"),
      productosAjuste: productos.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        codigo: p.codigo_barras,
        stock: p.stock,
        unidad: p.unidad
      }))
    });
  });

  app.post("/inventario/ajuste", requireAuth, requirePerm("inventarioAjuste"), (req, res) => {
    const productoId = Number(req.body.producto_id);
    const cantidad = Number(req.body.cantidad);
    const motivo = String(req.body.motivo || "ajuste").slice(0, 80);
    const producto = get("SELECT * FROM productos WHERE id=?", [productoId]);
    if (!producto || !Number.isFinite(cantidad) || cantidad === 0) {
      flash(req, "error", "Ajuste inválido.");
      return res.redirect("/inventario");
    }
    const nuevo = round2(producto.stock + cantidad);
    if (nuevo < 0) {
      flash(req, "error", "El stock no puede quedar negativo.");
      return res.redirect("/inventario");
    }
    transaction(() => {
      run("UPDATE productos SET stock=? WHERE id=?", [nuevo, producto.id]);
      run(
        `INSERT INTO movimientos_inventario
          (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
         VALUES (?, 'ajuste', ?, ?, ?, ?, ?, datetime('now','localtime'))`,
        [producto.id, cantidad, producto.stock, nuevo, motivo, req.session.user.id]
      );
    });
    flash(req, "ok", "Inventario actualizado.");
    res.redirect("/inventario");
  });

  app.get("/caja", requireAuth, requirePerm("caja"), (req, res) => {
    const turno = resumenTurno(turnoAbierto(req.session.user.id));
    const ultima = get(
      "SELECT id FROM ventas WHERE usuario_id=? ORDER BY id DESC LIMIT 1",
      [req.session.user.id]
    );
    res.render("caja", {
      title: "Caja",
      turno,
      ultimaVentaId: ultima ? ultima.id : null
    });
  });

  app.get("/api/turno", requireAuth, requirePerm("caja"), (req, res) => {
    res.json({ turno: resumenTurno(turnoAbierto(req.session.user.id)) });
  });

  app.post("/api/turno/abrir", requireAuth, requirePerm("caja"), (req, res) => {
    const fondo = Number(req.body.fondo);
    const nombreCajero = String(req.body.nombre_cajero || "").trim().slice(0, 80);
    if (!Number.isFinite(fondo) || fondo < 0) {
      return res.status(400).json({ error: "El fondo inicial no es válido." });
    }
    if (!nombreCajero) {
      return res.status(400).json({ error: "Escribe quién cobra en este turno." });
    }
    if (turnoAbierto(req.session.user.id)) {
      return res.status(400).json({ error: "Ya tienes un turno abierto." });
    }
    const id = transaction(() => {
      run(
        `INSERT INTO turnos (usuario_id, apertura, fondo, estado, nombre_cajero)
         VALUES (?, datetime('now','localtime'), ?, 'abierto', ?)`,
        [req.session.user.id, round2(fondo), nombreCajero]
      );
      return lastId();
    });
    const turno = get("SELECT * FROM turnos WHERE id=?", [id]);
    res.json({ ok: true, turno: resumenTurno(turno) });
  });

  app.post("/api/turno/cerrar", requireAuth, requirePerm("caja"), (req, res) => {
    const contado = Number(req.body.contado);
    const abierto = turnoAbierto(req.session.user.id);
    if (!abierto) return res.status(400).json({ error: "No hay un turno abierto." });
    if (!Number.isFinite(contado) || contado < 0) {
      return res.status(400).json({ error: "El efectivo contado no es válido." });
    }
    const resumen = resumenTurno(abierto);
    const contadoRedondo = round2(contado);
    const diferencia = round2(contadoRedondo - resumen.esperado);
    transaction(() => {
      run(
        `UPDATE turnos
         SET cierre=datetime('now','localtime'), ventas_efectivo=?, esperado=?, contado=?, diferencia=?, estado='cerrado'
         WHERE id=?`,
        [resumen.ventasEfectivo, resumen.esperado, contadoRedondo, diferencia, abierto.id]
      );
    });
    res.json({
      ok: true,
      cierre: {
        fondo: resumen.fondo,
        ventasEfectivo: resumen.ventasEfectivo,
        esperado: resumen.esperado,
        contado: contadoRedondo,
        diferencia
      }
    });
  });

  app.get("/api/productos", requireAuth, requirePerm("caja"), (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);
    const rows = all(
      `SELECT p.id, p.codigo_barras, p.nombre, p.unidad, p.precio_venta, p.impuesto, p.stock
       FROM productos p
       WHERE p.activo=1 AND (p.codigo_barras = ? OR p.nombre LIKE ? OR p.codigo_barras LIKE ?)
       ORDER BY CASE
         WHEN p.codigo_barras = ? THEN 0
         WHEN p.nombre LIKE ? THEN 1
         WHEN p.codigo_barras LIKE ? THEN 2
         ELSE 3
       END, p.nombre
       LIMIT 20`,
      [q, `%${q}%`, `%${q}%`, q, `${q}%`, `${q}%`]
    );
    res.json(rows);
  });

  app.post("/api/productos", requireAuth, requirePerm("caja"), (req, res) => {
    const nombre = String(req.body.nombre || "").trim().slice(0, 80);
    let codigo = String(req.body.codigo_barras || "").trim().slice(0, 40);
    const precio = Number(req.body.precio_venta);
    const stock = Number(req.body.stock);
    if (!nombre) return res.status(400).json({ error: "Escribe el nombre del producto." });
    if (!Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: "Escribe el precio de venta." });
    if (!Number.isFinite(stock) || stock <= 0) return res.status(400).json({ error: "El stock tiene que ser mayor a 0 para venderlo ahora." });
    if (!codigo) codigo = `C${Date.now()}`;
    if (get("SELECT id FROM productos WHERE codigo_barras=?", [codigo])) {
      return res.status(400).json({ error: "Ese código ya existe. Búscalo o usa otro." });
    }
    const categoria = get("SELECT id FROM categorias ORDER BY id LIMIT 1");
    try {
      const id = transaction(() => {
        run(
          `INSERT INTO productos
            (codigo_barras, nombre, categoria_id, unidad, precio_venta, costo, impuesto, stock, stock_minimo, activo)
           VALUES (?, ?, ?, 'unidad', ?, 0, ?, ?, 5, 1)`,
          [codigo, nombre, categoria ? categoria.id : null, round2(precio), config.negocio.impuestoDefault, stock]
        );
        const nuevoId = lastId();
        run(
          `INSERT INTO movimientos_inventario
            (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
           VALUES (?, 'entrada', ?, 0, ?, 'alta desde caja', ?, datetime('now','localtime'))`,
          [nuevoId, stock, stock, req.session.user.id]
        );
        return nuevoId;
      });
      const producto = get(
        `SELECT id, codigo_barras, nombre, unidad, precio_venta, impuesto, stock
         FROM productos WHERE id=?`,
        [id]
      );
      res.json(producto);
    } catch (error) {
      res.status(400).json({ error: "No se pudo crear el producto." });
    }
  });

  app.post("/api/ventas", requireAuth, requirePerm("caja"), (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const metodo = req.body.metodo_pago === "tarjeta" ? "tarjeta" : "efectivo";
    const descuento = Math.max(0, Number(req.body.descuento) || 0);
    const recibido = Number(req.body.recibido);
    if (!items.length) return res.status(400).json({ error: "La venta no tiene productos." });
    const turnoVenta = turnoAbierto(req.session.user.id);
    if (!turnoVenta) {
      return res.status(400).json({ error: "Abre el turno antes de cobrar." });
    }
    const nombreCajero = String(turnoVenta.nombre_cajero || "").trim();
    if (!nombreCajero) {
      return res.status(400).json({ error: "Cierra el turno y ábrelo de nuevo con tu nombre." });
    }

    try {
      const venta = transaction(() => {
        let subtotal = 0;
        let impuesto = 0;
        const lineas = [];

        for (const item of items) {
          const producto = get("SELECT * FROM productos WHERE id=? AND activo=1", [item.id]);
          const cantidad = Number(item.cantidad);
          if (!producto || !Number.isFinite(cantidad) || cantidad <= 0) {
            throw new Error("Producto o cantidad inválida.");
          }
          if (producto.stock < cantidad) {
            throw new Error(`Stock insuficiente de ${producto.nombre}. Hay ${producto.stock}.`);
          }
          const lineaSub = round2(producto.precio_venta * cantidad);
          const lineaImp = round2(lineaSub * producto.impuesto);
          subtotal = round2(subtotal + lineaSub);
          impuesto = round2(impuesto + lineaImp);
          lineas.push({ producto, cantidad, lineaSub, lineaImp });
        }

        const total = round2(Math.max(0, subtotal + impuesto - descuento));
        let cambio = 0;
        let recibidoGuardar = total;
        if (metodo === "efectivo") {
          if (!Number.isFinite(recibido) || recibido < total) {
            throw new Error("El efectivo recibido no cubre el total.");
          }
          recibidoGuardar = round2(recibido);
          cambio = round2(recibido - total);
        }

        run(
          `INSERT INTO ventas
            (fecha, usuario_id, subtotal, impuesto, descuento, total, metodo_pago, recibido, cambio, estado, cajero_nombre)
           VALUES (datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, 'completada', ?)`,
          [req.session.user.id, subtotal, impuesto, descuento, total, metodo, recibidoGuardar, cambio, nombreCajero]
        );
        const id = lastId();
        for (const linea of lineas) {
          run(
            `INSERT INTO detalle_ventas
              (venta_id, producto_id, cantidad, precio_unitario, impuesto, subtotal)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, linea.producto.id, linea.cantidad, linea.producto.precio_venta, linea.lineaImp, linea.lineaSub]
          );
          const nuevo = round2(linea.producto.stock - linea.cantidad);
          run("UPDATE productos SET stock=? WHERE id=?", [nuevo, linea.producto.id]);
          run(
            `INSERT INTO movimientos_inventario
              (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
             VALUES (?, 'venta', ?, ?, ?, ?, ?, datetime('now','localtime'))`,
            [linea.producto.id, -linea.cantidad, linea.producto.stock, nuevo, `venta #${id}`, req.session.user.id]
          );
        }
        return { id, total, cambio, metodo };
      });
      res.json({
        ok: true,
        ventaId: venta.id,
        total: venta.total,
        cambio: venta.cambio,
        metodo: venta.metodo
      });
    } catch (error) {
      res.status(400).json({ error: error.message || "No se pudo completar la venta." });
    }
  });

  app.post("/api/devoluciones", requireAuth, requirePerm("devoluciones"), (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const metodo = req.body.metodo_pago === "tarjeta" ? "tarjeta" : "efectivo";
    if (!items.length) return res.status(400).json({ error: "La devolución no tiene productos." });
    if (items.length > 40) return res.status(400).json({ error: "La devolución tiene demasiados productos." });
    const turnoDev = turnoAbierto(req.session.user.id);
    if (!turnoDev) {
      return res.status(400).json({ error: "Abre el turno antes de devolver." });
    }
    const nombreCajero = String(turnoDev.nombre_cajero || "").trim();
    if (!nombreCajero) {
      return res.status(400).json({ error: "Cierra el turno y ábrelo de nuevo con tu nombre." });
    }

    try {
      const venta = transaction(() => {
        const pedidos = new Map();
        for (const item of items) {
          const id = Number(item.id);
          const cantidad = round2(Number(item.cantidad));
          if (!Number.isFinite(id) || !Number.isFinite(cantidad) || cantidad <= 0) {
            throw new Error("Producto o cantidad inválida.");
          }
          if (cantidad > 9999) throw new Error("La cantidad a devolver es demasiado alta.");
          pedidos.set(id, round2((pedidos.get(id) || 0) + cantidad));
        }

        let subtotal = 0;
        let impuesto = 0;
        const lineas = [];
        for (const [productoId, cantidad] of pedidos) {
          if (cantidad > 9999) throw new Error("La cantidad a devolver es demasiado alta.");
          const producto = get("SELECT * FROM productos WHERE id=? AND activo=1", [productoId]);
          if (!producto) throw new Error("Producto o cantidad inválida.");
          const disponible = disponibleDevolucion(producto.id);
          if (disponible <= 0) {
            throw new Error(`No hay ventas de ${producto.nombre} para devolver.`);
          }
          if (cantidad > disponible + 0.001) {
            throw new Error(`Solo puedes devolver ${disponible} de ${producto.nombre}.`);
          }
          const lineaSub = round2(producto.precio_venta * cantidad);
          const lineaImp = round2(lineaSub * producto.impuesto);
          subtotal = round2(subtotal + lineaSub);
          impuesto = round2(impuesto + lineaImp);
          lineas.push({ producto, cantidad, lineaSub, lineaImp });
        }

        const total = round2(subtotal + impuesto);
        run(
          `INSERT INTO ventas
            (fecha, usuario_id, subtotal, impuesto, descuento, total, metodo_pago, recibido, cambio, estado, cajero_nombre)
           VALUES (datetime('now','localtime'), ?, ?, ?, 0, ?, ?, ?, 0, 'devolucion', ?)`,
          [req.session.user.id, subtotal, impuesto, total, metodo, total, nombreCajero]
        );
        const id = lastId();
        for (const linea of lineas) {
          run(
            `INSERT INTO detalle_ventas
              (venta_id, producto_id, cantidad, precio_unitario, impuesto, subtotal)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, linea.producto.id, linea.cantidad, linea.producto.precio_venta, linea.lineaImp, linea.lineaSub]
          );
          const nuevo = round2(linea.producto.stock + linea.cantidad);
          run("UPDATE productos SET stock=? WHERE id=?", [nuevo, linea.producto.id]);
          run(
            `INSERT INTO movimientos_inventario
              (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
             VALUES (?, 'devolucion', ?, ?, ?, ?, ?, datetime('now','localtime'))`,
            [
              linea.producto.id,
              linea.cantidad,
              linea.producto.stock,
              nuevo,
              `devolucion #${id}`,
              req.session.user.id
            ]
          );
        }
        return { id, total, metodo };
      });
      res.json({
        ok: true,
        devolucion: true,
        ventaId: venta.id,
        total: venta.total,
        cambio: 0,
        metodo: venta.metodo
      });
    } catch (error) {
      res.status(400).json({ error: error.message || "No se pudo registrar la devolución." });
    }
  });

  app.get("/ventas", requireAuth, requirePerm("ventas"), (req, res) => {
    const esCajero = req.session.user.rol === "cajero";
    const ventas = all(
      `SELECT v.*, COALESCE(NULLIF(v.cajero_nombre, ''), u.usuario) AS cajero
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
       ${esCajero ? "WHERE v.usuario_id=?" : ""}
       ORDER BY v.id DESC LIMIT 80`,
      esCajero ? [req.session.user.id] : []
    );
    res.render("ventas", { title: "Ventas", ventas });
  });

  app.get("/ventas/:id", requireAuth, requirePerm("ventas"), (req, res) => {
    const venta = get(
      `SELECT v.*, COALESCE(NULLIF(v.cajero_nombre, ''), u.usuario) AS cajero
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id WHERE v.id=?`,
      [req.params.id]
    );
    if (!venta) return res.status(404).render("error", { title: "No encontrada", mensaje: "Venta inexistente." });
    if (req.session.user.rol === "cajero" && venta.usuario_id !== req.session.user.id) {
      return res.status(403).render("error", { title: "Sin permiso", mensaje: "Solo puedes ver tus ventas." });
    }
    const detalle = all(
      `SELECT d.*, p.nombre, p.codigo_barras, p.unidad
       FROM detalle_ventas d JOIN productos p ON p.id = d.producto_id
       WHERE d.venta_id=?`,
      [venta.id]
    );
    res.render("venta-detalle", {
      title: venta.estado === "devolucion" ? `Devolución #${venta.id}` : `Venta #${venta.id}`,
      venta,
      detalle,
      imprimir: req.query.imprimir === "1"
    });
  });

  app.post("/ventas/:id/anular", requireAuth, requirePerm("anular"), (req, res) => {
    const venta = get("SELECT * FROM ventas WHERE id=?", [req.params.id]);
    if (!venta || venta.estado !== "completada") {
      flash(req, "error", "No se puede anular esa venta.");
      return res.redirect("/ventas");
    }
    try {
      transaction(() => {
        const detalle = all("SELECT * FROM detalle_ventas WHERE venta_id=?", [venta.id]);
        for (const linea of detalle) {
          const producto = get("SELECT * FROM productos WHERE id=?", [linea.producto_id]);
          const nuevo = round2(producto.stock + linea.cantidad);
          run("UPDATE productos SET stock=? WHERE id=?", [nuevo, producto.id]);
          run(
            `INSERT INTO movimientos_inventario
              (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
             VALUES (?, 'anulacion', ?, ?, ?, ?, ?, datetime('now','localtime'))`,
            [producto.id, linea.cantidad, producto.stock, nuevo, `anulación venta #${venta.id}`, req.session.user.id]
          );
        }
        run("UPDATE ventas SET estado='anulada' WHERE id=?", [venta.id]);
      });
      flash(req, "ok", `Venta #${venta.id} anulada y stock reingresado.`);
    } catch (error) {
      flash(req, "error", "No se pudo anular.");
    }
    res.redirect(`/ventas/${venta.id}`);
  });

  app.get("/reportes/csv", requireAuth, requirePerm("reportes"), (req, res) => {
    const rows = all(
      `SELECT v.id, v.fecha, v.estado, COALESCE(NULLIF(v.cajero_nombre, ''), u.usuario) AS cajero, v.metodo_pago, v.total
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.estado IN ('completada','devolucion') AND date(v.fecha)=date('now','localtime')
       ORDER BY v.id`
    );
    const lines = ["fecha,ticket,tipo,cajero,metodo,total"];
    for (const row of rows) {
      const signed = row.estado === "devolucion" ? -Number(row.total) : Number(row.total);
      lines.push(
        [
          row.fecha,
          row.id,
          row.estado === "devolucion" ? "Devolucion" : "Venta",
          row.cajero,
          row.metodo_pago === "tarjeta" ? "Tarjeta" : "Efectivo",
          money(signed)
        ]
          .map(csvCell)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="ventas-hoy.csv"');
    res.send(`\uFEFF${lines.join("\r\n")}`);
  });

  function volverAsistente(body) {
    const periodo = ["dia", "mes", "ano", "rango"].includes(body.periodo) ? body.periodo : "dia";
    const params = new URLSearchParams();
    params.set("periodo", periodo);
    if (periodo === "rango") {
      if (body.desde) params.set("desde", String(body.desde).slice(0, 10));
      if (body.hasta) params.set("hasta", String(body.hasta).slice(0, 10));
    }
    return `/asistente?${params.toString()}`;
  }

  function guardarChat(session, quien, texto) {
    const chat = Array.isArray(session.chat) ? session.chat.slice(-5) : [];
    chat.push({ quien, texto: String(texto || "").slice(0, 900) });
    session.chat = chat.slice(-6);
  }

  function aplicarAsistente(user, accion) {
    const producto = get("SELECT * FROM productos WHERE id=? AND activo=1", [accion.productoId]);
    if (!producto) return "Ese producto ya no está activo. No cambié nada.";
    const cantidad = round2(accion.cantidad);
    if (!Number.isFinite(cantidad)) return "La cantidad no es válida. No cambié nada.";

    if (accion.op === "entrada") {
      if (!can(user, "inventarioAjuste")) return "Tu rol no puede cambiar el stock. No cambié nada.";
      if (cantidad <= 0 || cantidad > 100000) return "La cantidad no es válida. No cambié nada.";
      const nuevo = round2(producto.stock + cantidad);
      transaction(() => {
        run("UPDATE productos SET stock=? WHERE id=?", [nuevo, producto.id]);
        run(
          `INSERT INTO movimientos_inventario
            (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
           VALUES (?, 'entrada', ?, ?, ?, 'entrada asistente', ?, datetime('now','localtime'))`,
          [producto.id, cantidad, producto.stock, nuevo, user.id]
        );
      });
      return `Listo. ${producto.nombre} quedó en ${money(nuevo)} ${producto.unidad} (antes ${money(producto.stock)}). Anoté la entrada de ${money(cantidad)}.`;
    }

    if (accion.op === "ajuste") {
      if (!can(user, "inventarioAjuste")) return "Tu rol no puede cambiar el stock. No cambié nada.";
      if (cantidad < 0 || cantidad > 100000) return "El stock pedido no es válido. No cambié nada.";
      const delta = round2(cantidad - producto.stock);
      if (delta === 0) {
        return `${producto.nombre} sigue en ${money(producto.stock)} ${producto.unidad}. No hice un movimiento.`;
      }
      transaction(() => {
        run("UPDATE productos SET stock=? WHERE id=?", [cantidad, producto.id]);
        run(
          `INSERT INTO movimientos_inventario
            (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
           VALUES (?, 'ajuste', ?, ?, ?, 'ajuste asistente', ?, datetime('now','localtime'))`,
          [producto.id, delta, producto.stock, cantidad, user.id]
        );
      });
      return `Listo. ${producto.nombre} quedó en ${money(cantidad)} ${producto.unidad} (antes ${money(producto.stock)}).`;
    }

    if (accion.op === "devolucion") {
      if (!can(user, "devoluciones")) return "Tu rol no puede registrar devoluciones. No cambié nada.";
      if (cantidad <= 0 || cantidad > 9999) return "La cantidad no es válida. No cambié nada.";
      const turno = turnoAbierto(user.id);
      const nombreCajero = turno ? String(turno.nombre_cajero || "").trim() : "";
      if (!turno || !nombreCajero) {
        return "No hay un turno abierto a tu nombre. No registré la devolución para no descuadrar la caja.";
      }
      const disponible = disponibleDevolucion(producto.id);
      if (disponible <= 0 || cantidad > disponible + 0.001) {
        return `Solo puedes devolver ${money(disponible)} de ${producto.nombre}. No cambié nada.`;
      }
      const lineaSub = round2(producto.precio_venta * cantidad);
      const lineaImp = round2(lineaSub * producto.impuesto);
      const total = round2(lineaSub + lineaImp);
      const nuevo = round2(producto.stock + cantidad);
      const id = transaction(() => {
        run(
          `INSERT INTO ventas
            (fecha, usuario_id, subtotal, impuesto, descuento, total, metodo_pago, recibido, cambio, estado, cajero_nombre)
           VALUES (datetime('now','localtime'), ?, ?, ?, 0, ?, 'efectivo', ?, 0, 'devolucion', ?)`,
          [user.id, lineaSub, lineaImp, total, total, nombreCajero]
        );
        const ventaId = lastId();
        run(
          `INSERT INTO detalle_ventas
            (venta_id, producto_id, cantidad, precio_unitario, impuesto, subtotal)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [ventaId, producto.id, cantidad, producto.precio_venta, lineaImp, lineaSub]
        );
        run("UPDATE productos SET stock=? WHERE id=?", [nuevo, producto.id]);
        run(
          `INSERT INTO movimientos_inventario
            (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia, usuario_id, fecha)
           VALUES (?, 'devolucion', ?, ?, ?, ?, ?, datetime('now','localtime'))`,
          [producto.id, cantidad, producto.stock, nuevo, `devolucion #${ventaId}`, user.id]
        );
        return ventaId;
      });
      return `Listo. Devolución #${id} por ${config.negocio.moneda} ${money(total)} en efectivo. ${producto.nombre} quedó en ${money(nuevo)} ${producto.unidad}.`;
    }

    return "No cambié nada.";
  }

  app.get("/reportes", requireAuth, (req, res) => {
    if (!can(req.session.user, "asistente")) {
      return res.status(403).render("error", {
        title: "Sin permiso",
        mensaje: "Tu rol no puede entrar a esta sección."
      });
    }
    res.redirect("/asistente");
  });

  app.get("/asistente", requireAuth, requirePerm("asistente"), (req, res) => {
    const pedido = ["dia", "mes", "ano", "rango"].includes(req.query.periodo) ? req.query.periodo : "dia";
    const filtro = filtroDePeriodo(pedido, { desde: req.query.desde, hasta: req.query.hasta });
    const puedeReportes = can(req.session.user, "reportes");
    const datos = puedeReportes ? cargarReportes({ get, all, round2 }, filtro) : null;
    res.render("asistente", {
      title: "Asistente",
      puedeReportes,
      periodo: filtro.periodo,
      etiqueta: filtro.etiqueta,
      desde: filtro.desde || "",
      hasta: filtro.hasta || "",
      errorRango: filtro.error || null,
      resumen: datos ? datos.resumen : { neto: 0, ventas: 0, tickets: 0, devoluciones: 0, nDevoluciones: 0 },
      margen: datos ? datos.margen : 0,
      porCajero: datos ? datos.porCajero : [],
      masVendidos: datos ? datos.masVendidos : [],
      semana: datos ? datos.semana : { neto: 0, tickets: 0 },
      stockBajo: datos ? datos.stockBajo : [],
      sinMovimiento: datos ? datos.sinMovimiento : [],
      sinMovimientoN: datos ? datos.sinMovimientoN : 0,
      mensajes: Array.isArray(req.session.chat) ? req.session.chat : []
    });
  });

  app.post("/asistente", requireAuth, requirePerm("asistente"), (req, res) => {
    const texto = String(req.body.texto || "").trim().slice(0, 240);
    const user = req.session.user;
    const turno = turnoAbierto(user.id);
    const resultado = interpretar({
      texto,
      pendiente: req.session.asistentePendiente || null,
      puedeAjustar: can(user, "inventarioAjuste"),
      puedeReportes: can(user, "reportes"),
      puedeDevolver: can(user, "devoluciones"),
      turnoAbierto: Boolean(turno && String(turno.nombre_cajero || "").trim()),
      get,
      all,
      money,
      moneda: config.negocio.moneda
    });
    const respuestas = resultado.respuestas.slice();
    if (resultado.aplicar) {
      try {
        respuestas.push(aplicarAsistente(user, resultado.aplicar));
      } catch (error) {
        respuestas.push("No pude aplicar el cambio. El stock quedó como estaba.");
      }
    }
    if (texto) guardarChat(req.session, "tu", texto);
    for (const linea of respuestas) guardarChat(req.session, "asistente", linea);
    req.session.asistentePendiente = resultado.pendiente || null;
    res.redirect(volverAsistente(req.body));
  });

  app.get("/usuarios", requireAuth, requirePerm("usuarios"), (req, res) => {
    const verSuper = isSuperuser(req.session.user);
    const usuarios = all(
      `SELECT u.id, u.nombre, u.usuario, u.activo, r.nombre AS rol, r.clave AS rol_clave
       FROM usuarios u JOIN roles r ON r.id = u.rol_id
       ${verSuper ? "" : "WHERE r.clave <> 'superusuario'"}
       ORDER BY u.usuario`
    );
    const roles = all("SELECT * FROM roles ORDER BY id").filter((r) => r.clave !== "superusuario");
    res.render("usuarios", { title: "Usuarios", usuarios, roles });
  });

  app.post("/usuarios", requireAuth, requirePerm("usuarios"), (req, res) => {
    const usuario = String(req.body.usuario || "").trim();
    const password = String(req.body.password || "");
    const rolId = Number(req.body.rol_id);
    const rol = get("SELECT * FROM roles WHERE id = ?", [rolId]);
    if (!usuario || password.length < 8 || !rol) {
      flash(req, "error", "Completa usuario, rol y contraseña (mínimo 8 caracteres).");
      return res.redirect("/usuarios");
    }
    if (rol.clave === "superusuario") {
      flash(req, "error", "Ese rol no se asigna desde aquí.");
      return res.redirect("/usuarios");
    }
    try {
      run(
        "INSERT INTO usuarios (nombre, usuario, password_hash, rol_id, activo) VALUES (?, ?, ?, ?, 1)",
        [usuario, usuario, bcrypt.hashSync(password, 10), rolId]
      );
      persist();
      flash(req, "ok", "Usuario creado.");
    } catch (error) {
      flash(req, "error", "Ese usuario ya existe.");
    }
    res.redirect("/usuarios");
  });


if (require.main === module) {
  ensureDb().then(() => {
    app.listen(config.port, () => {
      console.log(`MercadoOS listo en http://localhost:${config.port}`);
    });
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = app;
