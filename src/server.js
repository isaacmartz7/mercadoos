const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const config = require("./config");
const { init, all, get, run, lastId, persist, transaction } = require("./db");
const { seedIfEmpty } = require("./seed");

const PERMS = {
  caja: ["admin", "cajero", "gerente"],
  productos: ["admin", "bodeguero", "gerente"],
  inventario: ["admin", "bodeguero", "gerente"],
  inventarioAjuste: ["admin", "bodeguero"],
  ventas: ["admin", "cajero", "gerente"],
  reportes: ["admin", "gerente"],
  usuarios: ["admin"],
  anular: ["admin"]
};

function can(user, perm) {
  return Boolean(user && PERMS[perm] && PERMS[perm].includes(user.rol));
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
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

const app = express();
app.set("trust proxy", 1);
const viewsPath = fs.existsSync(path.join(__dirname, "..", "views"))
  ? path.join(__dirname, "..", "views")
  : path.join(process.cwd(), "views");
app.set("views", viewsPath);
app.set("view engine", "ejs");

const publicPath = fs.existsSync(path.join(__dirname, "..", "public"))
  ? path.join(__dirname, "..", "public")
  : path.join(process.cwd(), "public");
app.use("/static", express.static(publicPath));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }
  })
);

let dbInitPromise = null;
function ensureDb() {
  if (!dbInitPromise) {
    dbInitPromise = init().then((database) => {
      seedIfEmpty(database);
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
          <pre>${err.stack || err.message || err}</pre>
        </div>
      `);
    });
});

  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.config = config;
    res.locals.can = (perm) => can(req.session.user, perm);
    res.locals.flash = req.session.flash || null;
    res.locals.money = money;
    const p = req.path;
    res.locals.nav =
      p === "/" ? "inicio" :
      p.startsWith("/caja") ? "caja" :
      p.startsWith("/productos") ? "productos" :
      p.startsWith("/inventario") ? "inventario" :
      p.startsWith("/ventas") ? "ventas" :
      p.startsWith("/reportes") ? "reportes" :
      p.startsWith("/usuarios") ? "usuarios" : "";
    delete req.session.flash;
    next();
  });

  function flash(req, tipo, texto) {
    req.session.flash = { tipo, texto };
  }

  app.get("/presentacion", (req, res) => {
    const docsPath = fs.existsSync(path.join(__dirname, "..", "docs"))
      ? path.join(__dirname, "..", "docs")
      : path.join(process.cwd(), "docs");
    res.sendFile(path.join(docsPath, "presentacion.html"));
  });

  app.get("/login", (req, res) => {
    if (req.session.user) return res.redirect("/");
    res.render("login", { title: "Iniciar sesión", error: null });
  });

  app.post("/login", (req, res) => {
    const usuario = String(req.body.usuario || "").trim();
    const password = String(req.body.password || "");
    const row = get(
      `SELECT u.*, r.clave AS rol, r.nombre AS rol_nombre
       FROM usuarios u JOIN roles r ON r.id = u.rol_id
       WHERE u.usuario = ? AND u.activo = 1`,
      [usuario]
    );
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).render("login", {
        title: "Iniciar sesión",
        error: "Usuario o contraseña incorrectos."
      });
    }
    req.session.user = {
      id: row.id,
      nombre: row.nombre,
      usuario: row.usuario,
      rol: row.rol,
      rolNombre: row.rol_nombre
    };
    res.redirect("/");
  });

  app.post("/logout", requireAuth, (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });
  app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  app.get("/", requireAuth, (req, res) => {
    const ventasHoy = get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total
       FROM ventas WHERE date(fecha)=date('now','localtime') AND estado='completada'`
    );
    const stockBajo = all(
      `SELECT p.*, c.nombre AS categoria
       FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.activo=1 AND p.stock <= p.stock_minimo
       ORDER BY p.stock ASC LIMIT 8`
    );
    const top = all(
      `SELECT p.nombre, SUM(d.cantidad) AS cantidad, SUM(d.subtotal) AS total
       FROM detalle_ventas d
       JOIN ventas v ON v.id = d.venta_id
       JOIN productos p ON p.id = d.producto_id
       WHERE v.estado='completada' AND date(v.fecha)=date('now','localtime')
       GROUP BY p.id ORDER BY cantidad DESC LIMIT 5`
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

  app.get("/productos", requireAuth, requirePerm("productos"), (req, res) => {
    const q = String(req.query.q || "").trim();
    const params = [];
    let where = "WHERE 1=1";
    if (q) {
      where += " AND (p.nombre LIKE ? OR p.codigo_barras LIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }
    const productos = all(
      `SELECT p.*, c.nombre AS categoria
       FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
       ${where} ORDER BY p.nombre`,
      params
    );
    res.render("productos", { title: "Productos", productos, q });
  });

  app.get("/productos/nuevo", requireAuth, requirePerm("productos"), (req, res) => {
    res.render("producto-form", {
      title: "Nuevo producto",
      producto: null,
      categorias: all("SELECT * FROM categorias ORDER BY nombre")
    });
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
      res.redirect("/productos");
    } catch (error) {
      flash(req, "error", "No se pudo crear. Revisa código de barras duplicado y datos.");
      res.redirect("/productos/nuevo");
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
    if (!actual) return res.redirect("/productos");
    try {
      const d = productoFromBody(req.body, actual.stock);
      run(
        `UPDATE productos SET codigo_barras=?, nombre=?, categoria_id=?, unidad=?,
          precio_venta=?, costo=?, impuesto=?, stock_minimo=? WHERE id=?`,
        [d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[8], actual.id]
      );
      persist();
      flash(req, "ok", "Producto actualizado.");
      res.redirect("/productos");
    } catch (error) {
      flash(req, "error", "No se pudo actualizar el producto.");
      res.redirect(`/productos/${actual.id}/editar`);
    }
  });

  app.get("/inventario", requireAuth, requirePerm("inventario"), (req, res) => {
    const productos = all(
      `SELECT p.*, c.nombre AS categoria
       FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.activo=1 ORDER BY p.nombre`
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
      puedeAjustar: can(req.session.user, "inventarioAjuste")
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
    res.render("caja", { title: "Caja" });
  });

  app.get("/api/productos", requireAuth, requirePerm("caja"), (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);
    const rows = all(
      `SELECT p.id, p.codigo_barras, p.nombre, p.unidad, p.precio_venta, p.impuesto, p.stock
       FROM productos p
       WHERE p.activo=1 AND (p.codigo_barras = ? OR p.nombre LIKE ? OR p.codigo_barras LIKE ?)
       ORDER BY CASE WHEN p.codigo_barras = ? THEN 0 ELSE 1 END, p.nombre
       LIMIT 20`,
      [q, `%${q}%`, `%${q}%`, q]
    );
    res.json(rows);
  });

  app.post("/api/ventas", requireAuth, requirePerm("caja"), (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const metodo = req.body.metodo_pago === "tarjeta" ? "tarjeta" : "efectivo";
    const descuento = Math.max(0, Number(req.body.descuento) || 0);
    const recibido = Number(req.body.recibido);
    if (!items.length) return res.status(400).json({ error: "La venta no tiene productos." });

    try {
      const ventaId = transaction(() => {
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
            (fecha, usuario_id, subtotal, impuesto, descuento, total, metodo_pago, recibido, cambio, estado)
           VALUES (datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, 'completada')`,
          [req.session.user.id, subtotal, impuesto, descuento, total, metodo, recibidoGuardar, cambio]
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
        return id;
      });
      res.json({ ok: true, ventaId });
    } catch (error) {
      res.status(400).json({ error: error.message || "No se pudo completar la venta." });
    }
  });

  app.get("/ventas", requireAuth, requirePerm("ventas"), (req, res) => {
    const esCajero = req.session.user.rol === "cajero";
    const ventas = all(
      `SELECT v.*, u.nombre AS cajero
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
       ${esCajero ? "WHERE v.usuario_id=?" : ""}
       ORDER BY v.id DESC LIMIT 80`,
      esCajero ? [req.session.user.id] : []
    );
    res.render("ventas", { title: "Ventas", ventas });
  });

  app.get("/ventas/:id", requireAuth, requirePerm("ventas"), (req, res) => {
    const venta = get(
      `SELECT v.*, u.nombre AS cajero
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
    res.render("venta-detalle", { title: `Venta #${venta.id}`, venta, detalle });
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

  app.get("/reportes", requireAuth, requirePerm("reportes"), (req, res) => {
    const hoy = get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total
       FROM ventas WHERE estado='completada' AND date(fecha)=date('now','localtime')`
    );
    const semana = get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total
       FROM ventas WHERE estado='completada' AND date(fecha)>=date('now','localtime','-6 day')`
    );
    const porCajero = all(
      `SELECT u.nombre, COUNT(*) AS n, SUM(v.total) AS total
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.estado='completada' AND date(v.fecha)=date('now','localtime')
       GROUP BY u.id ORDER BY total DESC`
    );
    const masVendidos = all(
      `SELECT p.nombre, SUM(d.cantidad) AS cantidad, SUM(d.subtotal) AS total
       FROM detalle_ventas d
       JOIN ventas v ON v.id = d.venta_id
       JOIN productos p ON p.id = d.producto_id
       WHERE v.estado='completada' AND date(v.fecha)>=date('now','localtime','-6 day')
       GROUP BY p.id ORDER BY cantidad DESC LIMIT 10`
    );
    const stockBajo = all(
      `SELECT p.*, c.nombre AS categoria
       FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.activo=1 AND p.stock <= p.stock_minimo ORDER BY p.stock ASC`
    );
    res.render("reportes", {
      title: "Reportes",
      hoy,
      semana,
      porCajero,
      masVendidos,
      stockBajo
    });
  });

  app.get("/usuarios", requireAuth, requirePerm("usuarios"), (req, res) => {
    const usuarios = all(
      `SELECT u.id, u.nombre, u.usuario, u.activo, r.nombre AS rol
       FROM usuarios u JOIN roles r ON r.id = u.rol_id ORDER BY u.nombre`
    );
    const roles = all("SELECT * FROM roles ORDER BY id");
    res.render("usuarios", { title: "Usuarios", usuarios, roles });
  });

  app.post("/usuarios", requireAuth, requirePerm("usuarios"), (req, res) => {
    const nombre = String(req.body.nombre || "").trim();
    const usuario = String(req.body.usuario || "").trim();
    const password = String(req.body.password || "");
    const rolId = Number(req.body.rol_id);
    if (!nombre || !usuario || password.length < 6 || !rolId) {
      flash(req, "error", "Completa nombre, usuario, rol y contraseña (mínimo 6).");
      return res.redirect("/usuarios");
    }
    try {
      run(
        "INSERT INTO usuarios (nombre, usuario, password_hash, rol_id, activo) VALUES (?, ?, ?, ?, 1)",
        [nombre, usuario, bcrypt.hashSync(password, 10), rolId]
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
